import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { fileKind, type LibraryFile, type LibraryPage, type TreeMeta } from '@gense/protocol'
import assert from 'node:assert/strict'
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { UserSpace, fauxModels } from '../src/index.ts'
import { configFromEnv } from '../src/platform/config.ts'
import { startServer } from '../src/platform/server.ts'
import { Client, login, tempDir } from './host-helpers.ts'
import { diskEnv } from './fixtures.ts'

test('D4: library pages all live workspaces and projects, filters by file kind/name, and excludes temporary, deleted and foreign roots', async t => {
  const root = await tempDir()
  const host = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: root, SANDBOX: '0', BACKUPS: '0' }), port: 0 })
  const clients: Client[] = []
  t.after(async () => { for (const c of clients) c.close(); await host.close() })
  const a = await host.auth.register('a@example.com', 'a long password'), b = await host.auth.register('b@example.com', 'a long password')
  const first = await Client.connect(host.url, (await login(host.url, 'a long password', a.email)).cookie!), other = await Client.connect(host.url, (await login(host.url, 'a long password', b.email)).cookie!)
  clients.push(first, other)
  await Promise.all(clients.map(c => c.until(() => c.prefs)))
  const space = host.spaces.get(a.id)!, files = join(root, 'users', a.id, 'files')
  const trees: TreeMeta[] = []
  for (let i = 0; i < 34; i++) {
    const tree = await space.createTree(); trees.push(tree)
    await writeFile(join(files, 'sessions', tree.id, `old-${i}.md`), 'one workspace')
  }
  const tree = trees[0]!, workspace = join(files, 'sessions', tree.id)
  for (let i = 0; i < 215; i++) await writeFile(join(workspace, `row-${String(i).padStart(3, '0')}.csv`), 'a,b\n1,2')
  await writeFile(join(workspace, 'Report.DOCX'), 'report')
  await writeFile(join(workspace, 'script.ts'), 'const a = 1')
  await writeFile(join(workspace, 'photo.png'), new Uint8Array([1, 2, 3]))
  await writeFile(join(workspace, 'opaque.bin'), new Uint8Array([0, 1]))
  for (const dir of ['.hidden', 'node_modules', '__pycache__']) { await mkdir(join(workspace, dir)); await writeFile(join(workspace, dir, 'not-in-library.txt'), dir) }
  await writeFile(join(workspace, '.env'), 'not in library')
  await symlink(join(root, 'outside'), join(workspace, 'link.txt'))
  const project = await space.projects.create({ name: 'Library project' })
  await writeFile(join(files, 'projects', project.id, 'Project.PDF'), 'project source')
  const temp = await space.createTree(undefined, ctx, true), deleted = await space.createTree()
  await writeFile(join(files, 'sessions', temp.id, 'live-temporary-sentinel.txt'), 'private temp')
  await space.deleteTree(deleted.id)
  await mkdir(join(files, 'sessions', deleted.id)); await writeFile(join(files, 'sessions', deleted.id, 'deleted-sentinel.txt'), 'orphaned workspace')
  for (const dir of ['skills', 'uploads', 'exports']) { await mkdir(join(files, dir), { recursive: true }); await writeFile(join(files, dir, 'excluded-root-sentinel.md'), dir) }
  const own = await other.request<TreeMeta>({ t: 'tree.create' })
  const foreign = join(root, 'users', b.id, 'files', 'sessions', own.id, 'foreign.md')
  await writeFile(foreign, 'foreign content'); await symlink(foreign, join(workspace, 'foreign-link.md'))
  const ask = (patch = {}) => first.request<LibraryPage>({ t: 'library.list', ...patch })
  const initial = await ask()
  assert.equal(initial.items.length, 50); assert.ok(initial.next)
  assert.equal((await ask({ limit: 9999 })).items.length, 200)
  const all: LibraryFile[] = []; let cursor: string | undefined
  do { const page = await ask({ limit: 17, ...(cursor && { cursor }) }); all.push(...page.items); cursor = page.next } while (cursor)
  assert.equal(all.length, 254); assert.equal(new Set(all.map(f => f.path)).size, all.length)
  assert.equal(new Set(all.flatMap(f => f.treeId ? [f.treeId] : [])).size, 34, 'the library is not limited to recent 30 chats')
  assert.ok(all.every((f, i) => !i || all[i - 1]!.mtime >= f.mtime))
  assert.ok(all.every(f => f.kind === fileKind(f.path)))
  assert.ok(!JSON.stringify(all).match(/temporary-sentinel|deleted-sentinel|excluded-root-sentinel|foreign|not-in-library|\.env/))
  const report = await ask({ query: 'rEpOrT', kind: 'doc' })
  assert.deepEqual(report.items.map(f => f.path), [`/data/sessions/${tree.id}/Report.DOCX`])
  assert.equal((await ask({ kind: 'data', limit: 200 })).items.length, 200)
  assert.equal((await ask({ kind: 'image' })).items.length, 1); assert.equal((await ask({ kind: 'code' })).items.length, 1); assert.equal((await ask({ kind: 'other' })).items.length, 1)
  assert.equal((await ask({ query: 'Project' })).items[0]!.projectId, project.id)
  assert.ok((await other.request<LibraryPage>({ t: 'library.list' })).items.every(f => f.treeId === own.id))
  await assert.rejects(ask({ cursor: 'bad cursor' }), /游标无效/)
  await first.request({ t: 'tree.delete', treeId: tree.id })
  assert.ok(!(await ask({ limit: 200 })).items.some(f => f.treeId === tree.id), 'a cached workspace cannot keep a deleted tree visible')
})

test('D4: repeated pages reuse directory/file metadata; nested adds invalidate immediately and in-place edits refresh within two seconds', async t => {
  const files = await tempDir(), makeEnv = await diskEnv(files), counts = { list: 0, file: 0 }
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), {
    models: fauxModels(), env: async cwd => {
      const env = await makeEnv(cwd)
      return new Proxy(env, { get(target, key) { const fn = Reflect.get(target, key, target); if (typeof fn !== 'function') return fn; return (...args: unknown[]) => { if (key === 'listDir') counts.list++; if (key === 'fileInfo') counts.file++; return fn.apply(target, args) } } })
    },
  })
  t.after(() => space.close())
  const tree = await space.createTree(), folder = join(files, 'sessions', tree.id, 'nested')
  await mkdir(folder); await writeFile(join(folder, 'data.csv'), 'one')
  const first = await space.library.list(), before = { ...counts }
  assert.equal(first.items.length, 1)
  await space.library.list()
  assert.equal(counts.list, before.list, 'unchanged directories avoid repeated readdir')
  assert.equal(counts.file - before.file, 2, 'cache checks only the two directories, not every file')
  await writeFile(join(folder, 'added.md'), 'added')
  await utimes(folder, new Date(), new Date(Date.now() + 1000))
  assert.equal((await space.library.list()).items.length, 2)
  await writeFile(join(folder, 'data.csv'), 'changed in place')
  await new Promise(resolve => setTimeout(resolve, 2100))
  assert.equal((await space.library.list()).items.find(f => f.path.endsWith('/data.csv'))!.size, 16)
})
