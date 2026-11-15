import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { NATIVE_KIND, type NativeTrace } from '@gense/protocol'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { UserSpace } from '../src/agent/space.ts'
import { deepseekModels, nativeState, type DeepSeekMessage } from '../src/agent/deepseek.ts'
import { diskEnv } from './fixtures.ts'
import { tempDir } from './host-helpers.ts'
import { deepseekPlatform, fixture } from './deepseek-platform.ts'

test('C2/C3/C5: authored SSE traverses the SDK, native progress, atomic SQLite trace, restart and signed replay', async t => {
  const remote = await deepseekPlatform(); t.after(() => remote.close())
  const root = await tempDir(), file = join(root, 'space.sqlite'), env = await diskEnv(join(root, 'files'))
  const models = deepseekModels({ providerId: 'shared-native', apiKey: 'dummy', baseUrl: remote.url })
  const open = async () => UserSpace.open(await openNodeSqliteDatabase(file), { models, env, secretKey: 'seal' })
  let space = await open()
  await space.plugins.set('web', { enabled: false })
  const trace: NativeTrace[] = []
  nativeState(space).listeners.add((_tree, _branch, next) => trace.push(next))
  const tree = await space.createTree()
  await space.preferences.set({ deepseekSafety: false })
  await space.send(tree.id, { text: 'Read https://example.com/a', requestId: 'first', effort: 'medium' })
  await space.harness.waitForIdle(ctx)
  const { branch } = await space.branchRow(tree.id), conv = await space.open(branch, ctx)
  const entries = (await conv.context(ctx)).entries
  const position = entries.findIndex(e => e.kind === 'pi.assistant')
  assert.equal(entries[position + 1]!.kind, NATIVE_KIND)
  assert.equal(entries[position + 1]!.model, undefined)
  const saved = entries[position]!.model![0] as DeepSeekMessage
  assert.equal(saved.deepseek!.blocks[1]!.signature, 'signed-page-for-next-turn')
  const native = entries[position + 1]!.data as unknown as NativeTrace
  assert.equal(native.steps[0]!.status, 'done'); assert.equal(native.citations.length, 1)
  assert.ok(trace.some(value => value.steps[0]?.status === 'running'))
  assert.deepEqual(remote.requests[0]!.tools.filter((tool: any) => tool.type), [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }])
  assert.deepEqual(remote.requests[0]!.safety_check, { level: 'high' })
  assert.deepEqual(remote.requests[0]!.output_config, { effort: 'high' })
  assert.deepEqual(remote.requests[0]!.title, { enabled: true })
  await space.close()
  space = await open(); t.after(() => space.close())
  assert.equal((await space.row(tree.id)).title, 'A native title')
  await space.send(tree.id, { text: 'What did that page say?', requestId: 'second' })
  await space.harness.waitForIdle(ctx)
  const body = remote.requests[1]!
  assert.ok(body.messages.some((m: any) => m.content?.some?.((b: any) => b.signature === 'signed-page-for-next-turn')))
  assert.equal(body.title, undefined)
  assert.deepEqual(body.output_config, { effort: 'high' }, 'the conversation retains its selected effort')
  const before = entries[position]!.id
  const fork = await space.fork(tree.id, branch.id, before)
  await space.send(tree.id, { text: 'Fork follow-up', branchId: fork.id, requestId: 'fork' })
  await space.harness.waitForIdle(ctx)
  assert.match(JSON.stringify(remote.requests.at(-1)), /signed-page-for-next-turn/)
})

test('C2/C4: native search removes ordinary web tools/guidance; refusal clears text, thinking and pending client tools', async t => {
  const remote = await deepseekPlatform(async (_body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(await fixture('refusal')) })
  t.after(() => remote.close())
  const models = deepseekModels({ providerId: 'shared-safety', apiKey: 'dummy', baseUrl: remote.url })
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models, env: await diskEnv(), secretKey: 'seal' })
  t.after(() => space.close())
  await space.plugins.set('web', { enabled: true })
  const tree = await space.createTree()
  await space.send(tree.id, { text: 'A refusal fixture', requestId: 'refusal', effort: 'high' })
  await space.harness.waitForIdle(ctx)
  const conv = await space.open((await space.branchRow(tree.id)).branch, ctx), entries = (await conv.context(ctx)).entries
  const assistant = entries.find(e => e.kind === 'pi.assistant')!.model![0] as DeepSeekMessage
  assert.deepEqual(assistant.content, []); assert.equal(assistant.stopReason, 'stop')
  assert.equal(assistant.usage.input, 50); assert.equal(assistant.usage.output, 18)
  assert.equal((entries.find(e => e.kind === NATIVE_KIND)!.data as unknown as NativeTrace).refusal, true)
  assert.equal((await space.workspace.list(tree.id)).some(f => f.path.endsWith('/must-not-exist.txt')), false)
  assert.deepEqual(remote.requests[0]!.output_config, { effort: 'max' })
  assert.ok(!remote.requests[0]!.tools.some((tool: any) => ['web_search', 'web_fetch', 'deep_search'].includes(tool.name)))
  assert.ok(!JSON.stringify(remote.requests[0]!.system).includes('<web>'))
  assert.ok(remote.requests[0]!.tools.some((tool: any) => tool.type === 'deepseek_web_search'))
})

test('C4/C8: input Content Exists Risk is refusal and SSE error usage survives the SDK error path', async t => {
  const remote = await deepseekPlatform(async (_body, res, ordinal) => {
    if (ordinal === 1) res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Content Exists Risk' }, usage: { input_tokens: 8, output_tokens: 0 } }))
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end((await fixture('error')).replaceAll('\n', '\r\n')) }
  }); t.after(() => remote.close())
  const models = deepseekModels({ apiKey: 'dummy', baseUrl: remote.url })
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models, env: await diskEnv(), harness: { settings: { retry: { enabled: false } } } })
  t.after(() => space.close())
  const tree = await space.createTree()
  await space.send(tree.id, { text: 'Input refusal', requestId: 'input' }); await space.harness.waitForIdle(ctx)
  const conv = await space.open((await space.branchRow(tree.id)).branch, ctx)
  let entries = (await conv.context(ctx)).entries
  assert.equal((entries.find(e => e.kind === 'pi.assistant')!.model![0] as DeepSeekMessage).deepseek!.trace.refusal, true)
  await space.send(tree.id, { text: 'Generation error', requestId: 'error' }); await space.harness.waitForIdle(ctx)
  entries = (await conv.context(ctx)).entries
  const last = entries.filter(e => e.kind === 'pi.assistant').at(-1)!.model![0] as DeepSeekMessage
  assert.equal(last.stopReason, 'error')
  assert.deepEqual([last.usage.input, last.usage.output, last.usage.cacheRead], [91, 7, 9])
  assert.equal(last.deepseek!.usage!.server_tool_use.tool_search, 3)
})

test('C1/C2/C4: BYOK safety preference and @web work without a plugin key; plain models receive no App fields', async t => {
  const remote = await deepseekPlatform(); t.after(() => remote.close())
  const models = deepseekModels({ providerId: 'shared-default', apiKey: 'dummy', baseUrl: remote.url })
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models, env: await diskEnv(), secretKey: 'seal' })
  t.after(() => space.close())
  space.accounts.models.setProvider(deepseekModels({ baseUrl: remote.url }).providers[0]!)
  await space.plugins.set('web', { enabled: false })
  await space.accounts.login('deepseek', 'api_key', { prompt: async () => 'byok', notify: () => {}, signal: new AbortController().signal })
  await space.preferences.set({ deepseekSafety: false })
  const tree = await space.createTree()
  await space.send(tree.id, { text: 'Search', requestId: 'byok', model: { provider: 'deepseek', id: 'deepseek-flash', name: 'Flash' }, mentions: [{ kind: 'plugin', id: 'web', label: 'Web' }] })
  await space.harness.waitForIdle(ctx)
  assert.deepEqual(remote.requests[0]!.safety_check, { level: 'low' })
  assert.equal(remote.requests[0]!.thinking, undefined)
  assert.ok(remote.requests[0]!.tools.some((tool: any) => tool.type === 'deepseek_web_search'))
  assert.ok(!JSON.stringify(remote.requests[0]!.messages).includes('这个插件现在没有开启'))
  await space.send(tree.id, { text: 'Plain model', requestId: 'plain', model: { provider: 'deepseek', id: 'deepseek-v4-pro', name: 'Pro' } })
  await space.harness.waitForIdle(ctx)
  for (const key of ['safety_check', 'title']) assert.equal(remote.requests[1]![key], undefined)
  assert.ok(!remote.requests[1]!.tools?.some((tool: any) => tool.type?.startsWith('deepseek_')))
  const plain = space.accounts.models.getModel('shared-default', 'deepseek-flash')!
  await space.accounts.models.completeSimple(plain, { messages: [{ role: 'user', content: 'Side request', timestamp: Date.now() }] })
  assert.equal(remote.requests[2]!.title, undefined)
  assert.deepEqual(remote.requests[2]!.thinking, { type: 'disabled' })
  assert.ok(!remote.requests[2]!.tools?.some((tool: any) => tool.type?.startsWith('deepseek_')))
})

test('C5: a title arriving after a user rename cannot overwrite it, even when it equals the first sentence', async t => {
  let release!: () => void, arrived!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { arrived = resolve })
  const remote = await deepseekPlatform(async (_body, res) => { arrived(); await gate; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(await fixture('read-link')) })
  t.after(() => remote.close()); t.after(() => release())
  const models = deepseekModels({ apiKey: 'dummy', baseUrl: remote.url })
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models, env: await diskEnv() })
  t.after(() => space.close())
  const tree = await space.createTree()
  await space.send(tree.id, { text: 'Same title', requestId: 'title' })
  await ready; await space.updateTree(tree.id, { title: 'Same title' }); release()
  await space.harness.waitForIdle(ctx)
  assert.equal((await space.row(tree.id)).title, 'Same title')
})
