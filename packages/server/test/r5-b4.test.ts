import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { fauxModels, UserSpace } from '../src/index.ts'
import type { Channel, ChannelDefinition, InboundTrigger, OutboxItem } from '../src/channels/channel.ts'
import { Outbox } from '../src/events/outbox.ts'
import { TriggerStore } from '../src/events/store.ts'
import { diskEnv } from './fixtures.ts'
import { tempDir } from './host-helpers.ts'
async function until(check: () => Promise<boolean>, timeout = 5000) { const end = Date.now() + timeout; while (!(await check())) { if (Date.now() > end) throw new Error('state timeout'); await new Promise(r => setTimeout(r, 20)) } }
class HttpChannel implements Channel {
  url: string
  constructor(url: string) { this.url = url }
  async start() {}
  async stop() {}
  async deliver(item: OutboxItem) { const response = await fetch(this.url, { method: 'POST', body: JSON.stringify(item) }); if (!response.ok) throw new Error('offline'); return response.text() }
}
const definition = (url: string): ChannelDefinition => ({ id: 'fixture', name: 'Fixture', description: 'HTTP channel', settings: [{ key: 'persona', label: 'Persona', kind: 'textarea' }, { key: 'secret', label: 'Secret', kind: 'secret' }], create: () => new HttpChannel(url) })
const inbound = (id: string, actor = 'actor'): InboundTrigger => ({ id, source: 'fixture', thread: { key: 'private-1', label: 'A chat', group: false }, actor: { id: actor, name: actor }, text: 'hello', destination: { chatId: 'private-1' } })

test('N1/N4/N6: real gate, Trigger deduplication, thread mapping, channel settings and final outbox; web followups stay on web', async () => {
  const deliveries: OutboxItem[] = []
  const receiver = createServer(async (req,res) => { let data = ''; for await (const c of req) data += c; deliveries.push(JSON.parse(data)); res.end('receipt-' + deliveries.length) })
  await new Promise<void>(r => receiver.listen(0,'127.0.0.1',r))
  const url = `http://127.0.0.1:${(receiver.address() as {port:number}).port}`
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: fauxModels(), env: await diskEnv(), secretKey: 'key', channels: [definition(url)], outboxRetryMs: 20 })
  try {
    await space.channels.set('fixture', { enabled: true, values: { persona: 'Keep it short' }, secrets: { secret: 'channel-private-secret' } })
    assert.ok(!JSON.stringify(space.channels.list()).includes('channel-private-secret'))
    assert.deepEqual(await space.ingestChannel(inbound('denied', 'stranger')), { decision: 'rejected' })
    assert.deepEqual(await space.trees(), [])
    assert.match((await space.triggers.list('fixture'))[0]!.reason!, /允许名单/)
    const pair = await space.channels.pair('fixture')
    assert.ok(pair.expiresAt > Date.now())
    assert.equal(await space.channels.consumePair('fixture', pair.code, { id: 'actor', name: 'Owner' }), true)
    assert.equal(await space.channels.consumePair('fixture', pair.code, { id: 'stranger', name: 'Other' }), false)
    assert.equal(space.channels.list().find(c => c.id === 'fixture')!.actors[0]!.role, 'owner')
    await Promise.all([space.ingestChannel(inbound('accepted')), space.ingestChannel(inbound('accepted'))])
    await until(async () => deliveries.length === 1)
    assert.equal(deliveries[0]!.payload.text, '收到：hello')
    const tree = (await space.trees())[0]!
    assert.deepEqual(tree.source, { kind: 'fixture', label: 'A chat' })
    assert.equal(await space.triggers.thread('fixture', 'private-1'), tree.id)
    const { branch } = await space.branchRow(tree.id)
    assert.equal((await (await space.open(branch, ctx)).agent(ctx)).instructions, 'Keep it short')
    await space.send(tree.id, { text: 'from web', requestId: 'web-followup' })
    await space.harness.waitForIdle(ctx)
    await space.outbox.drain()
    assert.equal(deliveries.length, 1)
    assert.equal((await space.triggers.get('web-followup'))!.source, 'web')
    await space.ingestChannel(inbound('another'))
    await until(async () => deliveries.length === 2)
    assert.equal((await space.trees()).length, 1)
    await space.channels.revoke('fixture', 'actor')
    assert.deepEqual(await space.ingestChannel(inbound('revoked')), { decision: 'rejected' })
    const secret = await space.db.get<{secrets:string}>('SELECT secrets FROM channels WHERE id = ?', 'fixture')
    assert.ok(!secret!.secrets.includes('channel-private-secret'))
    assert.equal(await space.db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'"), undefined)
  } finally { await space.close(); await new Promise<void>(r => receiver.close(() => r())) }
})

test('N6: final result and outbox commit together, recover after reopen and retry with durable receipts', async () => {
  const root = await tempDir(), path = join(root,'outbox.sqlite')
  let db = await openNodeSqliteDatabase(path), store = await TriggerStore.open(db)
  await store.admit(inbound('durable'), true)
  const item: OutboxItem = { id: 'durable:final', triggerId: 'durable', channelId: 'fixture', kind: 'message', payload: { text: 'answer' } }
  await store.complete('durable', { final: true }, [item])
  await store.complete('durable', { final: true }, [item])
  assert.equal((await db.get<{n:number}>('SELECT count(*) AS n FROM outbox'))!.n, 1)
  await db.close() // a final delivery has not started at this crash boundary
  db = await openNodeSqliteDatabase(path); store = await TriggerStore.open(db)
  let attempts = 0
  const received = new Set<string>()
  const receiver = createServer(async (req,res) => { let text=''; for await(const c of req) text+=c; if (++attempts < 3) { res.writeHead(503);res.end();return }; const item=JSON.parse(text) as OutboxItem; received.add(item.id); res.end('ack-' + item.id) })
  await new Promise<void>(r => receiver.listen(0,'127.0.0.1',r))
  const channel = new HttpChannel(`http://127.0.0.1:${(receiver.address() as {port:number}).port}`)
  const outbox = new Outbox(db, item => channel.deliver(item), 20)
  try {
    outbox.start()
    await until(async () => !!(await db.get<{receipt:string|null}>('SELECT receipt FROM outbox'))!.receipt)
    assert.equal(attempts, 3); assert.equal(received.size, 1)
    await outbox.drain(); assert.equal(attempts, 3)
    assert.equal((await db.get<{attempts:number}>('SELECT attempts FROM outbox'))!.attempts, 2)
    assert.deepEqual(JSON.parse((await store.get('durable'))!.result!), { final: true })
  } finally { await outbox.close(); await db.close(); await new Promise<void>(r => receiver.close(() => r())) }
})

test('N1/N6: pending web inputs recover with the Trigger id and replay does not branch or answer twice', async () => {
  const root = await tempDir(), path = join(root,'recover.sqlite'), env = await diskEnv(root)
  let space = await UserSpace.open(await openNodeSqliteDatabase(path), { models: fauxModels(), env })
  const tree = await space.createTree()
  await space.triggers.admit({ id: 'before-submit', source: 'web', thread: { key: tree.id, label: 'web', group: false }, actor: { id: 'owner', name: 'owner' }, text: 'recovered', treeId: tree.id }, true, { webInput: { text: 'recovered', requestId: 'before-submit' } })
  await space.close()
  space = await UserSpace.open(await openNodeSqliteDatabase(path), { models: fauxModels(), env })
  try {
    await space.harness.waitForIdle(ctx)
    const { watch } = await space.watch(tree.id); await watch.stop()
    const entries = watch.value.entries
    assert.equal(entries.filter(e => e.kind === 'pi.user').length,1)
    assert.equal(entries.filter(e => e.kind === 'pi.assistant').length,1)
    await space.send(tree.id, { text:'recovered', requestId:'before-submit' })
    await space.harness.waitForIdle(ctx)
    const { watch: after } = await space.watch(tree.id); await after.stop()
    assert.equal(after.value.entries.filter(e => e.kind === 'pi.user').length,1)
  } finally { await space.close() }
})
