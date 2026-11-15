// Roadmap-7 B1–B6: real host, SQLite, public HTTP and authenticated WebSocket clients.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { Message } from '@earendil-works/pi-ai'
import { SHARE_LIMITS, TEMPORARY_TTL_MS, type ExportInfo, type FileEntry, type LibraryPage, type ShareInfo, type SharedPage, type ShareSnapshot, type TreeMeta, type UserInfo } from '@gense/protocol'
import { unzipSync } from 'fflate'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fauxModels, SESSION_COOKIE, UserSpace } from '../src/index.ts'
import { configFromEnv } from '../src/platform/config.ts'
import { ShareRateLimit } from '../src/platform/shares.ts'
import { startServer } from '../src/platform/server.ts'
import { Client, tempDir } from './host-helpers.ts'
import { diskEnv } from './fixtures.ts'

const config = (root: string) => ({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: root, SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'r7-b-key' }), port: 0 })
async function register(host: Awaited<ReturnType<typeof startServer>>, email: string) {
  const res = await fetch(host.url + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) })
  assert.equal(res.status, 200)
  return { user: (await res.json()).user as UserInfo, cookie: res.headers.get('set-cookie')!.split(';')[0]! }
}
const snapshot = (): ShareSnapshot => ({ title: 'A conversation', turns: [{ question: 'A question', answer: [
  { kind: 'text', text: 'An answer with `code`.' },
  { kind: 'view', uri: 'ui://ui/render', input: { code: 'root = Text("hello")' }, result: { content: 'A view', structuredContent: { version: 1, values: [1, 2] } } },
  { kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'A generated image' },
], sources: [{ url: 'https://example.com/page', title: 'Example' }], createdAt: 100 }] })

test('B1/B2/B3/B4: links preserve an opaque snapshot, sync only to their owner, persist and revoke on tree deletion', async t => {
  const root = await tempDir(), webDir = join(root, 'web')
  await mkdir(webDir); await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">App shell</div>')
  const options = { ...config(root), webDir }
  let host = await startServer(options)
  const clients: Client[] = []
  t.after(async () => { for (const client of clients) client.close(); await host.close() })
  const a = await register(host, 'a@example.com'), b = await register(host, 'b@example.com')
  const first = await Client.connect(host.url, a.cookie), second = await Client.connect(host.url, a.cookie), other = await Client.connect(host.url, b.cookie)
  clients.push(first, second, other)
  await Promise.all(clients.map(c => c.until(() => c.raw.some(raw => JSON.parse(raw).t === 'shares'))))
  const tree = await first.request<TreeMeta>({ t: 'tree.create' }), input = snapshot()
  const share = await first.request<ShareInfo>({ t: 'share.create', treeId: tree.id, snapshot: input })
  assert.match(share.token, /^[a-zA-Z0-9_-]{22}$/); assert.equal(Buffer.from(share.token, 'base64url').length, 16)
  assert.equal(share.turns, 1); assert.equal(share.treeId, tree.id)
  await second.until(() => second.shares.some(link => link.token === share.token)); assert.deepEqual(other.shares, [])
  await assert.rejects(other.request({ t: 'share.create', treeId: tree.id, snapshot: input }), /会话不存在/)
  await assert.rejects(other.request({ t: 'share.update', token: share.token, snapshot: input }), /分享链接不存在/)
  await assert.rejects(other.request({ t: 'share.delete', token: share.token }), /分享链接不存在/)
  const url = host.url + '/api/share/' + share.token
  // A malformed session cookie would throw if this endpoint tried to parse it.
  const publicReply = await fetch(url, { headers: { cookie: `${SESSION_COOKIE}=%`, origin: 'https://reader.example' } })
  assert.equal(publicReply.status, 200); assert.equal(publicReply.headers.get('set-cookie'), null)
  assert.equal(publicReply.headers.get('x-robots-tag'), 'noindex'); assert.equal(publicReply.headers.get('cache-control'), 'no-store')
  assert.equal(publicReply.headers.get('content-type'), 'application/json')
  assert.deepEqual(await publicReply.json(), { ...input, updatedAt: share.updatedAt })
  assert.equal((await host.spaces.get(a.user.id)!.db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shares'")), undefined)
  const db = await openNodeSqliteDatabase(join(root, 'app.sqlite'))
  try { assert.equal((await db.get<{ userId: string }>('SELECT userId FROM shares WHERE token = ?', share.token))!.userId, a.user.id) } finally { await db.close() }
  const shell = await fetch(host.url + '/s/' + share.token)
  assert.equal(shell.status, 200); assert.match(await shell.text(), /App shell/)
  assert.equal(shell.headers.get('x-robots-tag'), 'noindex'); assert.equal(shell.headers.get('referrer-policy'), 'no-referrer')
  assert.equal((await fetch(url, { method: 'POST' })).status, 405)
  await first.request({ t: 'send', treeId: tree.id, text: 'Private later message', requestId: 'later' })
  await host.spaces.get(a.user.id)!.harness.waitForIdle(ctx)
  assert.deepEqual(await (await fetch(url)).json(), { ...input, updatedAt: share.updatedAt }, 'later messages never enter an existing snapshot')
  const replacement = { title: 'Updated title', turns: [{ question: 'Updated question', answer: [{ kind: 'text' as const, text: 'Updated answer' }], createdAt: 200 }] }
  const updated = await first.request<ShareInfo>({ t: 'share.update', token: share.token, snapshot: replacement })
  assert.equal(updated.token, share.token); assert.equal(updated.createdAt, share.createdAt); assert.ok(updated.updatedAt >= share.updatedAt)
  await second.until(() => second.shares.find(link => link.token === share.token)?.title === 'Updated title')
  assert.deepEqual(await (await fetch(url)).json(), { ...replacement, updatedAt: updated.updatedAt })
  const another = await first.request<ShareInfo>({ t: 'share.create', treeId: tree.id, snapshot: input })
  assert.notEqual(another.token, share.token)
  for (const client of clients.splice(0)) client.close()
  await host.close(); host = await startServer(options)
  assert.deepEqual(await (await fetch(host.url + '/api/share/' + share.token)).json(), { ...replacement, updatedAt: updated.updatedAt })
  const reopened = await Client.connect(host.url, a.cookie); clients.push(reopened)
  await reopened.until(() => reopened.shares.length === 2)
  await reopened.request({ t: 'share.delete', token: share.token })
  assert.equal((await fetch(host.url + '/api/share/' + share.token)).status, 404)
  await reopened.request({ t: 'tree.delete', treeId: tree.id })
  assert.equal(reopened.shares.length, 0)
  const revoked = await fetch(host.url + '/api/share/' + another.token)
  assert.equal(revoked.status, 404); assert.equal(revoked.headers.get('x-robots-tag'), 'noindex')
})

test('B1/B2/B4: share schema, UTF-8 byte and turn limits are enforced; only approved inline image prefixes pass', async t => {
  const host = await startServer(config(await tempDir())); t.after(() => host.close())
  const owner = await register(host, 'a@example.com'), client = await Client.connect(host.url, owner.cookie)
  t.after(() => client.close())
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  const create = (input: unknown) => client.request<ShareInfo>({ t: 'share.create', treeId: tree.id, snapshot: input as ShareSnapshot })
  for (const input of [null, {}, { title: 1, turns: [] }, { title: 'x', turns: [{}] }, { title: 'x', turns: [{ question: '', answer: [{ kind: 'thinking', text: 'secret' }], createdAt: 1 }] }, { title: 'x', turns: [{ question: '', answer: [], createdAt: 1, thinking: 'secret' }] }, { title: 'x', turns: [{ question: '', answer: [{ kind: 'view', uri: 'ui://ui/render' }], createdAt: 1 }] }])
    await assert.rejects(create(input), /格式无效/)
  const tooMany = snapshot(); tooMany.turns = Array.from({ length: SHARE_LIMITS.turns + 1 }, () => tooMany.turns[0]!)
  await assert.rejects(create(tooMany), /500 轮/)
  const tooLarge = snapshot(); tooLarge.turns[0]!.answer = [{ kind: 'text', text: '汉'.repeat(Math.floor(SHARE_LIMITS.bytes / 3) + 1) }]
  await assert.rejects(create(tooLarge), /8 MB/)
  for (const src of ['https://example.com/private.png', '/api/users/other/files/private', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,WA==']) {
    const input = snapshot(); input.turns[0]!.answer = [{ kind: 'image', src, alt: '' }]
    await assert.rejects(create(input), /图片必须/)
  }
  for (const mime of ['png', 'jpeg', 'webp', 'gif']) {
    const input = snapshot(); input.turns[0]!.answer = [{ kind: 'image', src: `data:image/${mime};base64,WA==`, alt: '' }]
    await create(input)
  }
  const longTitle = snapshot(); longTitle.title = '题'.repeat(SHARE_LIMITS.title + 10)
  const title = await create(longTitle)
  assert.equal(title.title.length, SHARE_LIMITS.title)
  assert.equal((await (await fetch(host.url + '/api/share/' + title.token)).json() as SharedPage).title.length, SHARE_LIMITS.title)
  await assert.rejects(client.request({ t: 'share.update', token: title.token, snapshot: tooMany }), /500 轮/)
  assert.equal((await (await fetch(host.url + '/api/share/' + title.token)).json() as SharedPage).title, title.title, 'a rejected update preserves the existing snapshot')
  const boundary: ShareSnapshot = { title: 'Boundary', turns: [{ question: '', answer: [{ kind: 'text', text: '' }], createdAt: 0 }] }
  const overhead = Buffer.byteLength(JSON.stringify(boundary))
  boundary.turns[0]!.answer = [{ kind: 'text', text: 'a'.repeat(SHARE_LIMITS.bytes - overhead) }]
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), SHARE_LIMITS.bytes)
  const exact = await create(boundary)
  const response = await fetch(host.url + '/api/share/' + exact.token)
  assert.equal(response.status, 200)
  await response.arrayBuffer()
})

test('B4: public reads are rate limited by socket IP, without trusting forwarded headers', async t => {
  const host = await startServer(config(await tempDir())); t.after(() => host.close())
  const owner = await register(host, 'a@example.com'), client = await Client.connect(host.url, owner.cookie)
  t.after(() => client.close())
  const tree = await client.request<TreeMeta>({ t: 'tree.create' }), share = await client.request<ShareInfo>({ t: 'share.create', treeId: tree.id, snapshot: snapshot() })
  const url = host.url + '/api/share/' + share.token
  for (let i = 0; i < 60; i++) { const response = await fetch(url); assert.equal(response.status, 200); await response.arrayBuffer() }
  const limited = await fetch(url, { headers: { 'x-forwarded-for': '203.0.113.5' } })
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60'); assert.equal(limited.headers.get('x-robots-tag'), 'noindex')
  await limited.arrayBuffer()
  const limit = new ShareRateLimit()
  for (let i = 0; i < 60; i++) assert.equal(limit.allow('one', 100), true)
  assert.equal(limit.allow('one', 100), false); assert.equal(limit.allow('two', 100), true); assert.equal(limit.allow('one', 60_100), true)
})

test('B4: trusted proxy mode buckets the rightmost valid hop; spoofed prefixes cannot reset its limit', async t => {
  assert.equal(configFromEnv({}).trustProxy, false)
  assert.equal(configFromEnv({ GENSE_TRUST_PROXY: '1' }).trustProxy, true)
  const host = await startServer({ ...config(await tempDir()), trustProxy: true }); t.after(() => host.close())
  const owner = await register(host, 'a@example.com'), client = await Client.connect(host.url, owner.cookie)
  t.after(() => client.close())
  const tree = await client.request<TreeMeta>({ t: 'tree.create' }), share = await client.request<ShareInfo>({ t: 'share.create', treeId: tree.id, snapshot: snapshot() })
  const read = async (forwarded?: string) => {
    const response = await fetch(host.url + '/api/share/' + share.token, { headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } })
    await response.arrayBuffer()
    return response.status
  }
  for (let i = 0; i < 60; i++) assert.equal(await read(`198.51.100.${i}, 203.0.113.10`), 200)
  assert.equal(await read('192.0.2.1, 203.0.113.10'), 429, 'a forged earlier hop is ignored')
  assert.equal(await read('192.0.2.1, 203.0.113.11'), 200, 'another actual client has its own budget')
  assert.equal(await read('192.0.2.1,  2001:db8::1 '), 200, 'IPv6 is valid')
  for (let i = 0; i < 60; i++) assert.equal(await read(`203.0.113.${i}, invalid`), 200)
  assert.equal(await read(), 429, 'invalid or absent forwarded IPs use the same socket bucket')
})

test('B5: temporary roots, inherited forks and empty regenerated branches never read or offer memory', async t => {
  const models = fauxModels(), requests: { sections: Record<string, string>; tools: Set<string> }[] = []
  const provider = models.providers[0] as unknown as Record<'stream' | 'streamSimple', (model: unknown, context: { messages: Message[] }, options: unknown) => unknown>
  for (const key of ['stream', 'streamSimple'] as const) {
    const original = provider[key].bind(provider)
    provider[key] = (model, context, options) => {
      const sections: Record<string, string> = {}, tools = new Set<string>()
      for (const message of context.messages) if (message.role === 'system') {
        for (const [name, text] of Object.entries(message.sections ?? {})) { if (text === null) delete sections[name]; else sections[name] = text }
        for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
        for (const tool of message.toolsAdded ?? []) tools.add(tool.name)
      }
      requests.push({ sections, tools })
      return original(model, context, options)
    }
  }
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models, env: await diskEnv() })
  t.after(() => space.close())
  await space.memories.add({ text: 'A stable remembered preference' })
  const tree = await space.createTree(undefined, ctx, true)
  let n = 0
  const ask = async (text: string, branchId?: string) => { await space.send(tree.id, { text, requestId: String(++n), ...(branchId && { branchId }) }); await space.harness.waitForIdle(ctx) }
  await ask('Temporary first message')
  const { watch, branchId } = await space.watch(tree.id); await watch.stop()
  const first = watch.value.entries.find(entry => entry.kind === 'pi.user')!
  const fork = await space.fork(tree.id, branchId, first.id)
  await ask('Inherited fork', fork.id)
  const regenerated = await space.regenerate(tree.id, branchId, first.id, { requestId: 'empty-regenerated' })
  await space.harness.waitForIdle(ctx)
  await space.preferences.set({ memoryWrites: 'explicit' })
  await ask('[工具 memory] {"action":"add","text":"Temporary secret must not be saved"}', regenerated.id)
  assert.ok(requests.length >= 4)
  for (const request of requests) {
    assert.equal(request.sections.memory, undefined); assert.equal(request.tools.has('memory'), false)
    assert.doesNotMatch(JSON.stringify(request.sections), /A stable remembered preference/)
  }
  assert.deepEqual((await space.memories.list()).map(entry => entry.text), ['A stable remembered preference'])
  const resolved = await (await space.open((await space.branchRow(tree.id, regenerated.id)).branch, ctx)).agent(ctx)
  assert.ok(!resolved.callable.some(tool => tool.name === 'memory'), 'nested tools cannot call memory either')
})

test('B5: temporary metadata synchronizes, stays out of search and rejects projects, shares, memory and automations', async t => {
  const host = await startServer(config(await tempDir())); t.after(() => host.close())
  const owner = await register(host, 'a@example.com'), first = await Client.connect(host.url, owner.cookie), second = await Client.connect(host.url, owner.cookie)
  t.after(() => { first.close(); second.close() })
  const project = await host.spaces.get(owner.user.id)!.projects.create({ name: 'A project' })
  await assert.rejects(first.request({ t: 'tree.create', temporary: true, projectId: project.id }), /临时对话不能放进项目/)
  await assert.rejects(first.request({ t: 'tree.create', temporary: 'yes' } as never), /临时对话开关无效/)
  const temporary = await first.request<TreeMeta>({ t: 'tree.create', temporary: true })
  assert.equal(temporary.temporary!.expiresAt, temporary.createdAt + TEMPORARY_TTL_MS)
  await second.until(() => second.trees.some(tree => tree.id === temporary.id && tree.temporary?.expiresAt === temporary.temporary!.expiresAt))
  await first.request({ t: 'tree.update', treeId: temporary.id, title: 'temporary-search-sentinel' })
  await first.request({ t: 'send', treeId: temporary.id, text: 'temporary-search-sentinel', requestId: 'search' })
  await host.spaces.get(owner.user.id)!.harness.waitForIdle(ctx)
  assert.deepEqual(await first.request({ t: 'trees.search', query: 'temporary-search-sentinel' }), [])
  for (const projectId of [project.id, null]) await assert.rejects(first.request({ t: 'tree.update', treeId: temporary.id, projectId }), /临时对话不能放进项目/)
  await assert.rejects(first.request({ t: 'share.create', treeId: temporary.id, snapshot: snapshot() }), /临时对话不能分享/)
  await assert.rejects(first.request({ t: 'memory.add', treeId: temporary.id, source: 'saved', text: 'One-time facts' }), /临时对话不能写入记忆/)
  await assert.rejects(first.request({ t: 'schedule.create', treeId: temporary.id, name: 'Reminder', prompt: 'Wake', rule: { kind: 'interval', minutes: 5 }, tz: 'UTC' }), /临时对话不能创建定时任务/)
  await assert.rejects(first.request({ t: 'webhook.create', treeId: temporary.id }), /临时对话不能创建 Webhook/)
})

test('B5/B6: deletion and expiry make temporary content unreachable through content lists, files, shares and memory', async t => {
  const root = await tempDir(), host = await startServer(config(root)); t.after(() => host.close())
  const owner = await register(host, 'a@example.com'), client = await Client.connect(host.url, owner.cookie), second = await Client.connect(host.url, owner.cookie)
  t.after(() => { client.close(); second.close() })
  const space = host.spaces.get(owner.user.id)!, db = await openNodeSqliteDatabase(join(root, 'app.sqlite'))
  t.after(() => db.close())
  let n = 0
  for (const mode of ['delete', 'expire'] as const) {
    const marker = 'temporary-private-sentinel-' + mode
    const tree = await client.request<TreeMeta>({ t: 'tree.create', temporary: true })
    await client.request({ t: 'tree.update', treeId: tree.id, title: marker })
    await client.request({ t: 'watch', treeId: tree.id })
    const branchId = client.shown.get(tree.id)!
    await client.request({ t: 'send', treeId: tree.id, text: marker, requestId: String(++n) }); await space.harness.waitForIdle(ctx)
    await client.request({ t: 'send', treeId: tree.id, text: '[工具 write] ' + JSON.stringify({ path: marker + '.txt', content: marker }), requestId: String(++n) }); await space.harness.waitForIdle(ctx)
    const path = (await client.request<FileEntry[]>({ t: 'files.list', treeId: tree.id })).find(file => !file.readOnly && file.path.includes(marker))!.path
    const activity = async () => {
      const page = await client.request<LibraryPage>({ t: 'library.list', limit: 200 })
      assert.ok(!page.items.some(item => item.treeId === tree.id)); assert.ok(!JSON.stringify(page).includes(marker))
      const exported = await client.request<ExportInfo>({ t: 'export.create' })
      const done = exported.status === 'running' ? await client.until(() => client.exports.find(item => item.id === exported.id && item.status !== 'running'), 60_000, 'export completion') : exported
      assert.equal(done.status, 'ready', done.error)
      const response = await fetch(host.url + '/api/exports/' + done.id, { headers: { cookie: owner.cookie } })
      assert.equal(response.status, 200)
      for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(await response.arrayBuffer())))) {
        assert.ok(!name.includes(marker)); assert.ok(!Buffer.from(bytes).includes(Buffer.from(marker)), name)
      }
      await client.request({ t: 'export.delete', exportId: done.id })
    }
    await activity() // Check the real library and archive while the temporary tree is still alive.
    const token = randomBytes(16).toString('base64url')
    const stale: ShareSnapshot = { title: marker, turns: [{ question: marker, answer: [], createdAt: Date.now() }] }
    // An invalid legacy/direct-database share must be revoked too; the public creation API already refuses it.
    await db.run('INSERT INTO shares (token, userId, treeId, title, snapshot, turns, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?)', token, owner.user.id, tree.id, marker, JSON.stringify(stale), Date.now(), Date.now())
    assert.equal((await fetch(host.url + '/api/share/' + token)).status, 200)
    if (mode === 'delete') await second.request({ t: 'tree.delete', treeId: tree.id })
    else {
      await space.db.run('UPDATE trees SET expiresAt = ? WHERE id = ?', Date.now() - 1, tree.id)
      await Promise.all([space.cleanupTemporary(), space.cleanupTemporary()])
    }
    await client.until(() => !client.trees.some(item => item.id === tree.id))
    await assert.rejects(access(join(root, 'users', owner.user.id, 'files', 'sessions', tree.id)))
    const triggers = await client.request({ t: 'triggers.list', channelId: 'web' }), uploads = await client.request({ t: 'uploads' })
    const lists = { trees: client.trees, projects: client.projects, memories: client.memories, shares: client.shares, schedules: client.schedules, webhooks: client.webhooks, triggers, uploads }
    assert.ok(!JSON.stringify(lists).includes(marker)); assert.ok(!JSON.stringify(lists).includes(tree.id))
    assert.deepEqual(await client.request({ t: 'trees.search', query: marker }), [])
    for (const request of [
      { t: 'watch', treeId: tree.id }, { t: 'files.list', treeId: tree.id }, { t: 'files.read', treeId: tree.id, path }, { t: 'files.preview', treeId: tree.id, path },
      { t: 'send', treeId: tree.id, text: 'continue', requestId: String(++n) }, { t: 'share.create', treeId: tree.id, snapshot: snapshot() },
      { t: 'memory.add', source: 'saved', treeId: tree.id, text: marker }, { t: 'branch.fork', treeId: tree.id, branchId, at: 1 },
    ] as const) await assert.rejects(client.request(request), /会话不存在/)
    const fileResponse = await fetch(host.url + `/api/users/${owner.user.id}/files/${tree.id}?path=` + encodeURIComponent(path), { headers: { cookie: owner.cookie } })
    assert.equal(fileResponse.status, 404)
    assert.equal((await fetch(host.url + '/api/share/' + token)).status, 404)
    await activity()
    const usage = await fetch(host.url + '/api/admin/usage', { headers: { cookie: owner.cookie } })
    assert.equal(usage.status, 200); assert.ok(!JSON.stringify(await usage.json()).includes(marker), 'usage retains metering without message content')
  }
})

test('B6: startup removes an expired unfinished temporary run before recovery and retains live trees', { timeout: 60_000 }, async t => {
  const root = await tempDir(), options = config(root)
  let host = await startServer(options)
  const clients: Client[] = []
  t.after(async () => { for (const client of clients) client.close(); await host.close() })
  const owner = await register(host, 'a@example.com'), client = await Client.connect(host.url, owner.cookie); clients.push(client)
  const tree = await client.request<TreeMeta>({ t: 'tree.create', temporary: true }), space = host.spaces.get(owner.user.id)!
  const liveTemporary = await client.request<TreeMeta>({ t: 'tree.create', temporary: true }), permanent = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  await client.request({ t: 'send', treeId: tree.id, text: '[长回答] temporary-running-sentinel', requestId: 'running' })
  await client.until(() => client.branches.get(tree.id)?.branches.some(branch => branch.status === 'running'))
  await space.db.run('UPDATE trees SET expiresAt = ? WHERE id = ?', Date.now() - 1, tree.id)
  client.close(); await host.close()
  host = await startServer(options)
  const reopened = await Client.connect(host.url, owner.cookie); clients.push(reopened)
  await reopened.until(() => reopened.trees.length === 2)
  assert.ok(!reopened.trees.some(item => item.id === tree.id))
  assert.equal(reopened.trees.find(item => item.id === liveTemporary.id)!.temporary!.expiresAt, liveTemporary.temporary!.expiresAt)
  assert.ok(reopened.trees.some(item => item.id === permanent.id && !item.temporary))
  await assert.rejects(reopened.request({ t: 'watch', treeId: tree.id }), /会话不存在/)
  await assert.rejects(access(join(root, 'users', owner.user.id, 'files', 'sessions', tree.id)))
  await host.spaces.get(owner.user.id)!.harness.waitForIdle(ctx)
})
