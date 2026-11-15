// D1–D10: two real accounts, SQLite spaces, HTTP/WebSocket clients, local MCP/Feishu and Docker where available.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import type { SharedProviderInfo, TreeMeta, UploadedFile, UserInfo, UsageReport, WebhookInfo, ScheduleInfo } from '@gense/protocol'
import { strToU8, zipSync } from 'fflate'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, rename, symlink, writeFile, access } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import WebSocket from 'ws'
import { Auth, hmac, fauxModels, UserSpace } from '../src/index.ts'
import { configFromEnv } from '../src/platform/config.ts'
import { startServer } from '../src/platform/server.ts'
import { importOwner } from '../src/platform/import-owner.ts'
import { userDir } from '../src/platform/spaces.ts'
import { Client, tempDir, textOf } from './host-helpers.ts'
import { mcpPlatform } from './mcp-platform.ts'
import { diskEnv } from './fixtures.ts'
import { feishuPlatform } from './feishu-platform.ts'

const PASSWORD = 'correct horse battery'
const config = (root: string) => ({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: root, SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'multi-user-key', PUBLIC_URL: 'http://localhost:8787' }), port: 0 })
type Host = Awaited<ReturnType<typeof startServer>>
async function api(host: Host, path: string, cookie?: string, method = 'GET', body?: unknown) {
  return fetch(host.url + path, { method, headers: { ...(cookie && { cookie }), ...(body !== undefined && { 'content-type': 'application/json' }) }, ...(body !== undefined && { body: JSON.stringify(body) }) })
}
async function register(host: Host, email: string) {
  const res = await api(host, '/api/register', undefined, 'POST', { email, password: PASSWORD })
  assert.equal(res.status, 200, await res.clone().text())
  return { user: (await res.json()).user as UserInfo, cookie: res.headers.get('set-cookie')!.split(';')[0]! }
}
async function login(host: Host, email: string) {
  const res = await api(host, '/api/login', undefined, 'POST', { email, password: PASSWORD })
  assert.equal(res.status, 200)
  return res.headers.get('set-cookie')!.split(';')[0]!
}
async function until(check: () => boolean | Promise<boolean>, label = 'condition', timeout = 10_000) {
  const end = Date.now() + timeout
  while (!(await check())) { if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(r => setTimeout(r, 20)) }
}
async function pair(host: Host) {
  const a = await register(host, 'a@example.com'), b = await register(host, 'b@example.com')
  return { a, b }
}

test('D1/D7: first admin, normalized email, closed registration, password/logout, disabled sessions and admin recovery', async t => {
  const host = await startServer(config(await tempDir())); t.after(() => host.close())
  const { a, b } = await pair(host)
  assert.equal(a.user.role, 'admin'); assert.equal(b.user.role, 'user')
  assert.equal((await api(host, '/api/me')).status, 401)
  assert.equal((await (await api(host, '/api/me', b.cookie)).json()).user.id, b.user.id)
  assert.equal((await api(host, '/api/register', undefined, 'POST', { email: ' A@EXAMPLE.COM ', password: PASSWORD })).status, 400)
  assert.equal((await api(host, '/api/register', undefined, 'POST', { email: 'broken', password: PASSWORD })).status, 400)
  assert.equal((await api(host, '/api/register', undefined, 'POST', { email: 'new@example.com', password: 'short' })).status, 400)
  for (const [path, method, body] of [
    ['/api/admin/users', 'GET'], ['/api/admin/users/' + a.user.id, 'PATCH', { role: 'admin' }],
    ['/api/admin/providers', 'GET'], ['/api/admin/providers', 'POST', {}], ['/api/admin/providers/other', 'PUT', {}], ['/api/admin/providers/other', 'DELETE'],
    ['/api/admin/registration', 'GET'], ['/api/admin/registration', 'PUT', { open: false }], ['/api/admin/usage', 'GET'],
  ] as const) assert.equal((await api(host, path, b.cookie, method, body)).status, 403, path)
  const csrf = await fetch(host.url + '/api/admin/registration', { method: 'PUT', headers: { cookie: a.cookie, origin: 'https://evil.example' }, body: '{"open":false}' })
  assert.equal(csrf.status, 403)
  assert.equal((await api(host, '/api/admin/registration', a.cookie, 'PUT', { open: false })).status, 200)
  assert.deepEqual(await (await api(host, '/api/registration')).json(), { open: false })
  assert.match(await (await api(host, '/api/register', undefined, 'POST', { email: 'c@example.com', password: PASSWORD })).text(), /暂不开放/)
  const secondB = await login(host, ' B@EXAMPLE.COM ')
  const ws = new WebSocket(host.url.replace('http', 'ws') + '/ws', { headers: { cookie: b.cookie } }); await once(ws, 'open')
  const closed = once(ws, 'close')
  const change = await api(host, '/api/password', b.cookie, 'POST', { current: PASSWORD, next: 'a new password' })
  assert.equal(change.status, 200); await closed
  assert.equal((await api(host, '/api/me', secondB)).status, 401)
  assert.equal((await api(host, '/api/me', a.cookie)).status, 200, 'password change only revokes that user')
  const fresh = change.headers.get('set-cookie')!.split(';')[0]!
  assert.equal((await api(host, '/api/logout', fresh, 'POST')).status, 200)
  assert.equal((await api(host, '/api/me', fresh)).status, 401)
  assert.equal((await api(host, '/api/admin/users/' + b.user.id, a.cookie, 'PATCH', { disabled: true })).status, 200)
  assert.equal(host.spaces.get(b.user.id), undefined)
  assert.equal((await api(host, '/api/login', undefined, 'POST', { email: b.user.email, password: 'a new password' })).status, 401)
  assert.equal((await api(host, '/api/admin/users/' + b.user.id, a.cookie, 'PATCH', { disabled: false, role: 'admin' })).status, 200)
  assert.ok(host.spaces.get(b.user.id))
  const bAdmin = await api(host, '/api/login', undefined, 'POST', { email: b.user.email, password: 'a new password' })
  assert.equal((await api(host, '/api/admin/users', bAdmin.headers.get('set-cookie')!.split(';')[0])).status, 200)
  assert.ok(!(await (await api(host, '/api/admin/users', a.cookie)).text()).includes('password'))
})

test('D1: concurrent first registrations choose exactly one admin; login throttles one email without blocking another', async () => {
  const db = await openNodeSqliteDatabase(':memory:'), auth = await Auth.open(db)
  try {
    const users = await Promise.all([auth.register('first@example.com', PASSWORD), auth.register('second@example.com', PASSWORD)])
    assert.equal(users.filter(u => u.role === 'admin').length, 1)
    for (let i = 0; i < 5; i++) await assert.rejects(auth.login(users[0]!.email, 'wrong'))
    await assert.rejects(auth.login(users[0]!.email, PASSWORD), /尝试次数/)
    assert.ok(await auth.login(users[1]!.email, PASSWORD))
    const admin = users.find(u => u.role === 'admin')!
    await assert.rejects(auth.updateUser(admin.id, { disabled: true }), /至少保留/)
  } finally { await db.close() }
})

test('D2/D4: A’s session cannot read or mutate B’s resources through WS, HTTP, webhook, OAuth or MCP Apps', async t => {
  const remote = await mcpPlatform(true); t.after(() => remote.close())
  const root = await tempDir(), host = await startServer(config(root)); t.after(() => host.close())
  const { a, b } = await pair(host), ac = await Client.connect(host.url, a.cookie), bc = await Client.connect(host.url, b.cookie)
  t.after(() => { ac.close(); bc.close() })
  const at = await ac.request<TreeMeta>({ t: 'tree.create' }), bt = await bc.request<TreeMeta>({ t: 'tree.create' })
  const bspace = host.spaces.get(b.user.id)!, aspace = host.spaces.get(a.user.id)!
  const upload = await bc.request<UploadedFile>({ t: 'upload', name: 'private.txt', base64: Buffer.from('B private file').toString('base64') })
  await bc.request({ t: 'send', treeId: bt.id, text: 'secret conversation', requestId: 'secret', attachments: [upload.id] })
  await bspace.harness.waitForIdle(ctx)
  const schedule = await bc.request<ScheduleInfo>({ t: 'schedule.create', treeId: bt.id, name: 'B task', prompt: 'private', rule: { kind: 'interval', minutes: 60 }, tz: 'UTC' })
  const hook = await bc.request<{ webhook: WebhookInfo; secret: string }>({ t: 'webhook.create', treeId: bt.id })
  const zip = zipSync({ 'private-skill/SKILL.md': strToU8('---\nname: private-skill\ndescription: A private B skill.\n---\nPrivate B instructions.') })
  const archive = await bc.request<UploadedFile>({ t: 'upload', name: 'private-skill.zip', base64: Buffer.from(zip).toString('base64') })
  await bc.request({ t: 'skill.install', source: { upload: archive.id } })
  const plugin = await bc.request<{ id: string }>({ t: 'mcp.add', name: 'B MCP', url: remote.url })
  const authUrl = await bc.request<{ url: string }>({ t: 'mcp.auth', pluginId: plugin.id }), oauth = new URL(authUrl.url)
  remote.state.challenge = oauth.searchParams.get('code_challenge')!
  const callback = `/api/users/${b.user.id}/mcp/callback?state=${oauth.searchParams.get('state')}&code=ok`
  assert.equal(oauth.searchParams.get('redirect_uri'), `http://localhost:8787/api/users/${b.user.id}/mcp/callback`)
  const badRequests = [
    { t: 'watch', treeId: bt.id }, { t: 'tree.update', treeId: bt.id, title: 'stolen' }, { t: 'tree.delete', treeId: bt.id },
    { t: 'send', treeId: bt.id, text: 'cross', requestId: 'cross' }, { t: 'abort', treeId: bt.id },
    { t: 'files.list', treeId: bt.id }, { t: 'files.read', treeId: bt.id, path: 'attachments/private.txt' }, { t: 'files.preview', treeId: bt.id, path: 'attachments/private.txt' }, { t: 'files.delete', treeId: bt.id, path: 'attachments/private.txt' },
    { t: 'files.read', treeId: at.id, path: `/data/sessions/${bt.id}/attachments/private.txt` },
    { t: 'send', treeId: at.id, text: 'cross upload', requestId: 'upload', attachments: [upload.id] },
    { t: 'schedule.update', scheduleId: schedule.id, enabled: false }, { t: 'schedule.delete', scheduleId: schedule.id }, { t: 'webhook.delete', webhookId: hook.webhook.id }, { t: 'webhook.create', treeId: bt.id },
    { t: 'skill.read', name: 'private-skill', path: 'SKILL.md' }, { t: 'skill.set', name: 'private-skill', enabled: false }, { t: 'skill.remove', name: 'private-skill' },
    { t: 'mcp.auth', pluginId: plugin.id }, { t: 'mcp.update', pluginId: plugin.id, name: 'stolen' }, { t: 'mcp.remove', pluginId: plugin.id },
    { t: 'plugin.set', pluginId: plugin.id, enabled: false }, { t: 'resource.read', pluginId: plugin.id, uri: 'ui://local/view' },
    { t: 'tool.call', treeId: at.id, pluginId: plugin.id, name: 'tool_0', args: { query: 'cross' } },
    { t: 'tool.call', treeId: bt.id, pluginId: 'artifact', name: 'artifact_save', args: { title: 'cross', type: 'markdown', content: 'no' } },
  ]
  for (const request of badRequests) await assert.rejects(ac.request(request as Parameters<Client['request']>[0]), /.+/, request.t)
  assert.equal((await api(host, callback, a.cookie)).status, 403)
  assert.equal((await api(host, callback)).status, 401)
  assert.equal((await api(host, callback, b.cookie)).status, 200)
  assert.match((await bc.request<{ html: string }>({ t: 'resource.read', pluginId: plugin.id, uri: 'ui://local/view' })).html, /weather/)
  assert.match((await bc.request<{ content: string }>({ t: 'tool.call', treeId: bt.id, pluginId: plugin.id, name: 'tool_0', args: { query: 'B app' } })).content, /B app/)
  assert.equal((await api(host, callback, b.cookie)).status, 400, 'single use')
  assert.equal((await api(host, `/api/users/${b.user.id}/files/${bt.id}?path=attachments/private.txt`, a.cookie)).status, 403)
  const file = await api(host, `/api/users/${b.user.id}/files/${bt.id}?path=attachments/private.txt`, b.cookie)
  assert.equal(file.status, 200); assert.equal(await file.text(), 'B private file')
  const body = '{"title":"B hook"}', timestamp = String(Math.floor(Date.now() / 1000)), signature = await hmac(hook.secret, `${timestamp}.${body}`)
  const call = (path: string, cookie?: string) => fetch(host.url + path, { method: 'POST', headers: { 'x-gense-timestamp': timestamp, 'x-gense-signature': `sha256=${signature}`, ...(cookie && { cookie }) }, body })
  assert.equal((await call(hook.webhook.path, a.cookie)).status, 403)
  assert.equal((await call(hook.webhook.path.replace(b.user.id, a.user.id), a.cookie)).status, 404)
  assert.equal((await call(hook.webhook.path)).status, 202)
  await ac.request({ t: 'channel.set', channelId: 'feishu', values: { appId: 'cli_1111111111111111' }, secrets: { appSecret: 'a-secret' } })
  await bc.request({ t: 'channel.set', channelId: 'feishu', values: { appId: 'cli_2222222222222222' }, secrets: { appSecret: 'b-secret' } })
  await ac.request({ t: 'channel.allow', channelId: 'feishu', actorId: 'a-actor', name: 'A' })
  await bc.request({ t: 'channel.allow', channelId: 'feishu', actorId: 'b-actor', name: 'B' })
  assert.deepEqual(aspace.channels.list()[0]!.actors.map(a => a.id), ['a-actor'])
  assert.deepEqual(bspace.channels.list()[0]!.actors.map(a => a.id), ['b-actor'])
  const skill = aspace.skills.list().find(s => !s.plugin)!.name
  await ac.request({ t: 'skill.set', name: skill, enabled: false })
  assert.equal(bspace.skills.list().find(s => s.name === skill)!.enabled, true)
  await ac.request({ t: 'plugin.set', pluginId: 'web', enabled: false })
  assert.equal(bspace.plugins.list().find(p => p.id === 'web')!.enabled, true)
  const keyLogin = bc.request({ t: 'auth.login', loginId: 'byok', provider: 'mistral', type: 'api_key' })
  const prompt = await bc.until(() => [...bc.prompts].find(([, p]) => p.loginId === 'byok'))
  await bc.request({ t: 'auth.answer', promptId: prompt[0], value: 'B-private-key' }); await keyLogin
  await bc.until(() => bc.models.some(m => m.provider === 'mistral' && m.source === 'byok'))
  assert.ok(!(await aspace.accounts.list()).some(m => m.provider === 'mistral'))
  await assert.rejects(ac.request({ t: 'send', treeId: at.id, text: 'B model', requestId: 'byok', model: bc.models.find(m => m.provider === 'mistral')! }), /不可用/)
  assert.equal((await ac.request<UploadedFile[]>({ t: 'uploads' })).length, 0)
  assert.equal((await ac.request<unknown[]>({ t: 'triggers.list', channelId: 'feishu' })).length, 0)
  assert.ok(!ac.trees.some(tree => tree.id === bt.id)); assert.ok(!ac.schedules.some(s => s.id === schedule.id)); assert.ok(!ac.raw.join('').includes('B-private-key'))
  // A container can write a symlink pointing at a host path. Host downloads and tools must reject it.
  const link = join(userDir(root, a.user.id), 'files', 'sessions', at.id, 'escape')
  await symlink(join(userDir(root, b.user.id), 'files', 'sessions', bt.id, 'attachments', 'private.txt'), link)
  await assert.rejects(ac.request({ t: 'files.read', treeId: at.id, path: 'escape' }), /超出/)
  await assert.rejects(ac.request({ t: 'files.preview', treeId: at.id, path: 'escape' }), /超出/)
  assert.equal((await api(host, `/api/users/${a.user.id}/files/${at.id}?path=escape`, a.cookie)).status, 404)
  const missing = join(userDir(root, b.user.id), 'files', 'new-private-file.txt')
  await symlink(missing, join(userDir(root, a.user.id), 'files', 'sessions', at.id, 'dangling'))
  await aspace.send(at.id, { text: '[工具 write] {"path":"dangling","content":"cross-user write"}', requestId: 'dangling-write' })
  await aspace.harness.waitForIdle(ctx)
  await assert.rejects(access(missing), /ENOENT/)
  const { watch } = await aspace.watch(at.id); await watch.stop()
  const deniedWrite = watch.value.entries.findLast(e => e.kind === 'pi.tool-result')?.model?.[0]
  assert.ok(deniedWrite?.role === 'toolResult' && deniedWrite.isError)
  const race = join(userDir(root, a.user.id), 'files', 'sessions', at.id, 'race.txt')
  const candidate = race + '.next'
  await writeFile(race, 'A data')
  let stop = false
  const swapping = (async () => {
    while (!stop) {
      await symlink(join(userDir(root, b.user.id), 'files', 'sessions', bt.id, 'attachments', 'private.txt'), candidate)
      await rename(candidate, race)
      await writeFile(candidate, 'A data')
      await rename(candidate, race)
    }
  })()
  try {
    for (let i = 0; i < 40; i++) {
      const result = await (await aspace.workspace.env('/data')).readBinaryFile(`/data/sessions/${at.id}/race.txt`, ctx)
      if (result.ok) assert.equal(Buffer.from(result.value).toString(), 'A data', 'even a simultaneous symlink swap cannot read B')
    }
  } finally { stop = true; await swapping }
  assert.equal(Buffer.from((await aspace.workspace.read(at.id, 'race.txt')).base64, 'base64').toString(), 'A data')
  assert.equal((await bspace.row(bt.id)).id, bt.id)
  assert.equal((await bspace.scheduleRow(schedule.id)).enabled, 1)
})

/** A local OpenAI Responses service: real HTTP/SSE, authentication and token usage. */
async function modelPlatform() {
  const keys: string[] = [], models: string[] = []
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    const request = JSON.parse(body); keys.push(String(req.headers.authorization)); models.push(request.model)
    const response = { id: 'resp-' + keys.length, status: 'completed', output: [], usage: { input_tokens: 13, output_tokens: 7, total_tokens: 20, input_tokens_details: { cached_tokens: 3 } } }
    const item = { type: 'message', id: 'msg-' + keys.length, role: 'assistant', content: [{ type: 'output_text', text: 'Shared answer', annotations: [] }], status: 'completed' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'response.created', response: { ...response, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Shared answer' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { ...response, output: [item] } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { keys, models, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

test('D3/D4/D5: shared-provider changes refresh every picker; real calls use sealed keys and record shared/BYOK tokens', async t => {
  const remote = await modelPlatform(), root = await tempDir()
  const production = configFromEnv({ PROVIDER_BASE_URL: remote.url, PROVIDER_AUTH_TOKEN: 'obsolete-environment-key', DEFAULT_PROVIDER_MODEL: 'obsolete-model' })
  const host = await startServer({ ...config(root), models: production.models })
  t.after(async () => { await host.close(); await remote.close() })
  const { a, b } = await pair(host), ac = await Client.connect(host.url, a.cookie), bc = await Client.connect(host.url, b.cookie)
  t.after(() => { ac.close(); bc.close() })
  await bc.until(() => bc.raw.some(m => JSON.parse(m).t === 'models'))
  assert.deepEqual(bc.models, [], 'PROVIDER_* no longer supplies model credentials')
  const created = await api(host, '/api/admin/providers', a.cookie, 'POST', { kind: 'openai', name: 'Team', baseUrl: remote.url, apiKey: 'team-private-key', modelIds: ['team-model'] })
  assert.equal(created.status, 200, await created.clone().text())
  const provider = await created.json() as SharedProviderInfo
  assert.equal(provider.hasKey, true); assert.ok(!JSON.stringify(provider).includes('team-private-key'))
  const chosen = await bc.until(() => bc.models.find(m => m.provider === provider.id))
  await bc.request({ t: 'prefs.set', suggestions: false })
  assert.equal(chosen.source, 'shared'); await ac.until(() => ac.models.some(m => m.provider === provider.id))
  const tree = await bc.request<TreeMeta>({ t: 'tree.create' }); await bc.request({ t: 'watch', treeId: tree.id })
  await bc.request({ t: 'send', treeId: tree.id, text: 'shared call', requestId: 'shared', model: chosen })
  await bc.until(() => bc.views.get(tree.id)?.entries.find(e => e.kind === 'pi.assistant' && textOf(e) === 'Shared answer'))
  assert.deepEqual(remote.keys, ['Bearer team-private-key'])
  // The complete path is also used by context compaction and must be metered exactly once.
  const bspace = host.spaces.get(b.user.id)!, model = bspace.accounts.models.getModel(provider.id, chosen.id)!
  await bspace.accounts.models.completeSimple(model, { messages: [{ role: 'user', content: 'summary', timestamp: Date.now() }] })
  const keyLogin = bc.request({ t: 'auth.login', loginId: 'key', provider: 'mistral', type: 'api_key' })
  const prompt = await bc.until(() => [...bc.prompts].find(([, p]) => p.loginId === 'key'))
  await bc.request({ t: 'auth.answer', promptId: prompt[0], value: 'personal-key' }); await keyLogin
  // Use the supported faux model service behind the user's credential resolver; no mocked objects or storage.
  const faux = fauxProvider({ provider: 'mistral', models: [{ id: 'personal-model' }] })
  const reply = fauxAssistantMessage('Personal answer')
  reply.usage = { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  faux.setResponses([reply])
  const credentialAuth = bspace.accounts.models.getProvider('mistral')!.auth
  bspace.accounts.models.setProvider({ ...faux.provider, auth: credentialAuth })
  assert.equal((await bspace.accounts.models.getAuth(faux.getModel()))?.auth.apiKey, 'personal-key')
  const personal = await bspace.accounts.models.completeSimple(faux.getModel(), { messages: [{ role: 'user', content: 'personal', timestamp: Date.now() }] })
  const totals = ((await (await api(host, '/api/admin/usage', a.cookie)).json()) as UsageReport).models
  const shared = totals.find(row => row.provider === provider.id)!, byok = totals.find(row => row.source === 'byok')!
  assert.equal(shared.userId, b.user.id); assert.equal(shared.email, b.user.email); assert.equal(shared.calls, 2)
  assert.deepEqual([shared.input, shared.output, shared.cacheRead, shared.totalTokens], [20, 14, 6, 40])
  assert.equal(byok.userId, b.user.id); assert.equal(byok.calls, 1); assert.equal(byok.totalTokens, personal.usage.totalTokens); assert.ok(byok.totalTokens > 0)
  assert.equal((await api(host, '/api/admin/usage?from=invalid', a.cookie)).status, 400)
  assert.deepEqual(await (await api(host, '/api/admin/usage?from=2099-01-01&to=2099-01-02', a.cookie)).json(), { models: [], services: [] })
  assert.equal((await api(host, '/api/admin/providers/' + provider.id, a.cookie, 'PUT', { kind: 'openai', name: 'Updated', baseUrl: remote.url, modelIds: ['new-model'] })).status, 200)
  await bc.until(() => bc.models.some(m => m.provider === provider.id && m.id === 'new-model') && !bc.models.some(m => m.id === 'team-model'))
  assert.ok(!ac.raw.join('').includes('team-private-key')); assert.ok(!bc.raw.join('').includes('team-private-key'))
  const stored = await openNodeSqliteDatabase(join(root, 'app.sqlite'))
  try {
    const row = await stored.get<{ sealed: string }>('SELECT sealed FROM shared_providers WHERE id = ?', provider.id)
    assert.ok(row?.sealed && !row.sealed.includes('team-private-key'))
  } finally { await stored.close() }
  const bytes = await readFile(join(root, 'app.sqlite'))
  assert.ok(!bytes.includes(Buffer.from('team-private-key')), 'the app database never stores plaintext provider keys')
  assert.equal((await api(host, '/api/admin/providers/' + provider.id, a.cookie, 'DELETE')).status, 200)
  await bc.until(() => !bc.models.some(m => m.provider === provider.id))
  assert.equal(bspace.accounts.models.getProvider(provider.id), undefined)
})

test('D6/D10: both Feishu bots stay online; restart restores all channels, schedules and pending outboxes before login', async t => {
  const remote = await feishuPlatform(), root = await tempDir(), options = { ...config(root), feishu: { domain: remote.origin, streamMs: 20 } }
  let host = await startServer(options)
  t.after(async () => { await host.close(); await remote.close() })
  const { a, b } = await pair(host)
  const users = [a, b]
  for (const [i, { user }] of users.entries()) {
    const space = host.spaces.get(user.id)!
    await space.channels.set('feishu', { enabled: true, values: { appId: i ? 'cli_2222222222222222' : 'cli_1111111111111111', stream: false }, secrets: { appSecret: 'bot-secret-' + i } })
    await space.channels.allow('feishu', 'owner-open-id', user.email)
  }
  assert.equal(remote.sockets.filter(s => s.readyState === WebSocket.OPEN).length, 2)
  await remote.event('same-incoming-id', 'A message', { socket: 0 })
  await remote.event('same-incoming-id', 'B message', { socket: 1 })
  for (const { user } of users) await until(async () => !!(await host.spaces.get(user.id)!.db.get<{ receipt: string }>('SELECT receipt FROM outbox WHERE id = ?', 'same-incoming-id:final'))?.receipt, 'bot final')
  const asp = host.spaces.get(a.user.id)!, bsp = host.spaces.get(b.user.id)!
  const at = (await asp.trees())[0]!, bt = (await bsp.trees())[0]!
  assert.notEqual(at.id, bt.id)
  assert.match(await asp.transcript(at.id, ctx), /A message/); assert.doesNotMatch(await asp.transcript(at.id, ctx), /B message/)
  assert.match(await bsp.transcript(bt.id, ctx), /B message/); assert.doesNotMatch(await bsp.transcript(bt.id, ctx), /A message/)
  remote.state.failSends = true
  await remote.event('pending', 'queued A', { socket: 0 }); await remote.event('pending', 'queued B', { socket: 1 })
  for (const { user } of users) await until(async () => !!(await host.spaces.get(user.id)!.db.get('SELECT 1 FROM outbox WHERE id = ? AND delivered_at IS NULL', 'pending:final')), 'queued final')
  const due = Date.now() + 1500
  for (const [space, tree] of [[asp, at], [bsp, bt]] as const) await space.createSchedule(tree.id, { name: 'resume', prompt: 'resumed schedule', rule: { kind: 'once', at: due }, tz: 'UTC' })
  await host.close()
  remote.state.failSends = false
  host = await startServer(options)
  assert.equal(remote.sockets.filter(s => s.readyState === WebSocket.OPEN).length, 2, 'both connect at startup without browser login')
  for (const { user } of users) {
    const space = host.spaces.get(user.id)!
    await until(async () => !!(await space.db.get<{ receipt: string }>('SELECT receipt FROM outbox WHERE id = ?', 'pending:final'))?.receipt, 'recovered outbox')
    await until(async () => (await space.schedules())[0]?.lastRunAt !== null, 'resumed schedule')
  }
  const receipts = await Promise.all(users.map(async ({ user }) => (await host.spaces.get(user.id)!.db.get<{ receipt: string }>('SELECT receipt FROM outbox WHERE id = ?', 'pending:final'))!.receipt))
  assert.equal(new Set(receipts).size, 2, 'one delivery for each app')
  assert.equal(remote.sent.filter(s => receipts.includes(s.id)).length, 2)
  const client = await Client.connect(host.url, b.cookie)
  try { await client.request({ t: 'watch', treeId: bt.id }); assert.ok(client.views.get(bt.id)) } finally { client.close() }
  // Disabling stops this user's bot; a restart only opens the enabled user. Re-enabling resumes it.
  assert.equal((await api(host, '/api/admin/users/' + b.user.id, a.cookie, 'PATCH', { disabled: true })).status, 200)
  await until(() => remote.sockets.filter(s => s.readyState === WebSocket.OPEN).length === 1)
  await host.close(); host = await startServer(options)
  assert.ok(host.spaces.get(a.user.id)); assert.equal(host.spaces.get(b.user.id), undefined)
  assert.equal((await api(host, '/api/admin/users/' + b.user.id, a.cookie, 'PATCH', { disabled: false })).status, 200)
  await until(() => remote.sockets.filter(s => s.readyState === WebSocket.OPEN).length === 2)
})

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const hasSandbox = (() => { try { return !!docker('image', 'inspect', 'gense-sandbox:slim') } catch { return false } })()
test('D8: two Docker sandboxes mount only their own files and cannot reach each other or the host', { skip: !hasSandbox, timeout: 120_000 }, async t => {
  const root = await tempDir(), host = await startServer({ ...config(root), sandbox: { memory: '256m' } })
  t.after(() => host.close())
  const { a, b } = await pair(host), spaces = [host.spaces.get(a.user.id)!, host.spaces.get(b.user.id)!]
  const trees = await Promise.all(spaces.map(s => s.createTree()))
  const bash = async (i: number, command: string) => {
    const space = spaces[i]!, tree = trees[i]!
    await space.send(tree.id, { text: `[工具 bash] ${JSON.stringify({ command })}`, requestId: crypto.randomUUID() })
    await space.harness.waitForIdle(ctx)
    const { watch } = await space.watch(tree.id); await watch.stop()
    const entry = watch.value.entries.findLast(e => e.kind === 'pi.tool-result')!
    return JSON.stringify(entry.model)
  }
  assert.match(await bash(0, 'echo only-a > /data/a.txt; echo running-a'), /running-a/)
  assert.match(await bash(1, 'echo only-b > /data/b.txt; cat /data/a.txt 2>&1; echo running-b'), /No such file.*running-b/s)
  assert.match(await bash(0, 'cat /data/b.txt 2>&1; echo still-a'), /No such file.*still-a/s)
  const one = host.spaces.sandbox(a.user.id)!, two = host.spaces.sandbox(b.user.id)!
  assert.notEqual(one.name, two.name)
  for (const [sandbox, user] of [[one, a.user], [two, b.user]] as const) {
    const mounts = JSON.parse(docker('inspect', '-f', '{{json .Mounts}}', sandbox.name)) as { Source: string }[]
    const expected = join(userDir(root, user.id), 'files')
    assert.ok(mounts.every(m => m.Source === expected || m.Source.startsWith(expected + '/')))
    assert.ok(!mounts.some(m => m.Source.endsWith('docker.sock') || m.Source.endsWith('.sqlite')))
    assert.equal(docker('inspect', '-f', '{{.HostConfig.Privileged}}', sandbox.name), 'false')
  }
  const ip = docker('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', two.name)
  assert.match(await bash(0, `curl -m 2 -fsS http://${ip}:8000 2>&1 || echo blocked`), /blocked/)
})

test('D9: importing the legacy owner preserves password, conversations and files, and refuses overwrite/repeat', async t => {
  const root = await tempDir(), legacy = await openNodeSqliteDatabase(join(root, 'gense.sqlite'))
  // Build an actual old-layout owner database with a valid PBKDF2 hash from an independently registered account.
  const scratch = await openNodeSqliteDatabase(':memory:'), source = await Auth.open(scratch)
  await source.register('legacy@example.com', PASSWORD)
  const password = (await scratch.get<{ password: string }>('SELECT password FROM users'))!.password
  await scratch.close()
  await legacy.run('CREATE TABLE owner (id INTEGER PRIMARY KEY, password TEXT NOT NULL, updatedAt INTEGER NOT NULL)')
  await legacy.run('INSERT INTO owner VALUES (1, ?, ?)', password, Date.now())
  await legacy.run('CREATE TABLE legacy_marker (value TEXT)'); await legacy.run("INSERT INTO legacy_marker VALUES ('kept')")
  const oldSpace = await UserSpace.open(legacy, { models: fauxModels(), env: await diskEnv(join(root, 'files')), secretKey: 'multi-user-key' })
  const tree = await oldSpace.createTree()
  await oldSpace.send(tree.id, { text: 'a legacy conversation', requestId: 'legacy' })
  await oldSpace.harness.waitForIdle(ctx)
  await oldSpace.close()
  await mkdir(join(root, 'files'), { recursive: true }); await writeFile(join(root, 'files', 'kept.txt'), 'legacy file')
  const user = await importOwner(root, 'legacy@example.com')
  assert.equal(user.role, 'admin')
  assert.equal(await readFile(join(userDir(root, user.id), 'files', 'kept.txt'), 'utf8'), 'legacy file')
  await assert.rejects(access(join(root, 'gense.sqlite')))
  await assert.rejects(importOwner(root, user.email), /已迁移/)
  const db = await openNodeSqliteDatabase(join(userDir(root, user.id), 'space.sqlite'))
  assert.equal((await db.get<{ value: string }>('SELECT value FROM legacy_marker'))!.value, 'kept'); await db.close()
  const host = await startServer(config(root)); t.after(() => host.close())
  assert.ok(await login(host, user.email))
  assert.ok(host.spaces.get(user.id))
  await assert.rejects(importOwner(root, user.email), /停止服务器/)
  assert.match(await host.spaces.get(user.id)!.transcript(tree.id, ctx), /a legacy conversation/)
})

test('D10: snapshots include app.sqlite and every user database, including disabled accounts', async () => {
  const root = await tempDir(), options = config(root)
  let host = await startServer(options)
  try {
    const { a, b } = await pair(host)
    const trees = await Promise.all([a, b].map(({ user }) => host.spaces.get(user.id)!.createTree()))
    await api(host, '/api/admin/users/' + b.user.id, a.cookie, 'PATCH', { disabled: true })
    await host.close()
    host = await startServer({ ...options, backups: {} })
    await host.close() // waits for each initial snapshot, including the inactive user's database
    const { backups } = await import('../src/platform/backup.ts')
    for (const [dir, query, expected] of [
      [join(root, 'backups', 'app'), 'SELECT id FROM users ORDER BY id', [a.user.id, b.user.id].sort()],
      ...[a, b].map(({ user }, i) => [join(root, 'backups', 'users', user.id), 'SELECT id FROM trees', [trees[i]!.id]]),
    ] as [string, string, string[]][]) {
      const snapshots = await backups(dir); assert.equal(snapshots.length, 1)
      const db = await openNodeSqliteDatabase(join(dir, snapshots[0]!))
      try { assert.deepEqual((await db.all<{ id: string }>(query)).map(r => r.id), expected) } finally { await db.close() }
    }
  } finally { await host.close() }
})
