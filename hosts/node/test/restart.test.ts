// R32: a run cut off by a crash finishes after the host restarts, without asking twice.
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { Auth, LONG_REPLY, type TreeMeta } from '@gense/core'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client, login, stopReason, tempDir, textOf } from './helpers.ts'

const main = join(import.meta.dirname, '../src/main.ts')

function host(dataDir: string) {
  const child = spawn(process.execPath, [main], {
    env: { PATH: process.env.PATH, GENSE_FAUX: '1', DATA_DIR: dataDir, PORT: '0', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const url = new Promise<string>((resolve, reject) => {
    child.stdout!.setEncoding('utf8').on('data', (s: string) => {
      const m = /listening on (\S+)/.exec(s)
      if (m) resolve(m[1]!)
    })
    child.once('exit', (code) => reject(new Error(`host exited early: ${code}`)))
  })
  return { child, url }
}

const exited = (child: ChildProcess) => new Promise((r) => child.once('exit', r))

test('R32: an answer interrupted by SIGKILL completes after restart', { timeout: 60_000 }, async () => {
  const dataDir = await tempDir()
  const auth = await Auth.open(await openNodeSqliteDatabase(join(dataDir, 'app.sqlite')))
  await auth.createUser('a@example.com', 'correct horse')
  await auth.close()

  const first = host(dataDir)
  let url = await first.url
  let { cookie } = await login(url, 'a@example.com', 'correct horse')
  let client = await Client.connect(url, cookie)
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  await client.request({ t: 'send', treeId: tree.id, text: '[长回答] 讲讲', requestId: 'r1' })

  // Wait until part of the answer has streamed and been committed, then crash.
  await client.until(() => {
    const live = client.views.get(tree.id)?.docs['pi.live'] as { generation?: { message?: { content?: { text?: string }[] } } } | undefined
    return (live?.generation?.message?.content?.[0]?.text?.length ?? 0) > 50
  }, 20_000, 'partial answer')
  assert.ok(!client.views.get(tree.id)!.entries.some((e) => e.kind === 'pi.assistant'), 'answer still streaming at the crash')
  client.close()
  first.child.kill('SIGKILL')
  await exited(first.child)

  const second = host(dataDir)
  try {
    url = await second.url
    ;({ cookie } = await login(url, 'a@example.com', 'correct horse'))
    client = await Client.connect(url, cookie)
    await client.request({ t: 'watch', treeId: tree.id })
    // pi-durable keeps the cut-off partial as an `aborted` answer and asks the model again in the same run.
    const answer = await client.until(
      () => client.views.get(tree.id)?.entries.find((e) => e.kind === 'pi.assistant' && stopReason(e) === 'stop'),
      30_000,
      'answer after restart',
    )
    assert.equal(textOf(answer), LONG_REPLY)
    const entries = client.views.get(tree.id)!.entries
    assert.equal(entries.filter((e) => e.kind === 'pi.user').length, 1, 'the question is asked once')
    assert.deepEqual(entries.filter((e) => e.kind === 'pi.assistant').map(stopReason), ['aborted', 'stop'])
    client.close()
  } finally {
    second.child.kill('SIGTERM')
    await exited(second.child)
  }
})
