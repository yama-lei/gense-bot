// Roadmap-7 D1–D6: real user databases, files, model streams and host HTTP/WebSocket.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { FeedbackSummary, TreeMeta } from '@gense/protocol'
import type { Message, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { startServer } from '../src/platform/server.ts'
import { configFromEnv } from '../src/platform/config.ts'
import { Client, login, tempDir } from './host-helpers.ts'
import { SUGGEST_SYSTEM, suggestInput } from '../src/agent/suggest-prompt.ts'
import { deepseekPlatform, fixture } from './deepseek-platform.ts'
import { feishuPlatform } from './feishu-platform.ts'

const options = (dataDir: string) => ({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: dataDir, SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'r7-d-key' }), port: 0 })
async function until(check: () => boolean | Promise<boolean>, label = 'state', ms = 10_000) {
  const end = Date.now() + ms
  while (!await check()) { if (Date.now() > end) throw new Error(`timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 20)) }
}
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

test('D2: JSON suggestions are metered and replayed only to the owner, including temporary chats; garbage, errors, versions and Feishu are silent', async t => {
  const faux = fauxProvider({ models: [{ id: 'suggest-model', name: 'Suggest model' }], tokensPerSecond: 100_000 })
  const calls: { messages: Message[]; options?: SimpleStreamOptions }[] = []
  const reply = (context: { messages: Message[] }) => {
    faux.appendResponses([reply])
    const last = context.messages.findLast(m => m.role === 'user')!, text = typeof last.content === 'string' ? last.content : last.content.filter(b => b.type === 'text').map(b => b.text).join('')
    const side = context.messages.some(m => m.role === 'system' && m.content === SUGGEST_SYSTEM)
    return fauxAssistantMessage([fauxText(side ? text.includes('garbage') ? 'not JSON' : text.includes('side-error') ? '{"items":["must not show"]}' : '{"items":["  Compare the approaches. ","Check the assumption","Compare the approaches.","Apply it to our data"]}' : 'An answer specific to ' + text)], { ...(side && text.includes('side-error') && { stopReason: 'error' as const, errorMessage: 'side error' }) })
  }
  faux.setResponses([reply])
  const original = faux.provider.streamSimple.bind(faux.provider)
  faux.provider.streamSimple = (model, context, streamOptions) => { calls.push({ messages: structuredClone(context.messages), options: streamOptions }); return original(model, context, streamOptions) }
  const model = faux.getModel(), option = { provider: model.provider, id: model.id, name: model.name }
  const remote = await feishuPlatform()
  const host = await startServer({ ...options(await tempDir()), publicUrl: 'http://localhost:8787', feishu: { domain: remote.origin, streamMs: 20 }, models: () => ({ providers: [faux.provider], options: [option], defaultModel: option }) })
  const clients: Client[] = []
  t.after(async () => { for (const c of clients) c.close(); await host.close(); await remote.close() })
  const a = await account(host, 'a@example.com'), b = await account(host, 'b@example.com'), second = await Client.connect(host.url, a.cookie)
  clients.push(a.client, b.client, second)
  const space = host.spaces.get(a.user.id)!
  assert.equal(a.client.prefs!.suggestions, true)
  for (const temporary of [false, true]) {
    const tree = await a.client.request<TreeMeta>({ t: 'tree.create', temporary })
    await a.client.request({ t: 'watch', treeId: tree.id })
    const question = temporary ? 'Explain the temporary chat answer' : 'Explain the approaches'
    await a.client.request({ t: 'send', treeId: tree.id, text: question, requestId: question })
    const generated = await second.until(() => second.suggestions.get(tree.id), 15_000)
    assert.deepEqual(generated.items, ['Compare the approaches', 'Check the assumption', 'Apply it to our data'])
    const user = a.client.views.get(tree.id)!.entries.find(e => e.kind === 'pi.user')!
    assert.equal(generated.turnId, String(user.id)); assert.equal(b.client.suggestions.has(tree.id), false)
    assert.equal(space.suggestions.get(tree.id)?.items.length, 3)
    await second.request({ t: 'watch', treeId: tree.id })
    assert.deepEqual(second.suggestions.get(tree.id), generated)
    const side = calls.find(c => c.messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes(`<question>\n${question}\n`)))!
    assert.ok(side); assert.equal(side.messages.length, 2)
    assert.equal(side.messages[1]!.content, suggestInput(question, 'An answer specific to ' + question))
    assert.equal(side.options?.maxTokens, 300); assert.equal(side.options?.reasoning, undefined)
    assert.ok(side.options?.signal); assert.equal(side.options?.timeoutMs, 20_000)
    assert.ok(side.messages.every(m => m.role !== 'system' || !m.toolsAdded?.length))
    const history = (await (await space.open((await space.branchRow(tree.id)).branch, ctx)).entries({}, 100, undefined, ctx)).items
    assert.ok(!JSON.stringify(history).includes('Compare the approaches'), 'the side result is absent from durable history')
    const main = a.client.branches.get(tree.id)!.branches.find(branch => branch.role === 'main')!
    const asked = a.client.views.get(tree.id)!.entries.find(e => e.kind === 'pi.user')!
    const before = calls.length
    await a.client.request({ t: 'send', treeId: tree.id, branchId: main.id, replace: asked.id, text: 'Fork only', requestId: 'fork' })
    await space.harness.waitForIdle(ctx)
    assert.equal(calls.length, before + 1, 'versions have no side call')
    assert.equal(space.suggestions.get(tree.id), undefined, 'a new turn clears the previous suggestions')
  }
  for (const text of ['garbage', 'side-error']) {
    const tree = await a.client.request<TreeMeta>({ t: 'tree.create' }), before = calls.length
    await a.client.request({ t: 'send', treeId: tree.id, text, requestId: text })
    await until(() => calls.length >= before + 2, text + ' side call')
    await host.app.flush()
    assert.equal(space.suggestions.get(tree.id), undefined)
    assert.ok(!a.client.raw.some(raw => { const m = JSON.parse(raw); return m.t === 'suggestions' && m.treeId === tree.id }))
  }
  await a.client.request({ t: 'prefs.set', suggestions: false })
  await second.until(() => second.prefs?.suggestions === false)
  let before = calls.length
  const off = await a.client.request<TreeMeta>({ t: 'tree.create' })
  await a.client.request({ t: 'send', treeId: off.id, text: 'Off', requestId: 'off' }); await space.harness.waitForIdle(ctx)
  assert.equal(calls.length, before + 1)
  await a.client.request({ t: 'prefs.set', suggestions: true })
  await space.channels.set('feishu', { enabled: true, values: { appId: 'cli_0123456789abcdef', stream: false }, secrets: { appSecret: 'test-secret' } })
  await space.channels.allow('feishu', 'owner-open-id', 'Owner')
  await until(() => remote.sockets.some(socket => socket.readyState === 1))
  before = calls.length
  await remote.event('suggestions-feishu', 'From Feishu')
  await until(async () => !!(await space.db.get<{ receipt: string }>('SELECT receipt FROM outbox WHERE id = ?', 'suggestions-feishu:final'))?.receipt)
  assert.equal(calls.length, before + 1)
  const channel = (await space.trees()).find(tree => tree.source?.kind === 'feishu')!
  await a.client.request({ t: 'send', treeId: channel.id, text: 'Continue on web', requestId: 'continue-channel' })
  await a.client.until(() => a.client.suggestions.get(channel.id), 15_000)
  const report = await host.app.usage(undefined, undefined, a.user.id)
  assert.equal(report.models.length, 1); assert.ok(report.models[0]!.calls >= 12, 'main and side calls are both metered')
})

test('D2/C8: DeepSeek suggestions use the Messages wrapper with no native tools/title/thinking and retain model usage', async t => {
  const remote = await deepseekPlatform(async (body, response) => {
    const side = JSON.stringify(body.system).includes('You suggest what the user might say next')
    const text = side ? JSON.stringify({ items: ['Check this conclusion', 'Apply the answer'] }) : 'An answer about a specific conclusion'
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end((await fixture('plain')).replace(JSON.stringify('A short summary or answer.'), JSON.stringify(text)))
  })
  const host = await startServer(options(await tempDir()))
  t.after(async () => { await host.close(); await remote.close() })
  const a = await account(host, 'deepseek@example.com'); t.after(() => a.client.close())
  const provider = await host.app.putProvider({ kind: 'deepseek', name: 'Native', apiKey: 'secret', baseUrl: remote.url, modelIds: ['deepseek-flash'] })
  const tree = await a.client.request<TreeMeta>({ t: 'tree.create' })
  await a.client.request({ t: 'send', treeId: tree.id, text: 'Explain this conclusion', requestId: 'native-side', model: { provider: provider.id, id: 'deepseek-flash', name: 'Flash' } })
  await a.client.until(() => a.client.suggestions.get(tree.id))
  assert.equal(remote.requests.length, 2)
  const side = remote.requests[1]!
  assert.deepEqual(side.safety_check, { level: 'high' }); assert.deepEqual(side.thinking, { type: 'disabled' })
  assert.equal(side.title, undefined); assert.equal(side.output_config, undefined); assert.equal(side.max_tokens, 300)
  assert.equal(side.tools?.length ?? 0, 0); assert.equal(side.messages.length, 1)
  const report = await host.app.usage(undefined, undefined, a.user.id)
  assert.deepEqual([report.models[0]!.calls, report.models[0]!.input, report.models[0]!.output], [2, 20, 12])
})
