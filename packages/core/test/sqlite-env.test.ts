import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { getOrThrow, type ExecutionEnv, type Result } from '@earendil-works/pi-durable/env'
import { createEnvConformance, type EnvConformanceAssertions } from '@earendil-works/pi-durable/testing'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { SqliteFiles, type SqliteExecutionEnv } from '../src/fs/sqlite-env.ts'

const ctx = BACKGROUND_CONTEXT
const code = (result: Result<unknown, { code: string }>) => (result.ok ? undefined : result.error.code)

function partialDeepEqual(actual: unknown, expected: unknown) {
  if (expected === null || typeof expected !== 'object') return assert.deepEqual(actual, expected)
  assert.ok(actual !== null && typeof actual === 'object', `expected an object, got ${String(actual)}`)
  for (const [key, value] of Object.entries(expected)) partialDeepEqual((actual as Record<string, unknown>)[key], value)
}

const assertions: EnvConformanceAssertions = {
  ok: (value, message) => assert.ok(value, message),
  strictEqual: (actual, expected) => assert.equal(actual, expected),
  deepEqual: (actual, expected) => assert.deepEqual(actual, expected),
  partialDeepEqual,
  greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
  rejects: (operation, messageIncludes) => assert.rejects(operation, (error: Error) => error.message.includes(messageIncludes)),
}

let dir: string
let db: SqliteDatabase
let files: SqliteFiles
let fresh = 0

// A file-backed database, so blobs and transactions go through real SQLite storage.
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sqlite-env-'))
  db = await openNodeSqliteDatabase(join(dir, 'fs.db'))
  files = await SqliteFiles.open(db, { id: 'sqlite:test' })
})
after(async () => {
  await db.close()
  await rm(dir, { recursive: true, force: true })
})

async function freshEnv(): Promise<SqliteExecutionEnv> {
  const cwd = `/work/case-${++fresh}`
  getOrThrow(await files.env({ cwd: '/' }).createDir(cwd, undefined, ctx))
  return files.env({ cwd })
}

describe('pi-durable env conformance', () => {
  // No shell (exec cases) and no watch here; without a shell there are no symlinks either.
  const cases = createEnvConformance({ assertions, withEnv: async (use) => use(await freshEnv()), symlinks: false })
  const unsupported = (name: string) => name.startsWith('watch ') || /\bexec\b/.test(name)
  for (const c of cases) test(c.name, { skip: unsupported(c.name) && 'needs a shell or watch' }, () => c.run())
})

describe('SqliteExecutionEnv', () => {
  let env: ExecutionEnv
  before(async () => {
    env = await freshEnv()
  })

  test('opening twice keeps the files', async () => {
    getOrThrow(await env.writeFile('keep.txt', 'kept', ctx))
    const again = await SqliteFiles.open(db, { id: 'sqlite:test' })
    assert.equal(getOrThrow(await again.env({ cwd: env.cwd }).readTextFile('keep.txt', ctx)), 'kept')
  })

  test('paths resolve against cwd and never above /', async () => {
    assert.equal(getOrThrow(await env.absolutePath('a/./b/../c', ctx)), `${env.cwd}/a/c`)
    assert.equal(getOrThrow(await env.absolutePath('/../../x//y/', ctx)), '/x/y')
    assert.equal(getOrThrow(await env.joinPath(['..', 'a', '../b'], ctx)), '../b')
    assert.equal(getOrThrow(await env.joinPath(['/a', '..', '..'], ctx)), '/')
    assert.equal(code(await env.readTextFile('bad\0name', ctx)), 'invalid')
  })

  test('write, read and append create parents and keep bytes', async () => {
    getOrThrow(await env.writeFile('deep/er/file.txt', 'héllo', ctx))
    assert.equal(getOrThrow(await env.fileInfo('deep/er', ctx)).kind, 'directory')
    getOrThrow(await env.appendFile('deep/er/file.txt', ' world', ctx))
    assert.equal(getOrThrow(await env.readTextFile('deep/er/file.txt', ctx)), 'héllo world')
    getOrThrow(await env.appendFile('new/appended.txt', Uint8Array.of(0, 255), ctx))
    assert.deepEqual(getOrThrow(await env.readBinaryFile('new/appended.txt', ctx)), Uint8Array.of(0, 255))
    getOrThrow(await env.writeFile('empty.bin', new Uint8Array(0), ctx))
    assert.equal(getOrThrow(await env.readBinaryFile('empty.bin', ctx)).length, 0)
    assert.equal(getOrThrow(await env.fileInfo('deep/er/file.txt', ctx)).size, 12)
  })

  test('a file in the way fails writes and lookups with not_directory', async () => {
    getOrThrow(await env.writeFile('blocker', 'x', ctx))
    assert.equal(code(await env.writeFile('blocker/child.txt', 'y', ctx)), 'not_directory')
    assert.equal(code(await env.writeFile('blocker/a/b.txt', 'y', ctx)), 'not_directory')
    assert.equal(code(await env.readTextFile('blocker/child.txt', ctx)), 'not_directory')
    assert.equal(code(await env.readTextFile('nothing/here.txt', ctx)), 'not_found')
    assert.equal(code(await env.writeFile('deep', 'x', ctx)), 'is_directory')
    assert.equal(code(await env.readBinaryFile('deep', ctx)), 'is_directory')
    assert.equal(code(await env.listDir('blocker', ctx)), 'not_directory')
  })

  test('files larger than one chunk survive append, rename, replace and remove', async () => {
    const big = Uint8Array.from({ length: 2_500_000 }, (_, i) => i % 251)
    getOrThrow(await env.writeFile('big/a.bin', big.subarray(0, 1_500_000), ctx))
    getOrThrow(await env.appendFile('big/a.bin', big.subarray(1_500_000), ctx))
    getOrThrow(await env.renameFile('big', 'big2', ctx))
    assert.deepEqual(getOrThrow(await env.readBinaryFile('big2/a.bin', ctx)), big)
    getOrThrow(await env.writeFile('small.bin', 'x', ctx))
    getOrThrow(await env.renameFile('small.bin', 'big2/a.bin', ctx))
    assert.equal(getOrThrow(await env.readTextFile('big2/a.bin', ctx)), 'x')
    getOrThrow(await env.remove('big2', { recursive: true }, ctx))
    assert.equal((await db.get<{ n: number }>('SELECT count(*) AS n FROM fs_chunks WHERE file NOT IN (SELECT rowid FROM fs_entries)'))!.n, 0)
  })

  test('renaming a directory moves its subtree', async () => {
    getOrThrow(await env.writeFile('src/a.txt', 'a', ctx))
    getOrThrow(await env.writeFile('src/sub/b.txt', 'b', ctx))
    getOrThrow(await env.writeFile('src-sibling/c.txt', 'c', ctx))
    getOrThrow(await env.createDir('moved', undefined, ctx))
    getOrThrow(await env.renameFile('src', 'moved/dst', ctx))
    assert.equal(getOrThrow(await env.exists('src', ctx)), false)
    assert.equal(getOrThrow(await env.readTextFile('moved/dst/sub/b.txt', ctx)), 'b')
    assert.deepEqual(getOrThrow(await env.listDir('moved/dst', ctx)).map((e) => e.name), ['a.txt', 'sub'])
    assert.equal(getOrThrow(await env.readTextFile('src-sibling/c.txt', ctx)), 'c')
    assert.equal(code(await env.renameFile('moved', 'moved/dst/inside', ctx)), 'invalid')
    assert.equal(code(await env.renameFile('moved/dst', 'nowhere/x', ctx)), 'not_found')
    assert.equal(code(await env.renameFile('missing', 'x', ctx)), 'not_found')
  })

  test('rename replaces files and empty directories only', async () => {
    getOrThrow(await env.writeFile('r/one.txt', '1', ctx))
    getOrThrow(await env.writeFile('r/two.txt', '2', ctx))
    getOrThrow(await env.renameFile('r/one.txt', 'r/two.txt', ctx))
    assert.equal(getOrThrow(await env.readTextFile('r/two.txt', ctx)), '1')
    getOrThrow(await env.createDir('r/empty', undefined, ctx))
    getOrThrow(await env.writeFile('r/full/x', 'x', ctx))
    assert.equal(code(await env.renameFile('r/two.txt', 'r/empty', ctx)), 'is_directory')
    assert.equal(code(await env.renameFile('r/full', 'r/two.txt', ctx)), 'not_directory')
    getOrThrow(await env.createDir('r/other', undefined, ctx))
    assert.equal(code(await env.renameFile('r/other', 'r/full', ctx)), 'invalid')
    getOrThrow(await env.renameFile('r/full', 'r/empty', ctx))
    assert.equal(getOrThrow(await env.readTextFile('r/empty/x', ctx)), 'x')
  })

  test('remove needs recursive for directories and force for missing paths', async () => {
    getOrThrow(await env.writeFile('rm/a/b/c.txt', 'c', ctx))
    getOrThrow(await env.writeFile('rm-keep.txt', 'k', ctx))
    assert.equal(code(await env.remove('rm', undefined, ctx)), 'is_directory')
    getOrThrow(await env.remove('rm', { recursive: true }, ctx))
    assert.equal(getOrThrow(await env.exists('rm/a/b/c.txt', ctx)), false)
    assert.equal(getOrThrow(await env.exists('rm-keep.txt', ctx)), true)
    assert.equal(code(await env.remove('rm', undefined, ctx)), 'not_found')
    getOrThrow(await env.remove('rm', { force: true }, ctx))
    assert.equal(code(await env.remove('/', { recursive: true }, ctx)), 'invalid')
  })

  test('createDir is recursive by default and refuses existing entries otherwise', async () => {
    getOrThrow(await env.createDir('mk/a/b', undefined, ctx))
    getOrThrow(await env.createDir('mk/a/b', undefined, ctx))
    assert.equal(code(await env.createDir('mk/a/b', { recursive: false }, ctx)), 'invalid')
    assert.equal(code(await env.createDir('mk/x/y', { recursive: false }, ctx)), 'not_found')
    getOrThrow(await env.createDir('mk/x', { recursive: false }, ctx))
  })

  test('the line reader returns lines as decoded text', async () => {
    getOrThrow(await env.writeFile('lines.txt', '\uFEFFone\r\ntwo\n\nlast', ctx))
    assert.deepEqual(getOrThrow(await env.readTextLines('lines.txt', undefined, ctx)), ['one\r', 'two', '', 'last'])
    assert.deepEqual(getOrThrow(await env.readTextLines('lines.txt', { maxLines: 2 }, ctx)), ['one\r', 'two'])
    const reader = getOrThrow(await env.openTextLineReader('lines.txt', ctx))
    assert.deepEqual(getOrThrow(await reader.readLine(ctx)), { text: 'one\r', terminated: true })
    await reader.close(ctx)
    assert.equal(code(await reader.readLine(ctx)), 'invalid')
    getOrThrow(await env.writeFile('ends.txt', 'a\n', ctx))
    const ends = getOrThrow(await env.openTextLineReader('ends.txt', ctx))
    assert.deepEqual(getOrThrow(await ends.readLine(ctx)), { text: 'a', terminated: true })
    assert.equal(getOrThrow(await ends.readLine(ctx)), undefined)
    // readTextFile keeps a byte-order mark like Node's readFile(path, 'utf8').
    assert.equal(getOrThrow(await env.readTextFile('lines.txt', ctx)).charCodeAt(0), 0xfeff)
  })

  test('truncate shrinks and zero-extends', async () => {
    getOrThrow(await env.writeFile('t.bin', 'abcdef', ctx))
    getOrThrow(await env.truncateFile('t.bin', 3, ctx))
    assert.equal(getOrThrow(await env.readTextFile('t.bin', ctx)), 'abc')
    getOrThrow(await env.truncateFile('t.bin', 5, ctx))
    assert.deepEqual(getOrThrow(await env.readBinaryFile('t.bin', ctx)), Uint8Array.of(97, 98, 99, 0, 0))
    assert.equal(code(await env.truncateFile('t.bin', -1, ctx)), 'invalid')
    assert.equal(code(await env.truncateFile('nope.bin', 0, ctx)), 'not_found')
    getOrThrow(await env.flushFile('t.bin', ctx))
    assert.equal(code(await env.flushFile('deep', ctx)), 'is_directory')
  })

  test('temp files, canonical paths, exec and watch', async () => {
    const tmp = getOrThrow(await env.createTempFile({ prefix: 'p-', suffix: '.txt' }, ctx))
    assert.match(tmp, /^\/tmp\/tmp-\w{6}\/p-.*\.txt$/)
    assert.equal(getOrThrow(await env.readTextFile(tmp, ctx)), '')
    const tmpDir = getOrThrow(await env.createTempDir('x-', ctx))
    assert.match(tmpDir, /^\/tmp\/x-\w{6}$/)
    assert.equal(getOrThrow(await env.canonicalPath('deep/./er/../er', ctx)), `${env.cwd}/deep/er`)
    assert.equal(code(await env.canonicalPath('missing', ctx)), 'not_found')
    assert.equal(code(await env.exec('ls', undefined, ctx)), 'shell_unavailable')
    assert.equal(code(await env.watch([{ path: '.' }], () => {}, ctx)), 'not_supported')
  })

  test('an aborted context fails without changing anything', async () => {
    const controller = new AbortController()
    controller.abort()
    const abortedCtx = withAbortSignal(controller.signal, ctx)
    assert.equal(code(await env.writeFile('aborted.txt', 'x', abortedCtx)), 'aborted')
    assert.equal(code(await env.readTextFile('deep/er/file.txt', abortedCtx)), 'aborted')
    assert.equal(getOrThrow(await env.exists('aborted.txt', ctx)), false)
  })

  test('envs over the same files share them whatever their cwd', async () => {
    const other = files.env({ cwd: '/' })
    assert.equal(other.id, env.id)
    assert.equal(getOrThrow(await other.readTextFile(`${env.cwd}/deep/er/file.txt`, ctx)), 'héllo world')
  })

  test('paths with characters outside the BMP survive a subtree rename', async () => {
    getOrThrow(await env.writeFile('😀dir/😀.txt', 'emoji', ctx))
    getOrThrow(await env.renameFile('😀dir', 'plain', ctx))
    assert.equal(getOrThrow(await env.readTextFile('plain/😀.txt', ctx)), 'emoji')
    assert.deepEqual(getOrThrow(await env.listDir('plain', ctx)).map((e) => e.name), ['😀.txt'])
  })
})
