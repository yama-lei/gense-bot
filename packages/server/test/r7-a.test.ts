// Roadmap-7 A: real SQLite, files, WebSocket clients, Feishu transport and faux model requests.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { Message } from '@earendil-works/pi-ai'
import { MEMORY_LIMITS, type Memory, type MemoryToolDetails, type TreeMeta, type UserInfo } from '@gense/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fauxModels, UserSpace } from '../src/index.ts'
import { MEMORY_AUTO, MEMORY_EXPLICIT_ONLY, memorySection } from '../src/agent/memory-prompt.ts'
import { configFromEnv } from '../src/platform/config.ts'
import { startServer } from '../src/platform/server.ts'
import { diskEnv } from './fixtures.ts'
import { feishuPlatform } from './feishu-platform.ts'
import { Client, tempDir } from './host-helpers.ts'

const hostConfig = (root: string) => ({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: root, SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'r7-a-key' }), port: 0 })
async function register(host: Awaited<ReturnType<typeof startServer>>, email: string) {
  const res = await fetch(host.url + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })
  assert.equal(res.status, 200)
  return { user: (await res.json()).user as UserInfo, cookie: res.headers.get('set-cookie')!.split(';')[0]! }
}
async function until(check: () => boolean | Promise<boolean>, timeout = 10_000) {
  const end = Date.now() + timeout
  while (!(await check())) { if (Date.now() > end) throw new Error('state timeout'); await new Promise(r => setTimeout(r, 20)) }
}

function capturedModels() {
  const models = fauxModels()
  const requests: { sections: Record<string, string>; tools: Map<string, { description?: string }> }[] = []
  const provider = models.providers[0] as unknown as Record<'stream' | 'streamSimple', (model: unknown, context: { messages: Message[] }, options: unknown) => unknown>
  for (const key of ['stream', 'streamSimple'] as const) {
    const original = provider[key].bind(provider)
    provider[key] = (model, context, options) => {
      const sections: Record<string, string> = {}, tools = new Map<string, { description?: string }>()
      for (const message of context.messages) {
        if (message.role !== 'system') continue
        for (const [name, text] of Object.entries(message.sections ?? {})) { if (text === null) delete sections[name]; else sections[name] = text }
        for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
        for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
      }
      requests.push({ sections, tools })
      return original(model, context, options)
    }
  }
  return { models, requests }
}

test('A1/A6: memories and preferences synchronize across devices, isolate users and survive restart', async t => {
  const root = await tempDir(), config = hostConfig(root)
  let host = await startServer(config)
  const clients: Client[] = []
  t.after(async () => { for (const client of clients) client.close(); await host.close() })
  const a = await register(host, 'a@example.com'), b = await register(host, 'b@example.com')
  const first = await Client.connect(host.url, a.cookie), second = await Client.connect(host.url, a.cookie), other = await Client.connect(host.url, b.cookie)
  clients.push(first, second, other)
  await Promise.all(clients.map(c => c.until(() => c.prefs)))
  assert.equal(first.prefs!.useMemory, true); assert.equal(first.prefs!.memoryWrites, 'auto')
  const tree = await first.request<TreeMeta>({ t: 'tree.create' })
  const entry = await first.request<Memory>({ t: 'memory.add', text: 'Prefers metric units', source: 'saved', treeId: tree.id })
  await second.until(() => second.memories.some(m => m.id === entry.id))
  assert.equal(second.memories[0]!.source, 'saved'); assert.equal(second.memories[0]!.treeId, tree.id)
  assert.deepEqual(other.memories, [])
  await assert.rejects(other.request({ t: 'memory.update', memoryId: entry.id, text: 'other user' }), /记忆不存在/)
  await assert.rejects(other.request({ t: 'memory.add', text: 'other user', source: 'saved', treeId: tree.id }), /会话不存在/)
  await first.request({ t: 'memory.update', memoryId: entry.id, text: 'Prefers SI units', enabled: false })
  await second.until(() => second.memories[0]?.text === 'Prefers SI units' && !second.memories[0].enabled)
  await first.request({ t: 'prefs.set', useMemory: false, memoryWrites: 'explicit' })
  await second.until(() => second.prefs?.useMemory === false && second.prefs.memoryWrites === 'explicit')
  for (const raw of [{ useMemory: 'yes' }, { memoryWrites: 'sometimes' }])
    await assert.rejects(first.request({ t: 'prefs.set', ...raw } as never), /无效/)
  for (const client of clients.splice(0)) client.close()
  await host.close(); host = await startServer(config)
  const reopened = await Client.connect(host.url, a.cookie); clients.push(reopened)
  await reopened.until(() => reopened.memories.length === 1 && reopened.prefs)
  assert.equal(reopened.memories[0]!.text, 'Prefers SI units')
  assert.equal(reopened.prefs!.useMemory, false)
  await reopened.request({ t: 'memory.remove', memoryId: entry.id })
  await reopened.until(() => reopened.memories.length === 0)
  const modelMemory = await reopened.request<Memory>({ t: 'memory.add', text: 'Prefers short answers', source: 'model', treeId: tree.id })
  await reopened.request({ t: 'memory.remove', memoryId: modelMemory.id })
  const restored = await reopened.request<Memory>({ t: 'memory.add', text: modelMemory.text, source: modelMemory.source, treeId: modelMemory.treeId!, projectId: modelMemory.projectId, enabled: modelMemory.enabled })
  assert.equal(restored.source, 'model'); assert.equal(restored.treeId, tree.id)
})

test('A2/A5/A11: each later turn sees current enabled memories and preferences, with a bounded newest-first list', async t => {
  const captured = capturedModels()
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: captured.models, env: await diskEnv() })
  t.after(() => space.close())
  const entry = await space.memories.add({ text: 'Prefers metric units' })
  await space.memories.add({ text: 'Hidden preference', enabled: false })
  const tree = await space.createTree()
  const ask = async (id: string) => { await space.send(tree.id, { text: 'hi', requestId: id }); await space.harness.waitForIdle(ctx); return captured.requests.at(-1)! }
  const initial = await ask('first')
  assert.match(initial.sections.memory!, /Prefers metric units/); assert.doesNotMatch(initial.sections.memory!, /Hidden preference/)
  assert.ok(Object.keys(initial.sections).indexOf('memory') > Object.keys(initial.sections).indexOf('skills'))
  assert.ok(initial.tools.get('memory')!.description!.endsWith(MEMORY_AUTO))
  await space.preferences.set({ memoryWrites: 'explicit' })
  assert.ok((await ask('explicit')).tools.get('memory')!.description!.endsWith(MEMORY_EXPLICIT_ONLY))
  await space.memories.update(entry.id, { text: 'Prefers imperial units' })
  const updated = await ask('updated')
  assert.match(updated.sections.memory!, /Prefers imperial units/); assert.doesNotMatch(updated.sections.memory!, /Prefers metric units/)
  await space.memories.remove(entry.id)
  assert.doesNotMatch((await ask('removed')).sections.memory!, /imperial/)
  await space.preferences.set({ useMemory: false })
  const off = await ask('off')
  assert.equal(off.sections.memory, undefined); assert.equal(off.tools.has('memory'), false)
  assert.equal(off.sections.assistant, initial.sections.assistant, 'the stable prompt prefix is unchanged')
  const entries: Memory[] = Array.from({ length: MEMORY_LIMITS.entries }, (_, i) => ({ ...entry, id: String(i), text: 'x'.repeat(MEMORY_LIMITS.text), updatedAt: i }))
  const section = memorySection(entries, null)!
  assert.ok(section.indexOf('[199]') < section.indexOf('[198]'))
  assert.match(section, /older entries are not shown/)
  assert.ok(section.split('\n').filter(line => line.startsWith('- [')).join('\n').length <= MEMORY_LIMITS.prompt)
})

test('A3/A4: faux model adds, corrects and removes real memories with undo details; sensitive writes fail', async t => {
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: fauxModels(), env: await diskEnv() })
  t.after(() => space.close())
  const tree = await space.createTree()
  let n = 0
  const call = async (args: unknown) => {
    await space.send(tree.id, { text: '[工具 memory] ' + JSON.stringify(args), requestId: String(++n) })
    await space.harness.waitForIdle(ctx)
    const { watch } = await space.watch(tree.id); await watch.stop()
    return watch.value.entries.filter(e => e.kind === 'pi.tool-result').at(-1)!.model![0] as unknown as { isError?: boolean; content: unknown; details: MemoryToolDetails }
  }
  const added = await call({ action: 'add', text: 'Prefers metric units', scope: 'project' })
  assert.equal(added.isError, false)
  assert.equal(added.details.action, 'add'); assert.equal(added.details.memory.source, 'model')
  assert.equal(added.details.memory.projectId, null, 'project scope falls back to global outside a project')
  assert.equal(added.details.memory.treeId, tree.id)
  const updated = await call({ action: 'update', id: added.details.memory.id, text: 'Prefers SI units' })
  assert.equal(updated.details.previous!.text, 'Prefers metric units')
  assert.equal(updated.details.memory.text, 'Prefers SI units')
  const removed = await call({ action: 'remove', id: added.details.memory.id })
  assert.equal(removed.details.previous!.id, added.details.memory.id)
  assert.deepEqual(await space.memories.list(), [])
  for (const text of ['API key: sk-abcdefghijklmnopqrstuvwxyz', '-----BEGIN RSA PRIVATE KEY-----', 'Card 1234567890123456', '密码是 hunter2', 'password is hunter2']) {
    const result = await call({ action: 'add', text })
    assert.equal(result.isError, true, text)
    assert.match(JSON.stringify(result.content), /敏感内容/)
  }
  assert.deepEqual(await space.memories.list(), [])
  assert.equal((await call({ action: 'update', id: removed.details.memory.id })).isError, true)
})

test('A5: text and entry limits hold for concurrent real writes, including disabled memories', async t => {
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: fauxModels(), env: await diskEnv() })
  t.after(() => space.close())
  await assert.rejects(space.memories.add({ text: 'x'.repeat(MEMORY_LIMITS.text + 1) }), /500/)
  await assert.rejects(space.memories.add({ text: ' ' }), /字符/)
  const results = await Promise.allSettled(Array.from({ length: MEMORY_LIMITS.entries + 3 }, (_, i) => space.memories.add({ text: 'Durable preference ' + i, enabled: false })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, MEMORY_LIMITS.entries)
  assert.equal((await space.memories.list()).length, MEMORY_LIMITS.entries)
  for (const result of results.filter(r => r.status === 'rejected')) assert.match(String(result.reason), /记忆已满（200 条），请先删除一些/)
  await space.memories.remove((await space.memories.list())[0]!.id)
  await space.memories.add({ text: 'A replacement' })
  assert.equal((await space.memories.list()).length, MEMORY_LIMITS.entries)
})

test('A2/A3: real Feishu messages share the web memory prompt and memory tool', async t => {
  const remote = await feishuPlatform(), captured = capturedModels()
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: captured.models, env: await diskEnv(), secretKey: 'key', feishu: { domain: remote.origin, publicUrl: 'http://localhost:8787', streamMs: 20 } })
  t.after(async () => { await space.close(); await remote.close() })
  await space.memories.add({ text: 'Prefers metric units' })
  await space.channels.set('feishu', { enabled: true, values: { appId: 'cli_0123456789abcdef', stream: false }, secrets: { appSecret: 'test-secret' } })
  await space.channels.allow('feishu', 'owner-open-id', 'Owner')
  await until(() => remote.sockets.some(socket => socket.readyState === 1))
  await remote.event('memory', '[工具 memory] {"action":"add","text":"Reads Chinese"}')
  await until(async () => !!(await space.db.get<{ receipt: string }>('SELECT receipt FROM outbox WHERE id = ?', 'memory:final'))?.receipt)
  assert.match(captured.requests[0]!.sections.memory!, /Prefers metric units/)
  const entries = await space.memories.list()
  assert.equal(entries.find(m => m.text === 'Reads Chinese')!.source, 'model')
  assert.equal(entries.find(m => m.text === 'Reads Chinese')!.treeId, (await space.trees())[0]!.id)
  assert.match(remote.sent.at(-1)!.content, /Memory saved/)
  await space.preferences.set({ useMemory: false })
  await remote.event('memory-off', 'hi')
  await until(async () => !!(await space.db.get<{ receipt: string }>('SELECT receipt FROM outbox WHERE id = ?', 'memory-off:final'))?.receipt)
  assert.equal(captured.requests.at(-1)!.sections.memory, undefined)
  assert.equal(captured.requests.at(-1)!.tools.has('memory'), false)
})
