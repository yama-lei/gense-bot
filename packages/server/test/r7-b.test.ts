// Roadmap-7 B1–B6: real host, SQLite, public HTTP and authenticated WebSocket clients.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { SHARE_LIMITS, type ShareInfo, type SharedPage, type ShareSnapshot, type TreeMeta, type UserInfo } from '@gense/protocol'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { SESSION_COOKIE } from '../src/index.ts'
import { configFromEnv } from '../src/platform/config.ts'
import { ShareRateLimit } from '../src/platform/shares.ts'
import { startServer } from '../src/platform/server.ts'
import { Client, tempDir } from './host-helpers.ts'

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
  const boundary: ShareSnapshot = { title: 'Boundary', turns: [{ question: '', answer: [{ kind: 'text', text: '' }], createdAt: 0 }] }
  const overhead = Buffer.byteLength(JSON.stringify(boundary))
  boundary.turns[0]!.answer = [{ kind: 'text', text: 'a'.repeat(SHARE_LIMITS.bytes - overhead) }]
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), SHARE_LIMITS.bytes)
  const exact = await create(boundary)
  assert.equal((await fetch(host.url + '/api/share/' + exact.token)).status, 200)
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
