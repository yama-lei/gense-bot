import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { ConversationId } from '@earendil-works/pi-durable'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { fauxModels, UserSpace } from '../src/index.ts'
import { toolName } from '../src/plugins/mcp/host.ts'
import { diskEnv } from './fixtures.ts'
import { tempDir } from './host-helpers.ts'

async function platform(oauth = false) {
  const state = { online: true, calls: [] as string[], headers: [] as string[], challenge: '', mime: 'text/html;profile=mcp-app' }
  let origin = ''
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin)
    const send = (value: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    let body = ''; for await (const chunk of req) body += String(chunk)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource') || url.pathname === '/metadata') return send({ resource: origin + '/mcp', authorization_servers: [origin], scopes_supported: ['mcp'] })
    if (url.pathname === '/.well-known/oauth-authorization-server') return send({ issuer: origin, authorization_endpoint: origin + '/authorize', token_endpoint: origin + '/token', registration_endpoint: origin + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
    if (url.pathname === '/register') return send({ ...JSON.parse(body), client_id: 'local-client' }, 201)
    if (url.pathname === '/token') {
      const params = new URLSearchParams(body)
      assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), state.challenge)
      return send({ access_token: 'oauth-private-token', refresh_token: 'oauth-refresh-token', token_type: 'Bearer', expires_in: 3600 })
    }
    if (!state.online) return send({ error: 'offline' }, 503)
    if (oauth && req.headers.authorization !== 'Bearer oauth-private-token') { res.setHeader('www-authenticate', `Bearer resource_metadata="${origin}/metadata"`); return send({ error: 'unauthorized' }, 401) }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    const message = JSON.parse(body)
    if (message.id === undefined) { res.writeHead(202); res.end(); return }
    state.headers.push(String(req.headers['x-private'] ?? ''))
    let result: unknown
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: 'local-mcp', version: '1' } }
    else if (message.method === 'tools/list') result = { tools: Array.from({ length: 21 }, (_,i) => ({ name: 'tool_' + i, description: i === 0 ? 'Find local weather' : 'Other operation ' + i, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, ...(i === 0 && { _meta: { ui: { resourceUri: 'ui://local/view' } } }) })) }
    else if (message.method === 'tools/call') { state.calls.push(message.params.name); result = { content: [{ type: 'text', text: 'weather:' + message.params.arguments.query }], structuredContent: { ok: true } } }
    else if (message.method === 'resources/read') result = { contents: [{ uri: message.params.uri, mimeType: state.mime, text: '<h1>weather</h1>', _meta: { ui: { csp: { connectDomains: ['https://weather.example'] }, prefersBorder: true } } }] }
    else return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } })
    send({ jsonrpc: '2.0', id: message.id, result })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { state, origin, url: origin + '/mcp', close: () => new Promise<void>(r => server.close(() => r())) }
}
async function until(check: () => boolean, timeout = 5000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error('state timeout'); await new Promise(r => setTimeout(r, 20)) } }

test('N20–N23: real MCP initialization, deferred tool_search, tool isolation, resources, encrypted headers and automatic recovery', async () => {
  const remote = await platform(), root = await tempDir(), env = await diskEnv(root)
  let space = await UserSpace.open(await openNodeSqliteDatabase(join(root, 'mcp.sqlite')), { models: fauxModels(), env, secretKey: 'test-key', mcp: { retryMs: 50, pollMs: 300, timeoutMs: 1000 } })
  try {
    const plugin = await space.mcp.add({ name: 'Weather', url: remote.url, headers: { 'X-Private': 'header-private-secret' } })
    assert.equal(plugin.mcp?.status, 'ready')
    assert.equal(plugin.tools.length, 21)
    assert.ok(!JSON.stringify(plugin).includes('header-private-secret'))
    const id = plugin.id, name = toolName(id, 'tool_0')
    const tree = await space.createTree(), branch = (await space.branches(tree.id)).branches[0]!
    const conv = (await space.harness.conversation(branch.conversationId as ConversationId, ctx))!
    assert.equal((await conv.agent(ctx)).deferred.length, 21)
    await space.send(tree.id, { text: '[工具 tool_search] {"query":"local weather","limit":1}', requestId: 'search-tools' })
    await space.harness.waitForIdle(ctx)
    assert.ok((await conv.agent(ctx)).tools.some(t => t.name === name))
    await space.send(tree.id, { text: `[工具 ${name}] {"query":"today"}`, requestId: 'mcp-tool' })
    await space.harness.waitForIdle(ctx)
    assert.deepEqual(remote.state.calls, ['tool_0'])
    assert.equal(remote.state.headers.at(-1), 'header-private-secret')
    const view = await space.mcp.readResource(id, 'ui://local/view')
    assert.deepEqual(view.csp?.connectDomains, ['https://weather.example'])
    assert.match(view.html, /weather/)
    await assert.rejects(space.mcp.readResource(id, 'file:///etc/passwd'), /不属于/)
    remote.state.mime = 'text/html'
    await assert.rejects(space.mcp.readResource(id, 'ui://local/view'), /profile=mcp-app/)
    remote.state.mime = 'text/html;profile=mcp-app'
    const other = await space.mcp.add({ name: 'Other', url: remote.url })
    await assert.rejects(space.callTool(tree.id, other.id, name, { query: 'x' }), /不属于/)
    await space.plugins.setTool(id, name, false)
    await assert.rejects(space.callTool(tree.id, id, name, { query: 'x' }), /已关闭/)
    assert.ok(!(await conv.agent(ctx)).tools.some(t => t.name === name))
    await space.plugins.setTool(id, name, true)
    remote.state.online = false
    await assert.rejects(space.mcp.call(id, name, { query: 'offline' }))
    assert.equal(space.plugins.list().find(p => p.id === id)!.mcp!.status, 'error')
    assert.ok(!(await conv.agent(ctx)).tools.some(t => t.name === name))
    remote.state.online = true
    await until(() => space.plugins.list().find(p => p.id === id)?.mcp?.status === 'ready')
    assert.ok((await conv.agent(ctx)).tools.some(t => t.name === name))
    const row = await space.db.get<{ secrets: string }>('SELECT secrets FROM mcp_servers WHERE id = ?', id)
    assert.ok(!row!.secrets.includes('header-private-secret'))
    await space.close()
    space = await UserSpace.open(await openNodeSqliteDatabase(join(root, 'mcp.sqlite')), { models: fauxModels(), env, secretKey: 'test-key', mcp: { retryMs: 50, pollMs: 30_000 } })
    assert.equal(space.plugins.list().find(p => p.id === id)!.mcp!.status, 'ready')
    await space.mcp.update(id, { name: 'Renamed', headers: { 'x-private': null } })
    assert.equal(space.plugins.list().find(p => p.id === id)!.name, 'Renamed')
    assert.deepEqual(space.plugins.list().find(p => p.id === id)!.mcp!.headersSet, [])
    await space.mcp.remove(other.id)
    assert.ok(!space.plugins.list().some(p => p.id === other.id))
  } finally { await space.close(); await remote.close() }
})

test('N20: real OAuth metadata, dynamic registration, PKCE, single-use state and sealed tokens', async () => {
  const remote = await platform(true)
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: fauxModels(), env: await diskEnv(), secretKey: 'oauth-key', mcp: { publicUrl: 'http://localhost:8787', timeoutMs: 1000 } })
  try {
    const plugin = await space.mcp.add({ name: 'OAuth', url: remote.url })
    assert.equal(plugin.mcp!.status, 'auth')
    const { url } = await space.mcp.authorize(plugin.id), authorize = new URL(url)
    assert.equal(authorize.origin, remote.origin)
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
    remote.state.challenge = authorize.searchParams.get('code_challenge')!
    await assert.rejects(space.mcp.callback(new URL('http://localhost/api/mcp/callback?state=bad&code=ok')), /无效/)
    const callback = new URL('http://localhost/api/mcp/callback')
    callback.searchParams.set('state', authorize.searchParams.get('state')!); callback.searchParams.set('code', 'ok')
    await space.mcp.callback(callback)
    assert.equal(space.plugins.list().find(p => p.id === plugin.id)!.mcp!.status, 'ready')
    assert.equal(space.plugins.list().find(p => p.id === plugin.id)!.mcp!.oauth, true)
    await assert.rejects(space.mcp.callback(callback), /无效/)
    const stored = await space.db.get<{ secrets: string }>('SELECT secrets FROM mcp_servers WHERE id = ?', plugin.id)
    assert.ok(!stored!.secrets.includes('oauth-private-token'))
    assert.ok(!JSON.stringify(space.plugins.list()).includes('oauth-private-token'))
  } finally { await space.close(); await remote.close() }
})
