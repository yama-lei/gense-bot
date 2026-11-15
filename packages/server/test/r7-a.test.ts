// Roadmap-7 A: real SQLite, files, WebSocket clients, Feishu transport and faux model requests.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { Message, ToolResultMessage } from '@earendil-works/pi-ai'
import { MEMORY_LIMITS, PROJECT_LIMITS, projectDir, type FileEntry, type Memory, type MemoryToolDetails, type Project, type TreeMeta, type UploadedFile, type UserInfo } from '@gense/protocol'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fauxModels, UserSpace } from '../src/index.ts'
import { MEMORY_AUTO, MEMORY_EXPLICIT_ONLY, memorySection } from '../src/agent/memory-prompt.ts'
import { MAX_UPLOAD } from '../src/agent/workspace.ts'
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
  const project = await space.projects.create({ name: 'Feishu research', instructions: 'Use SI units.' })
  await space.memories.add({ text: 'Research preference', projectId: project.id })
  await space.updateTree((await space.trees())[0]!.id, { projectId: project.id })
  await remote.event('project-in-feishu', 'hi')
  await until(async () => !!(await space.db.get<{ receipt: string }>('SELECT receipt FROM outbox WHERE id = ?', 'project-in-feishu:final'))?.receipt)
  assert.match(captured.requests.at(-1)!.sections.project!, /Use SI units/)
  assert.match(captured.requests.at(-1)!.sections.memory!, /Research preference/)
  await space.preferences.set({ useMemory: false })
  await remote.event('memory-off', 'hi')
  await until(async () => !!(await space.db.get<{ receipt: string }>('SELECT receipt FROM outbox WHERE id = ?', 'memory-off:final'))?.receipt)
  assert.equal(captured.requests.at(-1)!.sections.memory, undefined)
  assert.equal(captured.requests.at(-1)!.tools.has('memory'), false)
  assert.match(captured.requests.at(-1)!.sections.project!, /Use SI units/)
})

test('A7/A9/A10/A11: projects, membership, files and deletion choices synchronize, isolate users and survive restart', async t => {
  const root = await tempDir(), config = hostConfig(root)
  let host = await startServer(config)
  const clients: Client[] = []
  t.after(async () => { for (const client of clients) client.close(); await host.close() })
  const a = await register(host, 'a@example.com'), b = await register(host, 'b@example.com')
  let first = await Client.connect(host.url, a.cookie)
  const second = await Client.connect(host.url, a.cookie), other = await Client.connect(host.url, b.cookie)
  clients.push(first, second, other)
  await Promise.all(clients.map(c => c.until(() => c.prefs)))
  for (const input of [{ name: ' ' }, { name: 'x'.repeat(PROJECT_LIMITS.name + 1) }, { name: 'P', color: -1 }, { name: 'P', instructions: 'x'.repeat(PROJECT_LIMITS.instructions + 1) }])
    await assert.rejects(first.request({ t: 'project.create', ...input }), /名称|颜色|指令/)
  const project = await first.request<Project>({ t: 'project.create', name: 'Research', color: 2, instructions: 'Use SI units.' })
  await second.until(() => second.projects.some(p => p.id === project.id))
  assert.deepEqual(other.projects, [])
  for (const request of [
    { t: 'project.update', projectId: project.id, name: 'Other' }, { t: 'project.files.list', projectId: project.id },
    { t: 'tree.create', projectId: project.id }, { t: 'memory.add', text: 'Other user', projectId: project.id },
  ] as const) await assert.rejects(other.request(request), /项目不存在/)
  await first.request({ t: 'project.update', projectId: project.id, name: 'Current research', instructions: 'Use metric units.' })
  await second.until(() => second.projects[0]?.name === 'Current research' && second.projects[0].instructions === 'Use metric units.')
  const inside = await first.request<TreeMeta>({ t: 'tree.create', projectId: project.id }), outside = await first.request<TreeMeta>({ t: 'tree.create' })
  assert.equal(inside.projectId, project.id)
  await first.request({ t: 'tree.update', treeId: outside.id, projectId: project.id })
  await second.until(() => second.trees.filter(tree => tree.projectId === project.id).length === 2)
  await first.request({ t: 'tree.update', treeId: outside.id, projectId: null })
  await second.until(() => second.trees.find(tree => tree.id === outside.id)?.projectId === undefined)
  const upload = await first.request<UploadedFile>({ t: 'upload', name: 'reference.md', base64: Buffer.from('Research material').toString('base64') })
  const files = await first.request<FileEntry[]>({ t: 'project.files.add', projectId: project.id, uploads: [upload.id] })
  assert.equal(files[0]!.path, `${projectDir(project.id)}/reference.md`); assert.equal(files[0]!.readOnly, true)
  assert.ok(!(await first.request<UploadedFile[]>({ t: 'uploads' })).some(file => file.id === upload.id), 'uploads are moved')
  assert.equal(Buffer.from((await first.request<{ base64: string }>({ t: 'project.files.read', projectId: project.id, path: 'reference.md' })).base64, 'base64').toString(), 'Research material')
  await assert.rejects(first.request({ t: 'project.files.read', projectId: project.id, path: '../elsewhere/private' }), /只能访问/)
  await first.request({ t: 'memory.add', text: 'Project-only preference', projectId: project.id })
  await first.request({ t: 'memory.add', text: 'Global preference' })
  const persisted = await first.request<Project>({ t: 'project.create', name: 'Persisted', instructions: 'Keep citations.' })
  const doomed = await first.request<TreeMeta>({ t: 'tree.create', projectId: persisted.id })
  for (const client of clients.splice(0)) client.close()
  await host.close(); host = await startServer(config)
  first = await Client.connect(host.url, a.cookie); clients.push(first)
  await first.until(() => first.projects.length === 2 && first.trees.length === 3 && first.memories.length === 2)
  assert.equal(first.trees.find(tree => tree.id === inside.id)!.projectId, project.id)
  assert.equal((await first.request<FileEntry[]>({ t: 'project.files.list', projectId: project.id }))[0]!.path, files[0]!.path)
  await first.request({ t: 'project.delete', projectId: project.id, deleteChats: false })
  assert.equal(first.trees.find(tree => tree.id === inside.id)!.projectId, undefined)
  assert.deepEqual(first.memories.map(memory => memory.text), ['Global preference'])
  await assert.rejects(access(join(root, 'users', a.user.id, 'files', 'projects', project.id)))
  await first.request({ t: 'project.delete', projectId: persisted.id, deleteChats: true })
  assert.ok(!first.trees.some(tree => tree.id === doomed.id))
  await assert.rejects(first.request({ t: 'files.list', treeId: doomed.id }), /会话不存在/)
  assert.equal(first.projects.length, 0)
})

test('A8/A10/A11: existing conversations, forks and moves use current project instructions, files and scoped memory', async t => {
  const captured = capturedModels()
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: captured.models, env: await diskEnv() })
  t.after(() => space.close())
  const project = await space.projects.create({ name: 'Research', instructions: 'Use SI units.' }), other = await space.projects.create({ name: 'Other' })
  await space.memories.add({ text: 'Global preference' })
  await space.memories.add({ text: 'Research preference', projectId: project.id })
  await space.memories.add({ text: 'Other project preference', projectId: other.id })
  const upload = await space.workspace.upload('reference.md', Buffer.from('Project reference'))
  await space.projects.addFiles(project.id, [upload.id])
  const tree = await space.createTree()
  let n = 0
  const ask = async (text = 'hi', branchId?: string) => { await space.send(tree.id, { text, requestId: String(++n), ...(branchId && { branchId }) }); await space.harness.waitForIdle(ctx); return captured.requests.at(-1)! }
  const initial = await ask()
  assert.equal(initial.sections.project, undefined); assert.doesNotMatch(initial.sections.memory!, /Research preference|Other project/)
  await space.updateTree(tree.id, { projectId: project.id })
  const inside = await ask()
  assert.match(inside.sections.project!, /Use SI units\./); assert.match(inside.sections.project!, /reference\.md/)
  assert.match(inside.sections.project!, /read-only/)
  assert.match(inside.sections.memory!, /Global preference/); assert.match(inside.sections.memory!, /Research preference/)
  assert.doesNotMatch(inside.sections.memory!, /Other project preference/)
  await ask('[工具 memory] {"action":"add","text":"Researches climate"}')
  assert.equal((await space.memories.list()).find(memory => memory.text === 'Researches climate')!.projectId, project.id)
  await ask('[工具 memory] {"action":"add","text":"Reads Chinese","scope":"global"}')
  assert.equal((await space.memories.list()).find(memory => memory.text === 'Reads Chinese')!.projectId, null)
  const otherMemory = (await space.memories.list()).find(memory => memory.projectId === other.id)!
  await ask('[工具 memory] ' + JSON.stringify({ action: 'remove', id: otherMemory.id }))
  assert.ok(await space.memories.get(otherMemory.id), 'the model cannot change another project memory')
  await space.projects.update(project.id, { instructions: 'Use metric units and cite sources.' })
  await space.projects.deleteFile(project.id, 'reference.md')
  const updated = await ask()
  assert.match(updated.sections.project!, /cite sources/); assert.doesNotMatch(updated.sections.project!, /reference\.md/)
  const { branch, tree: row } = await space.branchRow(tree.id)
  const { watch } = await space.watch(tree.id, branch.id); await watch.stop()
  const fork = await space.fork(tree.id, branch.id, watch.value.entries.find(entry => entry.kind === 'pi.user')!.id)
  const forked = await ask('from fork', fork.id)
  assert.match(forked.sections.project!, /cite sources/); assert.equal(row.projectId, project.id)
  await space.preferences.set({ useMemory: false })
  const noMemory = await ask('memory disabled', fork.id)
  assert.match(noMemory.sections.project!, /cite sources/); assert.equal(noMemory.sections.memory, undefined)
  await space.preferences.set({ useMemory: true })
  await space.updateTree(tree.id, { projectId: null })
  const moved = await ask('outside', fork.id)
  assert.equal(moved.sections.project, undefined); assert.doesNotMatch(moved.sections.memory!, /Research preference|Researches climate/)
  assert.equal(moved.sections.assistant, initial.sections.assistant)
})

test('A9: project file size limits use real sizes, validate batches before moving, and serialize concurrent additions', async t => {
  const root = await tempDir(), space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: fauxModels(), env: await diskEnv(root) })
  t.after(() => space.close())
  const project = await space.projects.create({ name: 'Files' }), env = await space.workspace.env('/data')
  const sparse = async (name: string, size: number) => {
    const file = await space.workspace.upload(name, new Uint8Array())
    const truncated = await env.truncateFile(file.id, size, ctx)
    assert.ok(truncated.ok)
    return file.id
  }
  const uploads = await Promise.all(Array.from({ length: 11 }, (_, i) => sparse(`file-${i}.bin`, MAX_UPLOAD)))
  await space.projects.addFiles(project.id, uploads.slice(0, 9))
  const concurrent = await Promise.allSettled(uploads.slice(9).map(id => space.projects.addFiles(project.id, [id])))
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(concurrent.filter(result => result.status === 'rejected').length, 1)
  assert.equal((await space.projects.listFiles(project.id)).reduce((sum, file) => sum + file.size, 0), PROJECT_LIMITS.files)
  const oversized = await sparse('too-big.bin', MAX_UPLOAD + 1)
  await assert.rejects(space.projects.addFiles(project.id, [oversized]), /超过 20 MB/)
  assert.ok((await space.workspace.uploads()).some(file => file.id === oversized))
  const empty = await space.projects.create({ name: 'Batch' }), valid = await space.workspace.upload('note.txt', Buffer.from('hello'))
  await assert.rejects(space.projects.addFiles(empty.id, [valid.id, '/data/uploads/missing']), /不存在|no such|not found|ENOENT/i)
  assert.deepEqual(await space.projects.listFiles(empty.id), [])
  assert.ok((await space.workspace.uploads()).some(file => file.id === valid.id))
  await assert.rejects(space.projects.addFiles(empty.id, [valid.id, valid.id]), /重复/)
  await assert.rejects(space.projects.addFiles(empty.id, [projectDir(project.id) + '/file-0.bin']), /只能访问/)
  await space.projects.addFiles(empty.id, [valid.id])
  const duplicate = await space.workspace.upload('note.txt', Buffer.from('different'))
  const listed = await space.projects.addFiles(empty.id, [duplicate.id])
  assert.equal(listed.length, 2); assert.equal(new Set(listed.map(file => file.path)).size, 2)
  await space.projects.deleteFile(empty.id, 'note.txt')
  assert.equal((await space.projects.listFiles(empty.id)).length, 1)
})

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const hasSandbox = (() => { try { return !!docker('image', 'inspect', 'gense-sandbox:slim') } catch { return false } })()
test('A9: Docker mounts project files read-only; file tools and panel only read the current project', { skip: !hasSandbox, timeout: 120_000 }, async t => {
  const root = await tempDir(), host = await startServer({ ...hostConfig(root), sandbox: { memory: '256m' } })
  t.after(() => host.close())
  const a = await register(host, 'a@example.com'), space = host.spaces.get(a.user.id)!
  const current = await space.projects.create({ name: 'Current' }), other = await space.projects.create({ name: 'Other' })
  for (const project of [current, other]) {
    const upload = await space.workspace.upload('note.txt', Buffer.from(project.name))
    await space.projects.addFiles(project.id, [upload.id])
  }
  const tree = await space.createTree(current.id), own = projectDir(current.id) + '/note.txt', theirs = projectDir(other.id) + '/note.txt'
  let n = 0
  const tool = async (name: string, args: object) => {
    await space.send(tree.id, { text: `[工具 ${name}] ` + JSON.stringify(args), requestId: String(++n) })
    await space.harness.waitForIdle(ctx)
    const { watch } = await space.watch(tree.id); await watch.stop()
    const result = watch.value.entries.filter(entry => entry.kind === 'pi.tool-result').at(-1)!.model![0] as ToolResultMessage
    return { result, text: result.content.flatMap(content => content.type === 'text' ? [content.text] : []).join('\n') }
  }
  assert.match((await tool('read', { path: own })).text, /Current/)
  assert.equal((await tool('read', { path: theirs })).result.isError, true)
  assert.equal((await tool('write', { path: own, content: 'changed' })).result.isError, true)
  assert.equal((await tool('edit', { path: own, edits: [{ oldText: 'Current', newText: 'changed' }] })).result.isError, true)
  assert.equal((await tool('delete', { path: own })).result.isError, true)
  const shell = await tool('bash', { command: `cat '${own}'; cat '${theirs}'; echo changed > '${own}'` })
  assert.match(shell.text, /CurrentOther/); assert.match(shell.text, /Read-only file system/)
  assert.equal(shell.result.isError, true)
  const mounts = JSON.parse(docker('inspect', '-f', '{{json .Mounts}}', host.spaces.sandbox(a.user.id)!.name)) as { Destination: string; RW: boolean }[]
  assert.equal(mounts.find(mount => mount.Destination === '/data/projects')!.RW, false)
  assert.ok((await space.workspace.list(tree.id)).some(file => file.path === own && file.readOnly))
  await assert.rejects(space.workspace.read(tree.id, theirs), /只能查看/)
  await assert.rejects(space.workspace.delete(tree.id, own), /只能修改/)
  await tool('bash', { command: `ln -s '${theirs}' linked-note.txt` })
  assert.equal((await tool('read', { path: 'linked-note.txt' })).result.isError, true)
  await space.updateTree(tree.id, { projectId: null })
  assert.equal((await tool('read', { path: own })).result.isError, true)
  await space.updateTree(tree.id, { projectId: other.id })
  assert.match((await tool('read', { path: theirs })).text, /Other/)
})
