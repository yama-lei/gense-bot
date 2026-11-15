// Roadmap-7 D1–D6: real user databases, files, model streams and host HTTP/WebSocket.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { FeedbackSummary, TreeMeta } from '@gense/protocol'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { startServer } from '../src/platform/server.ts'
import { configFromEnv } from '../src/platform/config.ts'
import { Client, login, tempDir } from './host-helpers.ts'

const options = (dataDir: string) => ({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: dataDir, SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'r7-d-key' }), port: 0 })
async function account(host: Awaited<ReturnType<typeof startServer>>, email: string) {
  const user = await host.auth.register(email, 'correct horse battery')
  await host.spaces.sync(user.id)
  const cookie = (await login(host.url, 'correct horse battery', email)).cookie!
  const client = await Client.connect(host.url, cookie)
  await client.until(() => client.prefs)
  return { user, cookie, client }
}

test('D1: feedback syncs, changes and clears; the server derives models and keeps admin statistics private', async t => {
  const root = await tempDir()
  let host = await startServer(options(root))
  const clients: Client[] = []
  t.after(async () => { for (const client of clients) client.close(); await host.close() })
  const a = await account(host, 'a@example.com'), b = await account(host, 'b@example.com')
  const second = await Client.connect(host.url, a.cookie)
  clients.push(a.client, b.client, second)
  const tree = await a.client.request<TreeMeta>({ t: 'tree.create' })
  await a.client.request({ t: 'watch', treeId: tree.id })
  assert.deepEqual(a.client.feedback.get(tree.id), [], 'watch sends an empty feedback list')
  await a.client.request({ t: 'send', treeId: tree.id, text: 'Explain feedback', requestId: 'feedback' })
  await host.spaces.get(a.user.id)!.harness.waitForIdle(ctx)
  await a.client.until(() => a.client.views.get(tree.id)?.entries.some(e => e.kind === 'pi.assistant'))
  const turnId = String(a.client.views.get(tree.id)!.entries.find(e => e.kind === 'pi.user')!.id)
  const stats = async (cookie = a.cookie, query = '') => {
    const reply = await fetch(host.url + '/api/admin/feedback' + query, { headers: { cookie } })
    assert.equal(reply.status, 200)
    return await reply.json() as FeedbackSummary[]
  }
  await assert.rejects(b.client.request({ t: 'feedback.set', treeId: tree.id, turnId, value: 'up' }), /会话不存在/)
  await a.client.request({ t: 'feedback.set', treeId: tree.id, turnId, value: 'down', reasons: ['inaccurate', 'too-long', 'inaccurate'], comment: '私'.repeat(600) })
  await second.until(() => second.feedback.get(tree.id)?.[0]?.value === 'down')
  const feedback = second.feedback.get(tree.id)![0]!
  assert.deepEqual(feedback.reasons, ['inaccurate', 'too-long']); assert.equal(feedback.comment?.length, 500)
  assert.equal(feedback.model, 'faux:faux-1')
  assert.equal(b.client.feedback.has(tree.id), false)
  let summary = await stats()
  assert.deepEqual(summary.map(s => [s.model, s.up, s.down, s.reasons]), [['faux:faux-1', 0, 1, { inaccurate: 1, 'too-long': 1 }]])
  assert.equal((await fetch(host.url + '/api/admin/feedback', { headers: { cookie: b.cookie } })).status, 403)
  assert.equal((await fetch(host.url + '/api/admin/feedback')).status, 401)
  assert.equal((await fetch(host.url + '/api/admin/feedback?from=bad', { headers: { cookie: a.cookie } })).status, 400)
  assert.equal((await fetch(host.url + '/api/admin/feedback?from=2026-11-15&to=2026-11-14', { headers: { cookie: a.cookie } })).status, 400)
  assert.deepEqual(await stats(a.cookie, '?from=2099-01-01&to=2099-01-02'), [])
  await a.client.request({ t: 'feedback.set', treeId: tree.id, turnId, value: 'up', reasons: ['inaccurate'], comment: 'discard this' })
  await second.until(() => second.feedback.get(tree.id)?.[0]?.value === 'up')
  assert.equal(second.feedback.get(tree.id)![0]!.reasons, undefined)
  assert.equal(second.feedback.get(tree.id)![0]!.comment, undefined)
  summary = await stats(); assert.deepEqual([summary[0]!.up, summary[0]!.down, summary[0]!.reasons], [1, 0, {}])
  // Another user has their own row; aggregation is by model/day, with no comments or conversation text.
  const own = await b.client.request<TreeMeta>({ t: 'tree.create' })
  await b.client.request({ t: 'feedback.set', treeId: own.id, turnId: 'unknown', value: 'down', reasons: ['other'] })
  assert.equal((await stats()).find(s => s.model === '')?.down, 1)
  const global = await openNodeSqliteDatabase(join(root, 'app.sqlite'))
  try {
    const rows = await global.all('SELECT * FROM feedback_stats')
    assert.equal(rows.length, 2); assert.ok(!JSON.stringify(rows).includes('私')); assert.ok(!JSON.stringify(rows).includes('Explain feedback'))
  } finally { await global.close() }
  for (const client of clients.splice(0)) client.close()
  await host.close(); host = await startServer(options(root))
  const reopened = await Client.connect(host.url, a.cookie); clients.push(reopened)
  await reopened.request({ t: 'watch', treeId: tree.id })
  assert.equal(reopened.feedback.get(tree.id)![0]!.value, 'up')
  await reopened.request({ t: 'feedback.set', treeId: tree.id, turnId, value: null })
  assert.deepEqual(reopened.feedback.get(tree.id), [])
  assert.ok(!(await stats()).some(s => s.model === 'faux:faux-1'))
  await reopened.request({ t: 'feedback.set', treeId: tree.id, turnId, value: 'up' })
  await reopened.request({ t: 'tree.delete', treeId: tree.id })
  assert.equal((await stats()).find(s => s.model === 'faux:faux-1')!.up, 1, 'tree deletion preserves aggregate statistics')
  assert.equal((await host.spaces.get(a.user.id)!.db.all('SELECT * FROM feedback')).length, 0)
})
