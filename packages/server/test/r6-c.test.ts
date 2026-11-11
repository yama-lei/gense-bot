// Roadmap-6 C1–C5: real harness, SQLite, faux model requests, channel SDK and web protocol.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { applyImmutable, decoder } from '@earendil-works/chord/delta'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { TranscriptContext } from '@earendil-works/pi-ai'
import type { ConversationView } from '@earendil-works/pi-durable'
import { COMPACTION_KIND, type CompactionOutcome, type ServerMessage } from '@gense/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UserSpace } from '../src/index.ts'
import { Connection } from '../src/channels/web.ts'
import { COMPACTION_INSTRUCTIONS } from '../src/agent/compaction.ts'
import { historyEntries } from '../src/agent/history.ts'
import { diskEnv } from './fixtures.ts'
import { feishuPlatform } from './feishu-platform.ts'

async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10_000
  while (!(await check())) {
    assert.ok(Date.now() < end, 'state timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function setup(options: { auto?: boolean; remote?: string } = {}) {
  const faux = fauxProvider({ models: [{ id: 'small', contextWindow: 8000, maxTokens: 1000 }, { id: 'large', contextWindow: 16000, maxTokens: 2000 }] })
  const requests: TranscriptContext[] = []
  const summaries: string[] = []
  let failure = false
  let release: (() => void) | undefined
  let gate: Promise<void> | undefined
  const respond = async (request: TranscriptContext) => {
    requests.push(request)
    const system = request.messages[0]
    if (system?.role === 'system' && typeof system.content === 'string' && system.content.includes('context summarization assistant')) {
      summaries.push(JSON.stringify(request.messages))
      await gate
      return failure ? fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'summary refused' }) : fauxAssistantMessage('Handoff: OLD-FACT; preserve decisions, preferences, references and next steps.')
    }
    return fauxAssistantMessage('answer')
  }
  faux.setResponses(Array.from({ length: 100 }, () => respond))
  const model = faux.getModel()
  const choice = { provider: model.provider, id: model.id, name: model.name }
  const db = await openNodeSqliteDatabase(':memory:')
  const space = await UserSpace.open(db, {
    models: { providers: [faux.provider], options: faux.models.map(m => ({ provider: m.provider, id: m.id, name: m.name })), defaultModel: choice },
    env: await diskEnv(), secretKey: 'key', outboxRetryMs: 20,
    harness: { settings: { retry: { enabled: false }, ...(options.auto === false && { compaction: { enabled: false } }) } },
    ...(options.remote && { feishu: { domain: options.remote, publicUrl: 'https://gense.example' } }),
  })
  const tree = await space.createTree()
  const { branch } = await space.branchRow(tree.id)
  const conv = await space.open(branch, ctx)
  const messages: ServerMessage[] = []
  let view: ConversationView | undefined
  let dec = decoder()
  const connection = new Connection({ space, send(raw) {
    const message = JSON.parse(raw) as ServerMessage
    messages.push(message)
    if (message.t === 'view') { view = message.value as ConversationView; dec = decoder() }
    if (message.t === 'ops') view = applyImmutable(view, dec.decode(message.ops))
  } })
  await connection.start()
  let id = 0
  const request = async (body: Record<string, unknown>) => {
    const requestId = ++id
    await connection.handle(JSON.stringify({ ...body, id: requestId }))
    // A compaction asked to wait replies after `handle` returns.
    await until(() => messages.some(m => m.t === 'reply' && m.id === requestId))
    const reply = messages.findLast(m => m.t === 'reply' && m.id === requestId)
    assert.ok(reply?.t === 'reply')
    if (reply.error) throw new Error(reply.error)
    return reply.value as { taskId: number; branchId: string; outcome?: CompactionOutcome }
  }
  await request({ t: 'watch', treeId: tree.id })
  const send = async (text: string, branchId = branch.id) => {
    await space.send(tree.id, { text, branchId, requestId: crypto.randomUUID() })
    await space.harness.waitForIdle(ctx)
  }
  // Real write admissions build a long existing conversation without spending generation requests on fixture setup.
  const seed = async (count = 4, size = 4000) => {
    for (let i = 0; i < count; i++) {
      await conv.submit({ type: 'write', requestId: crypto.randomUUID(), entry: { kind: 'pi.user', model: [{ role: 'user', content: `OLD-FACT-${i} ` + 'x'.repeat(size), timestamp: Date.now() }] } }, ctx)
      await conv.submit({ type: 'write', requestId: crypto.randomUUID(), entry: { kind: 'pi.assistant', model: [fauxAssistantMessage('previous answer')] } }, ctx)
    }
  }
  return { space, tree, branch, conv, messages, summaries, requests, request, send, seed,
    get view() { return view! },
    fail(value: boolean) { failure = value },
    hold() { gate = new Promise(resolve => { release = resolve }) },
    release() { release?.(); gate = undefined },
    async close() { release?.(); await connection.close(); await space.close() },
  }
}

test('C1/C2: model-sized automatic compaction keeps answering and uses the handoff prompt', async () => {
  const f = await setup()
  try {
    await f.seed(7)
    await f.send('Continue the task')
    await until(() => f.messages.some(m => m.t === 'compaction_summary'))
    assert.ok(f.messages.some(m => m.t === 'compaction_start' && m.reason === 'threshold'))
    assert.ok(f.messages.some(m => m.t === 'compaction_end' && !m.error))
    assert.ok(f.summaries[0]?.includes(COMPACTION_INSTRUCTIONS.replaceAll('\n', '\\n')))
    assert.ok(JSON.stringify(f.view.entries.findLast(e => e.kind === 'pi.assistant')?.model).includes('"text":"answer"'))
    assert.ok(!(f.view.docs['pi.live'] as { run?: unknown }).run)
    const context = await f.conv.context(ctx)
    assert.ok(context.head)
    assert.ok(context.entries.length < f.view.entries.length)
    // A second model on the same harness gets its own larger recent-context budget.
    await f.conv.configure({ model: { provider: (await f.conv.agent(ctx)).model!.provider, modelId: 'large' } }, ctx)
    await f.send('Continue with the larger model')
    assert.equal((await f.conv.agent(ctx)).model!.modelId, 'large')
  } finally { await f.close() }
})

test('C1: approaching the limit starts compaction in the background while the answer continues', async () => {
  const f = await setup()
  let answer: Promise<void> | undefined
  try {
    const model = (await f.conv.agent(ctx)).model!
    await f.conv.configure({ model: { provider: model.provider, modelId: 'large' } }, ctx)
    await f.seed(7)
    f.hold()
    answer = f.send('Continue while summarizing')
    await until(() => f.messages.some(m => m.t === 'compaction_start'))
    assert.ok(f.messages.some(m => m.t === 'compaction_start' && !m.blocking))
    await answer
    assert.ok(JSON.stringify(f.view.entries.findLast(e => e.kind === 'pi.assistant')?.model).includes('"text":"answer"'))
    f.release()
    await until(() => f.messages.some(m => m.t === 'compaction_summary'))
  } finally { f.release(); await answer; await f.close() }
})

test('C3/C4: web compaction streams start, failure, successful summary and reconnect state', async () => {
  const f = await setup({ auto: false })
  try {
    await f.seed()
    f.fail(true)
    f.hold()
    const admitted = await f.request({ t: 'compact', treeId: f.tree.id, instructions: 'Preserve ticket ABC-123.' })
    assert.equal(admitted.branchId, f.branch.id)
    await until(() => f.messages.some(m => m.t === 'compaction_start' && m.taskId === admitted.taskId))
    assert.ok(f.messages.some(m => m.t === 'compaction.state' && m.running.length === 1))
    f.release()
    await f.space.harness.waitForIdle(ctx)
    await until(() => f.messages.some(m => m.t === 'compaction_end' && m.error?.includes('summary refused')))
    assert.match(f.summaries[0]!, /Preserve ticket ABC-123/)
    await f.request({ t: 'watch', treeId: f.tree.id })
    assert.ok(f.messages.findLast(m => m.t === 'compaction.state')?.t === 'compaction.state')
    assert.ok(f.messages.some(m => m.t === 'compaction.state' && m.failure?.error.includes('summary refused')))
    f.fail(false)
    await f.request({ t: 'compact', treeId: f.tree.id, branchId: f.branch.id })
    await f.space.harness.waitForIdle(ctx)
    await until(() => f.messages.some(m => m.t === 'compaction_summary'))
    const state = f.messages.findLast(m => m.t === 'compaction.state')
    assert.ok(state?.t === 'compaction.state' && !state.failure && state.running.length === 0)
    const summary = f.messages.find(m => m.t === 'compaction_summary')!
    assert.ok(summary.t === 'compaction_summary' && summary.summary.startsWith('Handoff:'))
    const count = f.messages.filter(m => m.t === 'compaction_summary').length
    await f.request({ t: 'watch', treeId: f.tree.id })
    assert.equal(f.messages.filter(m => m.t === 'compaction_summary').length, count + 1, 'summary is replayed on reconnect')
    await assert.rejects(f.request({ t: 'compact', treeId: f.tree.id, branchId: 'missing' }), /分叉不存在/)
  } finally { await f.close() }
})

test('C3: a manual compaction asked to wait says whether it placed a summary; a chat too short to cut has nothing to compact', async () => {
  const f = await setup({ auto: false })
  try {
    // An empty chat; with this test model's small window, any message at all would already be worth compacting.
    assert.deepEqual((await f.request({ t: 'compact', treeId: f.tree.id, wait: true })).outcome, { status: 'nothing' })
    await f.seed()
    assert.deepEqual((await f.request({ t: 'compact', treeId: f.tree.id, wait: true })).outcome, { status: 'placed' })
  } finally { await f.close() }
})

test('C5: compaction preserves full streamed history and old/new forks, edits and regeneration', async () => {
  const f = await setup({ auto: false })
  try {
    for (let i = 0; i < 4; i++) await f.send(`OLD-FACT-${i} ` + 'x'.repeat(4000))
    const before = await historyEntries(f.conv, ctx)
    await f.request({ t: 'compact', treeId: f.tree.id })
    await f.space.harness.waitForIdle(ctx)
    await until(() => f.view.entries.some(e => e.kind === COMPACTION_KIND))
    assert.deepEqual(f.view.entries.filter(e => e.kind !== COMPACTION_KIND).map(e => e.id), before.map(e => e.id))
    await f.request({ t: 'watch', treeId: f.tree.id })
    assert.equal(f.view.entries.length, before.length + 1)
    const oldUser = before.find(e => e.kind === 'pi.user')!
    const oldAnswer = before.find(e => e.kind === 'pi.assistant')!
    const oldFork = await f.space.fork(f.tree.id, f.branch.id, oldAnswer.id)
    const oldConv = await f.space.open((await f.space.branchRow(f.tree.id, oldFork.id)).branch, ctx)
    assert.deepEqual((await historyEntries(oldConv, ctx)).map(e => e.id), before.slice(0, before.indexOf(oldAnswer) + 1).map(e => e.id))
    const again = await f.space.regenerate(f.tree.id, f.branch.id, oldUser.id, { requestId: 'again' })
    await f.space.harness.waitForIdle(ctx)
    assert.ok((await f.space.branches(f.tree.id)).versions.start?.includes(again.id))
    await f.send('new turn after compaction')
    const tail = (await historyEntries(f.conv, ctx)).at(-1)!
    const newFork = await f.space.fork(f.tree.id, f.branch.id, tail.id)
    const newConv = await f.space.open((await f.space.branchRow(f.tree.id, newFork.id)).branch, ctx)
    assert.ok((await newConv.context(ctx)).head)
    assert.ok((await historyEntries(newConv, ctx)).some(e => e.id === oldUser.id))
    const postUser = (await historyEntries(f.conv, ctx)).findLast(e => e.kind === 'pi.user')!
    await f.space.send(f.tree.id, { branchId: f.branch.id, replace: postUser.id, text: 'edited after compaction', requestId: 'edit' })
    await f.space.harness.waitForIdle(ctx)
    const versions = (await f.space.branches(f.tree.id)).versions
    assert.ok(Object.values(versions).some(ids => ids.length >= 2))
    // Manual compaction targets the chosen branch even while the main one remains available.
    await f.request({ t: 'compact', treeId: f.tree.id, branchId: newFork.id })
    await f.space.harness.waitForIdle(ctx)
  } finally { await f.close() }
})

test('C3: Feishu /compact is a command with extra instructions and completion/failure feedback', async () => {
  const remote = await feishuPlatform()
  const f = await setup({ auto: false, remote: remote.origin })
  const delivered = (id: string) => until(async () => !!(await f.space.db.get<{ receipt: string | null }>('SELECT receipt FROM outbox WHERE id = ?', id + ':final'))?.receipt)
  try {
    await f.space.channels.set('feishu', { enabled: true, values: { appId: 'cli_0123456789abcdef' }, secrets: { appSecret: 'secret' } })
    const pair = await f.space.channels.pair('feishu')
    assert.equal(await remote.event('pair', pair.code), 200)
    await delivered('pair')
    assert.equal(await remote.event('empty', '/compact'), 200)
    await delivered('empty')
    assert.ok(remote.sent.some(m => m.content.includes('还没有可压缩')))
    assert.equal(await remote.event('new', '/new'), 200)
    await delivered('new')
    const treeId = (await f.space.triggers.thread('feishu', 'private-chat'))!
    const conv = await f.space.open(await f.space.mainBranch(treeId), ctx)
    for (let i = 0; i < 4; i++) await conv.submit({ type: 'write', requestId: 'old-' + i, entry: { kind: 'pi.user', model: [{ role: 'user', content: 'OLD-FACT ' + 'x'.repeat(4000), timestamp: Date.now() }] } }, ctx)
    const before = (await historyEntries(conv, ctx)).length
    f.hold()
    assert.equal(await remote.event('compact', '/compact Keep the reference URLs'), 200)
    await until(() => remote.sent.some(m => m.content.includes('正在压缩上下文')))
    assert.ok(!(await f.space.triggers.get('compact'))?.result?.includes('"final":true'), 'Feishu ACK does not wait for the model')
    await f.space.channels.set('feishu', { values: { stream: false } })
    f.release()
    await delivered('compact')
    assert.match(f.summaries.at(-1)!, /Keep the reference URLs/)
    assert.equal((await historyEntries(conv, ctx)).length, before + 1, 'command does not enter the model as a user turn')
    assert.ok(remote.sent.some(m => m.content.includes('上下文压缩已完成')))
    for (let i = 0; i < 3; i++) await conv.submit({ type: 'write', requestId: 'more-' + i, entry: { kind: 'pi.user', model: [{ role: 'user', content: 'x'.repeat(4000), timestamp: Date.now() }] } }, ctx)
    f.fail(true)
    await remote.event('failed', '/compact')
    await delivered('failed')
    assert.ok(remote.sent.some(m => m.content.includes('上下文压缩失败')))
  } finally { await f.close(); await remote.close() }
})
