// What a tool call with a view draws: a built-in React view, or an MCP Apps page in a sandboxed frame.
import type { ToolCallResult, UiResource } from '@gense/protocol'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useClient, useViewState, type Client } from '../../app/client'
import { cn } from '../../lib/cn'
import { errorText, webUrl } from '../../lib/format'
import { useTheme } from '../../lib/theme'
import type { ToolMeta } from '../../lib/tools'
import type { ToolCall } from '../../lib/types'
import { liveViews, views } from '../../plugins'
import type { DisplayMode, ViewHost } from '../../plugins/types'
import { Notice, Skeleton } from '../../ui/feedback'

/** Whether the call draws a view now: after it succeeded, or while it runs for a view that draws from its input. */
export function hasView(call: ToolCall, meta: ToolMeta | undefined) {
  if (!meta?.resourceUri || meta.viewOnly) return false
  if (meta.pluginKind === 'builtin' && !views[meta.resourceUri]) return false
  if (call.status === 'succeeded') return true
  // An MCP Apps page takes the arguments first and the result when it comes.
  return call.status === 'running' && (meta.pluginKind === 'mcp' || liveViews.has(meta.resourceUri))
}

export interface ViewSlotProps {
  treeId: string
  call: ToolCall
  meta: ToolMeta
  displayMode: DisplayMode
  onDisplayMode: (mode: DisplayMode) => void
  onSend: (text: string) => void
}

export function ViewSlot({ treeId, call, meta, displayMode, onDisplayMode, onSend }: ViewSlotProps) {
  const client = useClient()
  const viewState = useViewState(treeId, call.id)
  // Views keep `host` in effect dependencies, so it only changes with the call.
  const handlers = useRef({ onDisplayMode, onSend })
  handlers.current = { onDisplayMode, onSend }
  const host = useMemo<ViewHost>(
    () => ({
      callTool: (name, args) => client.callTool(treeId, meta.pluginId, name, args),
      sendMessage: (text) => handlers.current.onSend(text),
      requestDisplayMode: (mode) => handlers.current.onDisplayMode(mode),
      setViewState: (state) => client.setViewState(treeId, call.id, state),
      readFile: (path) => client.readFile(treeId, path).then((f) => f.blob),
    }),
    [client, treeId, meta.pluginId, call.id],
  )
  const View = meta.pluginKind === 'builtin' ? views[meta.resourceUri!] : undefined
  if (View) return <View toolInput={call.input} toolResult={call.result} displayMode={displayMode} viewState={viewState} host={host} />
  if (meta.pluginKind === 'mcp') return <McpApp client={client} meta={meta} call={call} displayMode={displayMode} host={host} />
  return null
}

// ── MCP Apps ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The page runs in a frame without `allow-same-origin`: it has an opaque origin, so it cannot read this app's cookies,
// storage or DOM, and its own CSP (from the resource's `_meta.ui.csp`) limits what it may load. It talks to us only
// through JSON-RPC over postMessage.

const resources = new Map<string, Promise<UiResource>>()
function loadResource(client: Client, pluginId: string, uri: string) {
  const key = `${pluginId}\n${uri}`
  let pending = resources.get(key)
  if (!pending) {
    pending = client.request<UiResource>({ t: 'resource.read', pluginId, uri })
    resources.set(key, pending)
    pending.catch(() => resources.delete(key))
  }
  return pending
}

const origins = (list: string[] | undefined) => (list ?? []).filter((d) => /^(https?|wss?):\/\/[^\s;,'"]+$/.test(d)).join(' ')

function srcdoc(r: UiResource) {
  const res = origins(r.csp?.resourceDomains)
  const csp = [
    `default-src 'none'`,
    `script-src 'unsafe-inline' ${res}`,
    `style-src 'unsafe-inline' ${res}`,
    `img-src data: blob: ${res}`,
    `font-src data: ${res}`,
    `media-src data: blob: ${res}`,
    `connect-src ${origins(r.csp?.connectDomains) || "'none'"}`,
    `frame-src ${origins(r.csp?.frameDomains) || "'none'"}`,
    `base-uri ${origins(r.csp?.baseUriDomains) || "'none'"}`,
    `form-action 'none'`,
  ].join('; ')
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}">`
  // First in the document, so it governs everything the page itself declares.
  return /^\s*<!doctype[^>]*>/i.test(r.html) ? r.html.replace(/^\s*<!doctype[^>]*>/i, (d) => d + meta) : meta + r.html
}

function styleVariables() {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string) => cs.getPropertyValue(name).trim()
  return {
    '--color-background-primary': v('--background'),
    '--color-background-secondary': v('--muted'),
    '--color-background-tertiary': v('--hover'),
    '--color-background-inverse': v('--primary'),
    '--color-text-primary': v('--foreground'),
    '--color-text-secondary': v('--muted-foreground'),
    '--color-text-inverse': v('--primary-foreground'),
    '--color-text-danger': v('--destructive'),
    '--color-text-success': v('--success'),
    '--color-text-warning': v('--warning'),
    '--color-border-primary': v('--border'),
    '--color-border-secondary': v('--input'),
    '--color-ring-primary': v('--ring'),
    '--font-sans': v('--sans') || 'system-ui, sans-serif',
    '--font-mono': v('--mono') || 'ui-monospace, monospace',
    '--border-radius-sm': '6px',
    '--border-radius-md': '8px',
    '--border-radius-lg': '12px',
    '--border-radius-xl': '16px',
  }
}

const toMcp = (r: ToolCallResult) => ({
  content: [{ type: 'text', text: r.content }],
  ...(r.structuredContent !== undefined && { structuredContent: r.structuredContent }),
  ...(r.isError && { isError: true }),
})
const mcpMode = (mode: DisplayMode) => (mode === 'inline' ? 'inline' : 'fullscreen')

type Rpc = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown> }

const INLINE_MAX = 720

function McpApp({ client, meta, call, displayMode, host }: { client: Client; meta: ToolMeta; call: ToolCall; displayMode: DisplayMode; host: ViewHost }) {
  const theme = useTheme()
  const frame = useRef<HTMLIFrameElement>(null)
  const [resource, setResource] = useState<UiResource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [height, setHeight] = useState(240)
  const uri = meta.resourceUri!

  useEffect(() => {
    let live = true
    loadResource(client, meta.pluginId, uri).then(
      (r) => live && setResource(r),
      (e: unknown) => live && setError(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [client, meta.pluginId, uri])

  const doc = useMemo(() => resource && srcdoc(resource), [resource])
  const post = (message: object) => frame.current?.contentWindow?.postMessage({ jsonrpc: '2.0', ...message }, '*')
  // What the bridge reads when the page asks; kept current without re-subscribing the listener.
  const now = useRef({ theme, displayMode, call, host })
  now.current = { theme, displayMode, call, host }

  useEffect(() => {
    if (!doc) return
    setReady(false)
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const m = e.data as Rpc | null
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return
      const params = m.params ?? {}
      const reply = (result: object) => m.id !== undefined && post({ id: m.id, result })
      const fail = (message: string, code = -32000) => m.id !== undefined && post({ id: m.id, error: { code, message } })
      const { theme, displayMode, call, host } = now.current
      switch (m.method) {
        case 'ui/initialize':
          return reply({
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-21',
            hostInfo: { name: 'GenseBot', version: '1' },
            hostCapabilities: { openLinks: {}, serverTools: {}, logging: {} },
            hostContext: {
              theme,
              displayMode: mcpMode(displayMode),
              availableDisplayModes: ['inline', 'fullscreen'],
              locale: navigator.language,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              platform: 'web',
              styles: { variables: styleVariables() },
              toolInfo: { id: call.id, tool: { name: call.name, inputSchema: { type: 'object' } } },
              containerDimensions: { maxHeight: INLINE_MAX },
            },
          })
        case 'ui/notifications/initialized':
          return setReady(true)
        case 'ui/notifications/size-changed':
          if (typeof params.height === 'number' && params.height > 0) setHeight(Math.ceil(params.height))
          return
        case 'tools/call':
          if (typeof params.name !== 'string') return fail('tools/call 缺少 name', -32602)
          return void host.callTool(params.name, params.arguments ?? {}).then((r) => reply(toMcp(r)))
        case 'ui/message': {
          const content = params.content as { text?: unknown } | { text?: unknown }[] | undefined
          const text = (Array.isArray(content) ? content : [content]).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim()
          if (!text) return fail('ui/message 没有文本', -32602)
          host.sendMessage(text)
          return reply({})
        }
        case 'ui/open-link': {
          const url = webUrl(params.url)
          if (!url) return fail('只能打开 http(s) 链接', -32602)
          window.open(url, '_blank', 'noopener,noreferrer')
          return reply({})
        }
        case 'ui/request-display-mode': {
          const mode: DisplayMode = params.mode === 'fullscreen' ? 'panel' : 'inline'
          host.requestDisplayMode(mode)
          return reply({ mode: mcpMode(mode) })
        }
        case 'ping':
          return reply({})
        case 'notifications/message':
          return
        default:
          return fail(`不支持 ${m.method}`, -32601)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [doc])

  // The arguments once the page is ready, the result when there is one.
  const input = call.input
  useEffect(() => {
    if (ready) post({ method: 'ui/notifications/tool-input', params: { arguments: input ?? {} } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])
  const { result, status } = call
  useEffect(() => {
    if (!ready) return
    if (result) post({ method: 'ui/notifications/tool-result', params: toMcp(result) })
    else if (status === 'failed') post({ method: 'ui/notifications/tool-cancelled', params: { reason: '调用没有完成' } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, result, status])
  useEffect(() => {
    if (ready) post({ method: 'ui/notifications/host-context-changed', params: { theme, displayMode: mcpMode(displayMode), styles: { variables: styleVariables() } } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, displayMode])

  if (error) return <Notice tone="error" title={`${meta.pluginName} 的界面没有加载`}>{error}</Notice>
  if (!doc) return <Skeleton className="h-40 w-full rounded-xl" />
  const panel = displayMode !== 'inline'
  return (
    <iframe
      ref={frame}
      title={`${meta.pluginName} · ${meta.title}`}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      className={cn('block w-full bg-transparent', resource?.prefersBorder !== false && !panel && 'rounded-xl border', panel && 'h-full min-h-[60dvh]')}
      style={panel ? undefined : { height: Math.min(height, INLINE_MAX) }}
    />
  )
}
