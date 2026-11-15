// Authored wire fixtures exercise the actual SDK, durable history, HTTP/WebSocket and channel delivery.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { NATIVE_KIND, type BranchMeta, type NativeTrace, type ServerMessage, type TreeMeta } from '@gense/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UserSpace } from '../src/agent/space.ts'
import { deepseekModels, nativeState } from '../src/agent/deepseek.ts'
import { compactionOutcome } from '../src/agent/compaction.ts'
import { historyEntries } from '../src/agent/history.ts'
import { configFromEnv } from '../src/platform/config.ts'
import { startServer } from '../src/platform/server.ts'
import { diskEnv, docxFile } from './fixtures.ts'
import { Client, login, tempDir, type View } from './host-helpers.ts'
import { deepseekPlatform, fixture } from './deepseek-platform.ts'
import { feishuPlatform } from './feishu-platform.ts'

async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 15_000
  while (!(await check())) {
    assert.ok(Date.now() < end, 'state timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
const traceEntries = (view: View) => view.entries.filter(e => e.kind === NATIVE_KIND)
function pairs(view: View) {
  for (const [i, entry] of view.entries.entries()) {
    if (entry.kind !== NATIVE_KIND) continue
    assert.equal(view.entries[i - 1]?.kind, 'pi.assistant', 'a native trace stays immediately after its own answer')
    const assistant = view.entries[i - 1]!.model![0] as { deepseek?: { trace: NativeTrace } }
    const { blocks: _, responseId: __, ...trace } = entry.data as NativeTrace & { blocks: unknown; responseId: string }
    assert.deepEqual(trace, assistant.deepseek!.trace)
  }
}

test('C2/C3/C6: real WebSocket progress is throttled and branch-scoped; fork, edit, regenerate and versions keep answer/trace pairs', async t => {
  const remote = await deepseekPlatform(async (_body, res, ordinal) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (ordinal === 2) { res.end(await fixture('read-link')); return }
    const text = (await fixture('search')).replaceAll('srvtool-', 'srvtool-' + ordinal + '-').replaceAll('ds-search', 'ds-search-' + ordinal)
    for (const record of text.split('\n\n')) {
      res.write(record + '\n\n')
      await new Promise(resolve => setTimeout(resolve, 35))
    }
    res.end()
  }); t.after(() => remote.close())
  const host = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: await tempDir(), SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'seal' }), port: 0 })
  t.after(() => host.close())
  const user = await host.auth.register('native@example.com', 'a long password')
  const cookie = (await login(host.url, 'a long password', user.email)).cookie!
  await host.app.putProvider({ kind: 'deepseek', name: 'Native', baseUrl: remote.url, modelIds: [], apiKey: 'never-send-this-key-to-the-browser' })
  const space = (await host.spaces.sync(user.id))!
  await space.preferences.set({ suggestions: false })
  await space.plugins.set('web', { enabled: true })
  const client = await Client.connect(host.url, cookie), other = await Client.connect(host.url, cookie)
  t.after(() => { client.close(); other.close() })
  const tree = await client.request<TreeMeta>({ t: 'tree.create' }), unrelated = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  await other.request({ t: 'watch', treeId: unrelated.id })
  const published: number[] = []
  nativeState(space).listeners.add(() => published.push(Date.now()))
  const main = (await client.request<{ branchId: string }>({ t: 'send', treeId: tree.id, text: 'First search', requestId: 'native-first' })).branchId
  const settled = (branchId: string, count: number) => client.until(() => {
    const view = client.views.get(tree.id)
    return client.shown.get(tree.id) === branchId && view && traceEntries(view).length === count &&
      client.branches.get(tree.id)?.branches.find(b => b.id === branchId)?.status === 'idle' && view
  }, 15_000, 'native answer')
  const initial = await settled(main, 1), first = initial.entries.find(e => e.kind === 'pi.assistant')!
  pairs(initial)
  assert.ok(published.length >= 2)
  for (let i = 1; i < published.length; i++) assert.ok(published[i]! - published[i - 1]! >= 250, 'at most four changes per second')
  const natives = () => client.raw.map(raw => JSON.parse(raw) as ServerMessage).filter(m => m.t === 'native')
  assert.ok(natives().some(m => m.trace.steps[0]?.status === 'running'))
  assert.ok(!other.raw.some(raw => JSON.parse(raw).t === 'native'), 'an unwatched tree receives no progress')
  const trace = traceEntries(initial)[0]!.data as NativeTrace
  assert.deepEqual(trace.steps.map(s => [s.action, s.status, s.error]), [['search', 'done', undefined], ['open_page', 'failed', 'unavailable']])
  assert.deepEqual(trace.citations, [{
    url: 'https://example.com/a', title: 'Source A', site: 'Example', icon: 'https://example.com/icon.png',
    snippet: 'A source snippet', publishedAt: '2026-11-14T00:00:00Z',
  }])
  const fork = await client.request<BranchMeta>({ t: 'branch.fork', treeId: tree.id, branchId: main, at: first.id })
  assert.equal(fork.forkEntryId, first.id)
  await other.request({ t: 'watch', treeId: tree.id, branchId: fork.id })
  await other.until(() => other.shown.get(tree.id) === fork.id && traceEntries(other.views.get(tree.id)!).length === 1)
  pairs(other.views.get(tree.id)!)
  const otherBefore = other.raw.filter(raw => JSON.parse(raw).t === 'native').length
  await client.request({ t: 'send', treeId: tree.id, branchId: main, text: 'Second search', requestId: 'native-second' })
  const original = await settled(main, 2), second = original.entries.filter(e => e.kind === 'pi.user')[1]!
  for (let i = 1; i < published.length; i++) assert.ok(published[i]! - published[i - 1]! >= 250, 'the throttle also spans consecutive responses')
  assert.equal(other.raw.filter(raw => JSON.parse(raw).t === 'native').length, otherBefore, 'another branch receives no progress')
  const edit = await client.request<{ branchId: string }>({ t: 'send', treeId: tree.id, branchId: main, replace: second.id, text: 'Edited search', requestId: 'native-edit' })
  await client.request({ t: 'watch', treeId: tree.id, branchId: edit.branchId })
  const edited = await settled(edit.branchId, 2)
  pairs(edited)
  const again = await client.request<BranchMeta>({ t: 'regenerate', treeId: tree.id, branchId: main, entryId: second.id, requestId: 'native-again' })
  assert.equal(again.forkEntryId, first.id, 'regeneration exposes the assistant ID rather than the native entry ID')
  await client.request({ t: 'watch', treeId: tree.id, branchId: again.id })
  const regenerated = await settled(again.id, 2)
  pairs(regenerated)
  await client.until(() => client.branches.get(tree.id)?.versions[String(first.id)]?.length === 3)
  assert.deepEqual(client.branches.get(tree.id)!.versions[String(first.id)], [main, edit.branchId, again.id])
  const expected = new Map([[main, original], [edit.branchId, edited], [again.id, regenerated], [fork.id, initial]])
  for (const [branchId, previous] of expected) {
    await client.request({ t: 'watch', treeId: tree.id, branchId })
    await client.until(() => client.shown.get(tree.id) === branchId)
    pairs(client.views.get(tree.id)!)
    assert.deepEqual(traceEntries(client.views.get(tree.id)!).map(e => e.id), traceEntries(previous).map(e => e.id))
  }
  assert.ok(!client.raw.some(raw => raw.includes('never-send-this-key-to-the-browser')))
  assert.ok(!remote.requests[0]!.tools.some((tool: any) => ['web_search', 'web_fetch', 'deep_search'].includes(tool.name)))
})

test('C2/C3/C6: signed blocks replay only to their provider/model; compaction drops old blocks while an earlier fork retains them', async t => {
  const remote = await deepseekPlatform(async (_body, res, ordinal) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(await fixture(ordinal === 1 ? 'read-link' : 'plain'))
  }); t.after(() => remote.close())
  const a = deepseekModels({ providerId: 'shared-one', baseUrl: remote.url, apiKey: 'one' })
  const b = deepseekModels({ providerId: 'shared-two', baseUrl: remote.url, apiKey: 'two' })
  const models = { providers: [...a.providers, ...b.providers], options: [...a.options, ...b.options], defaultModel: a.defaultModel, kinds: { ...a.kinds, ...b.kinds } }
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), {
    models, env: await diskEnv(), harness: { settings: { compaction: { enabled: false, keepRecentTokens: 128 } } },
  }); t.after(() => space.close())
  await space.preferences.set({ suggestions: false })
  await space.plugins.set('web', { enabled: false })
  const tree = await space.createTree(), { branch } = await space.branchRow(tree.id), conv = await space.open(branch, ctx)
  const send = async (text: string, provider = 'shared-one', id = 'deepseek-flash', branchId = branch.id) => {
    await space.send(tree.id, { text, requestId: crypto.randomUUID(), branchId, model: { provider, id, name: id } })
    await space.harness.waitForIdle(ctx)
    return remote.requests.at(-1)!
  }
  await send('Read https://example.com/a')
  const first = (await historyEntries(conv, ctx)).find(e => e.kind === 'pi.assistant')!
  const fork = await space.fork(tree.id, branch.id, first.id)
  assert.doesNotMatch(JSON.stringify(await send('Use Pro', 'shared-one', 'deepseek-v4-pro')), /signed-page-for-next-turn/)
  assert.doesNotMatch(JSON.stringify(await send('Use another provider', 'shared-two')), /signed-page-for-next-turn/)
  assert.match(JSON.stringify(await send('Back to the original provider')), /signed-page-for-next-turn/)
  for (let i = 0; i < 5; i++) {
    await conv.submit({ type: 'write', entry: { kind: 'pi.user', model: [{ role: 'user', content: 'Later history ' + 'x'.repeat(3000), timestamp: Date.now() }] } }, ctx)
    await conv.submit({ type: 'write', entry: { kind: 'pi.assistant', model: [fauxAssistantMessage('A later answer')] } }, ctx)
  }
  const compact = await space.compact(tree.id, branch.id)
  assert.deepEqual(await compactionOutcome(space, compact.taskId, ctx), { status: 'placed' })
  const summary = remote.requests.at(-1)!
  assert.match(JSON.stringify(summary.system), /context summarization assistant/)
  assert.equal(summary.title, undefined)
  assert.ok(!summary.tools?.some((tool: any) => tool.type?.startsWith('deepseek_')))
  assert.doesNotMatch(JSON.stringify(await send('Continue after compaction')), /signed-page-for-next-turn/)
  assert.match(JSON.stringify(await send('Continue old fork', 'shared-one', 'deepseek-flash', fork.id)), /signed-page-for-next-turn/)
  const full = await historyEntries(conv, ctx)
  assert.equal(full[full.findIndex(e => e.id === first.id) + 1]!.kind, NATIVE_KIND, 'compaction preserves the full displayed history')
})

test('C5/C6: attachment-only first turns request automatic titles; deleting a tree clears its title marker and parsed-file index', async t => {
  const remote = await deepseekPlatform(async (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end((await fixture('plain')).replace('"stop_reason":"end_turn"', '"stop_reason":"end_turn","title":"Attachment title"'))
  }); t.after(() => remote.close())
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: deepseekModels({ apiKey: 'dummy', baseUrl: remote.url }), env: await diskEnv() })
  t.after(() => space.close())
  await space.preferences.set({ suggestions: false })
  const tree = await space.createTree(), file = await space.workspace.upload('report.docx', docxFile())
  await space.send(tree.id, { text: '', attachments: [file.id], requestId: 'attachment-title' })
  await space.harness.waitForIdle(ctx)
  assert.deepEqual(remote.requests[0]!.title, { enabled: true })
  await until(async () => (await space.row(tree.id)).title === 'Attachment title')
  assert.equal((await space.row(tree.id)).title, 'Attachment title')
  assert.equal((await space.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attachment_parses'))!.n, 1)
  await space.updateTree(tree.id, { title: 'Manual title' })
  await space.deleteTree(tree.id)
  assert.equal((await space.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attachment_parses'))!.n, 0)
  assert.equal((await space.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deepseek_titles'))!.n, 0)
})

test('C4/C6: a real Feishu channel sends the refusal explanation and never publishes provisional native text or thinking', async t => {
  const remote = await feishuPlatform()
  const native = await deepseekPlatform(async (_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const record of (await fixture('refusal')).split('\n\n')) {
      res.write(record + '\n\n')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    res.end()
  })
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), {
    models: deepseekModels({ baseUrl: native.url, apiKey: 'dummy' }), env: await diskEnv(), secretKey: 'seal',
    feishu: { domain: remote.origin, publicUrl: 'http://localhost:8787', streamMs: 20 },
  })
  t.after(async () => { await space.close(); await remote.close(); await native.close() })
  await space.preferences.set({ suggestions: false })
  await space.channels.set('feishu', { enabled: true, values: { appId: 'cli_0123456789abcdef', stream: true }, secrets: { appSecret: 'test-secret' } })
  await space.channels.allow('feishu', 'owner-open-id', 'Owner')
  await until(() => remote.sockets.some(socket => socket.readyState === 1))
  await remote.event('native-refusal', 'A refusal fixture')
  await until(async () => !!(await space.db.get<{ receipt: string }>('SELECT receipt FROM outbox WHERE id = ?', 'native-refusal:final'))?.receipt)
  assert.match(remote.sent.at(-1)!.content, /这个问题我没法回答。/)
  const delivered = JSON.stringify([remote.sent, remote.patches])
  assert.doesNotMatch(delivered, /Text that must be removed|thinking|must-not-exist/)
  assert.equal(native.requests.length, 1, 'the rejected client tool is never run')
})
