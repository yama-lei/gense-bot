import type { JsonValue } from '@earendil-works/chord'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { McpServerState, PluginInfo, ToolCallResult, UiResource } from '@gense/protocol'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { Type } from 'typebox'
import { definePlugin } from '../registry.ts'
import { PluginStore, Sealer } from '../store.ts'

type Secret = { headers: Record<string, string>; client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; state?: string; expiresAt?: number }
type RecordData = { id: string; name: string; url: string; secret: Secret }
type Server = RecordData & { client?: Client; transport?: StreamableHTTPClientTransport; tools: Tool[]; state: McpServerState; timer?: NodeJS.Timeout; attempts: number; generation: number; connecting?: Promise<void>; authorizationUrl?: string }
export interface McpOptions { publicUrl?: string; deferredThreshold?: number; retryMs?: number; pollMs?: number; timeoutMs?: number }
const urlOf = (value: string) => {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('MCP 地址必须是无凭据的 HTTP(S) 地址')
  return url.href
}
const headersOf = (values: Record<string, string>) => {
  const headers = new Headers(values)
  for (const key of headers.keys()) if (['mcp-session-id', 'mcp-protocol-version', 'content-type', 'accept', 'host', 'cookie'].includes(key)) throw new Error('不能覆盖 MCP 协议请求头')
  return Object.fromEntries(headers)
}
export const toolName = (id: string, name: string) => `mcp__${id}__${name}`

export class McpHost {
  #db: SqliteDatabase
  #plugins: PluginStore
  #sealer?: Sealer
  #options: McpOptions
  #servers = new Map<string, Server>()
  #closed = false
  #unsubscribe: () => void
  private constructor(db: SqliteDatabase, plugins: PluginStore, key: string | undefined, options: McpOptions) {
    this.#db = db; this.#plugins = plugins; this.#sealer = key ? new Sealer(key) : undefined; this.#options = options
    this.#unsubscribe = plugins.subscribe(() => {
      for (const s of this.#servers.values()) {
        const enabled = plugins.list().find(p => p.id === s.id)?.enabled
        if (!enabled && s.state.status !== 'off') { s.generation++; clearTimeout(s.timer); s.state.status = 'off'; void s.client?.close().catch(() => {}); s.client = undefined }
        else if (enabled && s.state.status === 'off') void this.reconnect(s.id)
      }
    })
  }
  static async open(db: SqliteDatabase, plugins: PluginStore, key?: string, options: McpOptions = {}) {
    await db.run('CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, secrets TEXT NOT NULL)')
    const host = new McpHost(db, plugins, key, options)
    for (const row of await db.all<{ id: string; name: string; url: string; secrets: string }>('SELECT * FROM mcp_servers')) {
      let secret: Secret = { headers: {} }
      if (row.secrets && host.#sealer) { try { secret = JSON.parse(await host.#sealer.open(row.secrets)) } catch { /* Changed encryption key: reconnect without old credentials. */ } }
      host.#register({ id: row.id, name: row.name, url: row.url, secret })
    }
    for (const server of host.#servers.values()) await host.reconnect(server.id)
    return host
  }
  #get(id: string) { const s = this.#servers.get(id); if (!s) throw new Error('未知 MCP 插件'); return s }
  #register(data: RecordData) {
    const s: Server = { ...data, tools: [], state: { url: data.url, status: 'off', headersSet: Object.keys(data.secret.headers), oauth: !!data.secret.tokens }, attempts: 0, generation: 0 }
    this.#servers.set(s.id, s); this.#publish(s)
    return s
  }
  #publish(s: Server) {
    const host = this
    // MCP tools are callable by both model and views. Built-in viewTools alone are view-only.
    this.#plugins.register(definePlugin({
      id: s.id, kind: 'mcp', name: s.name, description: 'MCP · ' + s.url, sideEffect: true, defaultEnabled: true, settings: [],
      issue: () => s.state.status === 'ready' ? null : s.state.error ?? s.state.status,
      mcp: () => ({ ...s.state, headersSet: [...s.state.headersSet] }),
      resources: Object.fromEntries(s.tools.flatMap(t => { const uri = this.#resource(t); return uri ? [[toolName(s.id, t.name), uri]] : [] })),
      extension: () => defineExtension({ name: s.id, tools: s.tools.map(t => defineTool({
        name: toolName(s.id, t.name), description: t.description ?? t.name, parameters: Type.Unsafe<Record<string, unknown>>(t.inputSchema), replay: 'unsafe',
        ...(s.tools.length > (this.#options.deferredThreshold ?? 20) && { deferred: true as const }),
        async execute(args) {
          const result = await host.#invoke(s.id, toolName(s.id, t.name), args)
          const output: NonNullable<ToolExecutionResult['output']> = result.content.map(c => c.type === 'text' ? { type: 'text', text: c.text } : c.type === 'image' ? { type: 'image', data: c.data, mimeType: c.mimeType } : { type: 'text', text: JSON.stringify(c) })
          return { output, ...(result.structuredContent !== undefined && { details: result.structuredContent as JsonValue }), ...(result.isError && { isError: true }) }
        },
      })) }),
    }))
  }
  #resource(tool: Tool) {
    const meta = tool._meta as { ui?: { resourceUri?: string }; 'ui/resourceUri'?: string } | undefined
    const uri = meta?.ui?.resourceUri ?? meta?.['ui/resourceUri']
    return typeof uri === 'string' && uri.startsWith('ui://') ? uri : undefined
  }
  async #save(s: Server) {
    const needsKey = Object.keys(s.secret.headers).length > 0 || !!s.secret.tokens || !!s.secret.client || !!s.secret.verifier
    if (needsKey && !this.#sealer) throw new Error('需要 TOKEN_ENCRYPTION_KEY 保存 MCP 凭据')
    await this.#db.run('INSERT INTO mcp_servers VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, url = excluded.url, secrets = excluded.secrets', s.id, s.name, s.url, needsKey ? await this.#sealer!.seal(JSON.stringify(s.secret)) : '')
  }
  async add(input: { name: string; url: string; headers?: Record<string, string> }): Promise<PluginInfo> {
    if (!input.name.trim()) throw new Error('MCP 名称不能为空')
    const data = { id: 'mcp_' + crypto.randomUUID().replaceAll('-', '').slice(0, 16), name: input.name.trim(), url: urlOf(input.url), secret: { headers: headersOf(input.headers ?? {}) } }
    // Validate/persist before publishing a live plugin.
    const s: Server = { ...data, tools: [], state: { url: data.url, status: 'off', headersSet: [], oauth: false }, attempts: 0, generation: 0 }
    await this.#save(s)
    this.#register(data)
    await this.reconnect(data.id)
    return this.#plugins.list().find(p => p.id === data.id)!
  }
  async update(id: string, patch: { name?: string; url?: string; headers?: Record<string, string | null> }) {
    const s = this.#get(id), secret = { ...s.secret, headers: { ...s.secret.headers } }
    for (const [key, value] of Object.entries(patch.headers ?? {})) { if (value === null) delete secret.headers[key.toLowerCase()]; else secret.headers[key.toLowerCase()] = value }
    secret.headers = headersOf(secret.headers)
    const url = patch.url ? urlOf(patch.url) : s.url
    if (url !== s.url) { delete secret.client; delete secret.tokens; delete secret.verifier; delete secret.state }
    const name = patch.name === undefined ? s.name : patch.name.trim()
    if (!name) throw new Error('MCP 名称不能为空')
    await this.#save({ ...s, url, name, secret })
    Object.assign(s, { url, name, secret }); s.state.url = url; s.state.headersSet = Object.keys(secret.headers)
    await this.reconnect(id)
  }
  async remove(id: string) {
    const s = this.#get(id); this.#servers.delete(id); s.generation++; clearTimeout(s.timer)
    await s.client?.close().catch(() => {})
    await this.#db.run('DELETE FROM mcp_servers WHERE id = ?', id)
    await this.#plugins.unregister(id)
  }
  async reconnect(id: string): Promise<void> {
    const s = this.#get(id)
    if (s.connecting) return s.connecting
    const operation = this.#connect(s)
    s.connecting = operation
    try { await operation } finally { if (s.connecting === operation) s.connecting = undefined }
  }
  async #connect(s: Server) {
    clearTimeout(s.timer)
    const generation = ++s.generation
    await s.client?.close().catch(() => {})
    if (this.#closed || !this.#plugins.list().find(p => p.id === s.id)?.enabled) { s.state.status = 'off'; this.#publish(s); return }
    s.state.status = 'connecting'; delete s.state.error; this.#publish(s)
    const client = new Client({ name: 'gense', version: '5.0.0' }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: s.secret.headers }, ...(this.#sealer && this.#options.publicUrl && { authProvider: this.#provider(s) }) })
    s.client = client; s.transport = transport
    try {
      await client.connect(transport, { timeout: this.#options.timeoutMs ?? 5000 })
      await this.#load(s, client)
      if (this.#closed || generation !== s.generation) { await client.close(); return }
      s.state.status = 'ready'; s.state.server = client.getServerVersion(); s.state.oauth = !!s.secret.tokens; s.attempts = 0; delete s.state.error
      client.onerror = error => { if (!this.#closed && generation === s.generation) this.#failed(s, error) }
      client.onclose = () => { if (!this.#closed && generation === s.generation) this.#failed(s, new Error('MCP connection closed')) }
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { try { await this.#load(s, client); this.#publish(s) } catch (e) { this.#failed(s, e) } })
      this.#publish(s); this.#schedule(s, this.#options.pollMs ?? 30_000)
    } catch (error) { if (!this.#closed && generation === s.generation) this.#failed(s, error) }
  }
  async #load(s: Server, client: Client) {
    const tools: Tool[] = []
    let cursor: string | undefined
    do { const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.#options.timeoutMs ?? 5000 }); tools.push(...result.tools); cursor = result.nextCursor; if (tools.length > 2000) throw new Error('MCP tools/list 太大') } while (cursor)
    if (tools.some(t => !/^[a-zA-Z0-9_-]+$/.test(t.name))) throw new Error('MCP 工具名无效')
    s.tools = tools
  }
  #failed(s: Server, error: unknown) {
    s.state.status = error instanceof UnauthorizedError ? 'auth' : 'error'
    // Do not surface response bodies which may echo configured credentials.
    let detail = error instanceof Error ? error.message : String(error)
    for (const secret of [...Object.values(s.secret.headers), s.secret.tokens?.access_token, s.secret.tokens?.refresh_token]) if (secret) detail = detail.split(secret).join('[redacted]')
    s.state.error = error instanceof UnauthorizedError ? 'MCP 需要授权' : detail.slice(0, 400)
    this.#publish(s)
    if (s.state.status !== 'auth') this.#schedule(s, Math.min(60_000, (this.#options.retryMs ?? 1000) * 2 ** Math.min(s.attempts++, 6)))
  }
  #schedule(s: Server, delay: number) {
    clearTimeout(s.timer)
    s.timer = setTimeout(() => {
      if (this.#closed || !this.#servers.has(s.id)) return
      if (s.state.status !== 'ready' || !s.client) { void this.reconnect(s.id); return }
      const generation = s.generation
      void this.#load(s, s.client).then(() => { if (!this.#closed && generation === s.generation) { this.#publish(s); this.#schedule(s, this.#options.pollMs ?? 30_000) } }, error => { if (!this.#closed && generation === s.generation) this.#failed(s, error) })
    }, delay)
    s.timer.unref()
  }
  async call(id: string, name: string, args: unknown): Promise<ToolCallResult> {
    const result = await this.#invoke(id, name, args)
    return { content: result.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n'), ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent }), ...(result.isError && { isError: true }) }
  }
  async #invoke(id: string, name: string, args: unknown) {
    const s = this.#get(id), tool = s.tools.find(t => toolName(id, t.name) === name)
    if (!tool) throw new Error('工具不属于这个 MCP 服务器')
    if (!this.#plugins.active().includes(id) || !this.#plugins.toolEnabled(id, name) || !s.client) throw new Error('MCP 插件或工具已关闭/不可用')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象')
    try {
      const result = await s.client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, undefined, { timeout: this.#options.timeoutMs ?? 30_000 })
      const content = 'content' in result && Array.isArray(result.content) ? result.content : []
      return { content, ...('structuredContent' in result && result.structuredContent !== undefined && { structuredContent: result.structuredContent }), ...(result.isError === true && { isError: true }) }
    } catch (error) { this.#failed(s, error); throw new Error('MCP 工具请求失败') }
  }
  async readResource(id: string, uri: string): Promise<UiResource> {
    const s = this.#get(id)
    if (!uri.startsWith('ui://') || !s.tools.some(t => this.#resource(t) === uri)) throw new Error('资源不属于这个 MCP 插件')
    if (!this.#plugins.active().includes(id) || !s.client) throw new Error('MCP 插件不可用')
    const result = await s.client.readResource({ uri }, { timeout: this.#options.timeoutMs ?? 5000 })
    const resource = result.contents.find(c => c.uri === uri && c.mimeType === 'text/html;profile=mcp-app' && 'text' in c)
    if (!resource || !('text' in resource) || typeof resource.text !== 'string') throw new Error('资源必须是 text/html;profile=mcp-app')
    const ui = (resource._meta as { ui?: { csp?: UiResource['csp']; prefersBorder?: boolean } } | undefined)?.ui
    return { uri, html: resource.text, ...(ui?.csp && { csp: ui.csp }), ...(ui?.prefersBorder !== undefined && { prefersBorder: ui.prefersBorder }) }
  }
  #provider(s: Server): OAuthClientProvider {
    const host = this
    return {
      get redirectUrl() { return new URL('/api/mcp/callback', host.#options.publicUrl!).href },
      get clientMetadata() { return { client_name: 'Gense', redirect_uris: [String(this.redirectUrl)], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } },
      state: () => s.secret.state ?? '',
      clientInformation: () => s.secret.client,
      saveClientInformation: async info => { s.secret.client = info; await host.#save(s) },
      tokens: () => s.secret.tokens,
      saveTokens: async tokens => { s.secret.tokens = tokens; s.state.oauth = true; await host.#save(s) },
      saveCodeVerifier: async verifier => { s.secret.verifier = verifier; await host.#save(s) },
      codeVerifier: () => { if (!s.secret.verifier) throw new Error('OAuth verifier 不存在'); return s.secret.verifier },
      redirectToAuthorization: url => { s.authorizationUrl = url.href },
      invalidateCredentials: async scope => { if (scope === 'all' || scope === 'tokens') delete s.secret.tokens; if (scope === 'all' || scope === 'client') delete s.secret.client; if (scope === 'all' || scope === 'verifier') delete s.secret.verifier; await host.#save(s) },
    }
  }
  async authorize(id: string) {
    const s = this.#get(id)
    if (!this.#sealer || !this.#options.publicUrl) throw new Error('OAuth 需要 PUBLIC_URL 和 TOKEN_ENCRYPTION_KEY')
    s.secret.state = crypto.randomUUID(); s.secret.expiresAt = Date.now() + 10 * 60_000; s.authorizationUrl = undefined
    await this.#save(s)
    const result = await auth(this.#provider(s), { serverUrl: s.url })
    if (result === 'AUTHORIZED') { await this.reconnect(id); return { url: new URL('/plugins', this.#options.publicUrl).href } }
    if (!s.authorizationUrl) throw new Error('MCP 没有返回授权地址')
    s.state.status = 'auth'; this.#publish(s)
    return { url: s.authorizationUrl }
  }
  async callback(url: URL) {
    const state = url.searchParams.get('state'), code = url.searchParams.get('code')
    const s = [...this.#servers.values()].find(s => state && s.secret.state === state && (s.secret.expiresAt ?? 0) > Date.now())
    if (!s || !code || url.searchParams.has('error')) throw new Error('OAuth 回调无效或已过期')
    delete s.secret.state; delete s.secret.expiresAt; await this.#save(s)
    await auth(this.#provider(s), { serverUrl: s.url, authorizationCode: code })
    delete s.secret.verifier; await this.#save(s); await this.reconnect(s.id)
  }
  async close() { this.#closed = true; this.#unsubscribe(); for (const s of this.#servers.values()) { s.generation++; clearTimeout(s.timer); await s.client?.close().catch(() => {}) } }
}
