import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

export async function mcpPlatform(oauth = false) {
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
