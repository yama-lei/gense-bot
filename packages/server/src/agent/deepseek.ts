// DeepSeek providers and their Messages adapter (roadmap-7 C). App extensions are model capabilities, not IDs.
import { calculateCost, createAssistantMessageEventStream, createProvider, type AssistantMessage, type Message, type Model, type ProviderAuth, type ProviderStreams, type SimpleStreamOptions, type StreamOptions } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages'
import { resolveTranscript } from '@earendil-works/pi-ai/utils/transcript'
import { GenerationTask, type EntryRecord, type RegistryReader, type Tx } from '@earendil-works/pi-durable'
import { DEEPSEEK_APP_MODELS, DEEPSEEK_BASE_URL, NATIVE_KIND, parseNote, type NativeSource, type NativeTrace } from '@gense/protocol'
import type { Context } from '@earendil-works/chord/context'
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import type { ModelSetup } from './models.ts'
import type { UserSpace } from './space.ts'
import { DEFAULT_TITLE, titleOf } from './shared.ts'

export const deepseekAppModel = (id: string) => (DEEPSEEK_APP_MODELS as readonly string[]).includes(id)
export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro']

// Vendor JSON stays intact for replay. It is never interpreted as a client tool call or put into prompt text.
type Wire = Record<string, any>
export interface DeepSeekResponse {
  trace: NativeTrace
  blocks: Wire[]
  usage?: Wire
  title?: string
}
export type DeepSeekMessage = AssistantMessage & { deepseek?: DeepSeekResponse }
interface NativeRequest {
  search: boolean
  read: boolean
  safety: boolean
  title: boolean
  notify(trace: NativeTrace): void
}
const REQUEST = Symbol('gense.deepseek.request')
type NativeOptions = (StreamOptions | SimpleStreamOptions) & { [REQUEST]?: NativeRequest }
export const nativeUsage = (message: AssistantMessage) => (message as DeepSeekMessage).deepseek?.usage?.server_tool_use as Wire | undefined
export const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0

function source(raw: Wire): NativeSource {
  return {
    url: String(raw.url ?? ''), title: String(raw.title ?? raw.url ?? ''),
    ...(raw.site_name && { site: String(raw.site_name) }), ...(raw.site_icon && { icon: String(raw.site_icon) }),
    ...(raw.snippet && { snippet: String(raw.snippet) }), ...((raw.page_age ?? raw.published_at) && { publishedAt: String(raw.page_age ?? raw.published_at) }),
  }
}

/** Observe exactly the JSON bytes pi consumes, including error events pi throws before its observer. */
function observeBody(response: Response, observe: (event: Wire) => void): Response {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffered = ''
  const consume = (flush = false) => {
    let boundary: RegExpExecArray | null
    while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffered))) {
      const record = buffered.slice(0, boundary.index)
      buffered = buffered.slice(boundary.index + boundary[0].length)
      const data = record.split(/\r\n|\n|\r/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n')
      if (data) { try { observe(JSON.parse(data)) } catch { /* The SDK reports malformed SSE. */ } }
    }
    if (flush && buffered.trim()) { buffered += '\n\n'; consume() }
  }
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) { buffered += decoder.decode(); consume(true); controller.close(); return }
        buffered += decoder.decode(next.value, { stream: true }); consume(); controller.enqueue(next.value)
      } catch (error) { controller.error(error) }
    },
    cancel(reason) { return reader.cancel(reason) },
  }), { status: response.status, statusText: response.statusText, headers: response.headers })
}

function restoreHistory(payload: Wire, messages: Message[], model: Model<any>) {
  // Mirror pi's filtering before pairing wire assistant messages. Empty, aborted and foreign thinking may vanish.
  const transformed = transformMessages(messages, model, id => id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64))
  const assistants = transformed.filter((m): m is DeepSeekMessage => m.role === 'assistant' && m.stopReason !== 'error' && m.stopReason !== 'aborted' && m.content.some(b => b.type === 'toolCall' || (b.type === 'text' ? b.text.trim() : b.thinking.trim() || b.thinkingSignature)))
  let index = 0
  for (const wire of payload.messages ?? []) {
    if (wire.role !== 'assistant') continue
    const previous = assistants[index++]
    if (!previous?.deepseek || previous.api !== model.api || previous.provider !== model.provider || previous.model !== model.id || previous.deepseek.trace.refusal) continue
    wire.content = structuredClone(previous.deepseek.blocks)
  }
}

export function deepseekMessagesApi(shared = false): ProviderStreams {
  const base = anthropicMessagesApi()
  const run = (method: 'stream' | 'streamSimple', model: Model<any>, context: Parameters<ProviderStreams['stream']>[1], options?: NativeOptions) => {
    if (!deepseekAppModel(model.id)) return base[method](model, context, options)
    const request = options?.[REQUEST]
    const result = createAssistantMessageEventStream()
    const native: DeepSeekResponse = { trace: { steps: [], citations: [] }, blocks: [] }
    let failureUsage: Wire | undefined
    let started = false
    let lastPush = 0
    const publish = () => {
      if (request && Date.now() - lastPush >= 250) { lastPush = Date.now(); request.notify(structuredClone(native.trace)) }
    }
    const observe = (event: Wire) => {
      if (event.type === 'message_start') native.usage = event.message?.usage
      if (event.type === 'content_block_start') {
        const block = structuredClone(event.content_block) as Wire
        native.blocks[event.index] = block
        if (block.type === 'server_tool_use') {
          const input = block.input ?? {}
          native.trace.steps.push({ id: block.id, kind: block.kind, action: input.action, status: 'running', ...(input.queries && { queries: input.queries }), ...(input.url && { url: input.url }), ...(input.pattern && { pattern: input.pattern }) })
          publish()
        } else if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
          const step = native.trace.steps.find(s => s.id === block.tool_use_id)
          if (step) {
            const values: Wire[] = Array.isArray(block.content) ? block.content : [block.content]
            const error = values.find(v => v?.error_code)
            step.status = error ? 'failed' : 'done'
            if (error) step.error = String(error.error_code)
            step.results = values.filter(v => v?.type === 'web_search_result' || v?.type === 'web_fetch_result').map(v => source(v.type === 'web_fetch_result' ? { ...v, title: v.content?.title } : v))
            publish()
          }
        }
      } else if (event.type === 'content_block_delta') {
        const block = native.blocks[event.index], delta = event.delta
        if (block && delta?.type === 'text_delta') block.text = (block.text ?? '') + delta.text
        if (block && delta?.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking
        if (block && delta?.type === 'signature_delta') block.signature = (block.signature ?? '') + delta.signature
        if (block && delta?.type === 'input_json_delta') block._partial = (block._partial ?? '') + delta.partial_json
        if (block && delta?.type === 'citations_delta') {
          ;(block.citations ??= []).push(delta.citation)
          const url = delta.citation?.url
          if (typeof url === 'string' && !native.trace.citations.some(c => c.url === url)) {
            const found = native.trace.steps.flatMap(s => s.results ?? []).find(s => s.url === url)
            native.trace.citations.push({ ...source(delta.citation), ...found })
          }
          publish()
        }
      } else if (event.type === 'content_block_stop') {
        const block = native.blocks[event.index]
        if (block?._partial !== undefined) { try { block.input = JSON.parse(block._partial) } catch { /* pi reports invalid client input. */ } delete block._partial }
      } else if (event.type === 'message_delta') {
        if (event.usage) native.usage = { ...native.usage, ...event.usage }
        if (typeof event.delta?.title === 'string') native.title = event.delta.title
        if (event.delta?.stop_reason === 'refusal') native.trace.refusal = true
      } else if (event.type === 'error' && event.usage) native.usage = event.usage
    }
    const wireFetch: typeof fetch = async (input, init) => {
      const response = await (options?.fetch ?? fetch)(input, init)
      if (!response.ok) {
        const body = await response.clone().json().catch(() => undefined) as Wire | undefined
        if (body?.usage) failureUsage = body.usage
        if (response.status === 400 && String(body?.error?.message ?? '').includes('Content Exists Risk')) native.trace.refusal = true
      }
      return observeBody(response, event => { if (event.type === 'error' && event.usage) failureUsage = event.usage })
    }
    const upstream = base[method](model, context, {
      ...options, fetch: wireFetch,
      onPayload: async (value, sentModel) => {
        const supplied = await options?.onPayload?.(value, sentModel)
        const payload = (supplied ?? value) as Wire
        payload.safety_check = { level: shared || request?.safety !== false ? 'high' : 'low' }
        delete payload.title
        if (request) { delete payload.thinking; delete payload.output_config }
        const reasoning = (options as { reasoning?: string } | undefined)?.reasoning
        if (reasoning && reasoning !== 'off') {
          payload.thinking = { type: 'enabled' }
          payload.output_config = { effort: reasoning === 'low' ? 'low' : reasoning === 'medium' ? 'high' : 'max' }
        } else if (reasoning === 'off') payload.thinking = { type: 'disabled' }
        if (request?.title) payload.title = { enabled: true }
        const tools = [...(payload.tools ?? [])]
        if (request?.search) tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
        if (request?.read) tools.push({ type: 'deepseek_read_url', name: 'deepseek_read_url' })
        if (tools.length) payload.tools = tools
        restoreHistory(payload, resolveTranscript(context, false).messages, model)
        return payload
      },
      onProviderStreamEvent: async (event, sentModel) => { observe(event as Wire); await options?.onProviderStreamEvent?.(event, sentModel) },
    })
    void (async () => {
      for await (const event of upstream) {
        if (event.type === 'start') started = true
        const message = (event.type === 'done' ? event.message : event.type === 'error' ? event.error : event.partial) as DeepSeekMessage
        message.deepseek = native
        if (event.type === 'done' || event.type === 'error') {
          if (failureUsage) native.usage = failureUsage
          native.blocks = native.blocks.filter(Boolean)
          for (const step of native.trace.steps) if (step.status === 'running') { step.status = 'failed'; step.error = 'unavailable' }
          if (native.usage) {
            const usage = native.usage
            message.usage.input = count(usage.input_tokens); message.usage.output = count(usage.output_tokens)
            message.usage.cacheRead = count(usage.cache_read_input_tokens); message.usage.cacheWrite = count(usage.cache_creation_input_tokens)
            message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite
            calculateCost(model, message.usage)
          }
          if (native.trace.refusal) {
            message.content = []; message.stopReason = 'stop'; message.rawStopReason = 'refusal'; delete message.errorMessage
            native.blocks = native.blocks.filter(b => !['text', 'thinking', 'tool_use'].includes(b.type))
            if (!started) { result.push({ type: 'start', partial: message }); started = true }
            result.push({ type: 'done', reason: 'stop', message }); continue
          }
        }
        result.push(event)
      }
      result.end(await upstream.result())
    })().catch(error => {
      // Every pi stream normally has a terminal result; keep transport failures visible to its consumer.
      void upstream.result().then(message => { message.stopReason = 'error'; message.errorMessage = String(error); result.push({ type: 'error', reason: 'error', error: message }); result.end(message) })
    })
    return result
  }
  return { stream: (m, c, o) => run('stream', m, c, o), streamSimple: (m, c, o) => run('streamSimple', m, c, o) }
}

export function deepseekModels(config: { providerId?: string; name?: string; baseUrl?: string; modelIds?: string[]; apiKey?: string }): ModelSetup {
  const builtin = deepseekProvider()
  const providerId = config.providerId ?? builtin.id
  const baseUrl = (config.baseUrl || DEEPSEEK_BASE_URL).replace(/\/+$/, '') + '/anthropic'
  const ids = config.modelIds?.length ? config.modelIds : DEEPSEEK_MODELS
  const auth: ProviderAuth = config.apiKey
    ? { apiKey: { name: 'DeepSeek', resolve: async () => ({ auth: { apiKey: config.apiKey! } }) } }
    : builtin.auth
  const provider = createProvider({
    id: providerId, name: config.name ?? builtin.name, baseUrl, auth,
    models: ids.map(id => {
      const known = builtin.getModels().find(m => m.id === id)
      return {
        id, name: known?.name ?? id, provider: providerId, api: 'anthropic-messages' as const, baseUrl,
        reasoning: true, input: known?.input ?? ['text' as const],
        cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: known?.contextWindow ?? 1_000_000, maxTokens: known?.maxTokens ?? 128_000,
        compat: { supportsEagerToolInputStreaming: false, supportsCacheControlOnTools: false, allowEmptySignature: true },
      }
    }),
    api: deepseekMessagesApi(!!config.apiKey),
  })
  const options = provider.getModels().map(m => ({ provider: providerId, providerName: provider.name, id: m.id, name: m.name, source: config.apiKey ? 'shared' as const : 'byok' as const }))
  return { providers: [provider], options, defaultModel: options[0] ?? null, kinds: { [providerId]: 'deepseek' } }
}

export async function initializeDeepseek(db: SqliteDatabase) {
  await db.run('CREATE TABLE IF NOT EXISTS deepseek_titles (treeId TEXT PRIMARY KEY, manual INTEGER NOT NULL DEFAULT 0)')
}
export async function deepseekTitleEdited(space: UserSpace, treeId: string) {
  await space.db.run('INSERT INTO deepseek_titles VALUES (?, 1) ON CONFLICT(treeId) DO UPDATE SET manual = 1', treeId)
}
export class NativeState {
  readonly listeners = new Set<(treeId: string, branchId: string, trace: NativeTrace) => void>()
  readonly traces = new Map<string, NativeTrace>()
  publish(treeId: string, branchId: string, trace: NativeTrace) {
    this.traces.set(branchId, trace)
    for (const listener of this.listeners) listener(treeId, branchId, trace)
  }
}
const states = new WeakMap<UserSpace, NativeState>()
export function nativeState(space: UserSpace) {
  let state = states.get(space)
  if (!state) { state = new NativeState(); states.set(space, state) }
  return state
}

function withoutWeb(messages: readonly Message[]): Message[] {
  const names = new Set(['web_search', 'web_fetch', 'deep_search'])
  return messages.map(message => {
    if (message.role === 'user' && Array.isArray(message.content)) return {
      ...message,
      content: message.content.flatMap(block => {
        if (block.type !== 'text' || !parseNote(block.text)?.mentions.some(m => m.kind === 'plugin' && m.id === 'web')) return [block]
        const text = block.text.replace(/^<mention kind="plugin" id="web" label=[^\n]*>\n[\s\S]*?^<\/mention>\n?/gm, '')
        return parseNote(text)?.mentions.length ? [{ ...block, text }] : []
      }),
    }
    return message.role !== 'system' ? message : {
    ...message,
    ...(message.sections && { sections: Object.fromEntries(Object.entries(message.sections).filter(([key]) => key !== 'web')) }),
    ...(message.toolsAdded && { toolsAdded: message.toolsAdded.filter(t => !names.has(t.name)) }),
    ...(message.toolsRemoved && { toolsRemoved: message.toolsRemoved.filter(t => !names.has(t.name)) }),
    }
  })
}

/** Add the trace in the same transaction, immediately after its assistant, including failures and tool rounds. */
function nativeTx(tx: Tx): Tx {
  return new Proxy(tx, { get(target, key) {
    if (key === 'appendEntry') return async (...args: unknown[]) => {
      const append = target.appendEntry as (...args: unknown[]) => Promise<EntryRecord>
      const entry = await append.apply(target, args)
      const message = entry.kind === 'pi.assistant' ? entry.model?.[0] as DeepSeekMessage | undefined : undefined
      const native = message?.deepseek
      if (native && (native.trace.steps.length || native.trace.citations.length || native.trace.refusal))
        await target.appendEntry(entry.conversationId, { kind: NATIVE_KIND, data: JSON.parse(JSON.stringify({ ...native.trace, blocks: native.blocks, responseId: message.responseId })) })
      return entry
    }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}

/** Adapt only generation phases; compaction and direct side requests never receive tools or titles. */
export function deepseekRegistry(registry: RegistryReader, getSpace: () => UserSpace): RegistryReader {
  const definition = GenerationTask.definition
  type Runtime = Parameters<typeof definition.phases.request>[1]
  const phases = Object.fromEntries(Object.entries(definition.phases).map(([name, handler]) => [name, async (task: any, runtime: Runtime, ctx: Context) => {
    const space = getSpace()
    const commit: Runtime['commit'] = (change, context) => runtime.commit((tx, current) => change(nativeTx(tx), current), context)
    let models = runtime.models
    let complete = () => {}
    if (name === 'request') {
      const agent = await runtime.agent(ctx), ref = agent.model
      if (ref && space.accounts.kind(ref.provider) === 'deepseek' && deepseekAppModel(ref.modelId)) {
        const branch = await space.db.get<{ id: string; treeId: string; role: string }>('SELECT id, treeId, role FROM branches WHERE conversationId = ?', runtime.conversationId)
        if (branch) {
          const tree = await space.row(branch.treeId)
          const edited = await space.db.get<{ manual: number }>('SELECT manual FROM deepseek_titles WHERE treeId = ?', tree.id)
          const view = await runtime.context(runtime.conversationId, ctx)
          const users = view.messages.filter(m => m.role === 'user')
          const last = users.at(-1), blocks = !last ? [] : typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content
          const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
          const search = space.plugins.list().some(p => p.id === 'web' && p.enabled) || blocks.some(b => b.type === 'text' && parseNote(b.text)?.mentions.some(m => m.kind === 'plugin' && m.id === 'web'))
          const first = users[0]?.content
          const firstText = typeof first === 'string' ? first : first?.filter(b => b.type === 'text' && !parseNote(b.text)).map(b => b.type === 'text' ? b.text : '').join('') ?? ''
          const title = branch.role === 'main' && !edited?.manual && (tree.title === DEFAULT_TITLE || tree.title === titleOf(firstText)) && users.length === 1
          const request: NativeRequest = { search, read: search || /https?:\/\/\S+/i.test(text), safety: space.preferences.get().deepseekSafety !== false, title, notify: trace => nativeState(space).publish(tree.id, branch.id, trace) }
          let response: DeepSeekMessage | undefined
          models = new Proxy(runtime.models, { get(target, key) {
            if (key === 'streamSimple') return (model: Model<any>, context: Parameters<typeof target.streamSimple>[1], options?: SimpleStreamOptions) => {
              const upstream = target.streamSimple(model, { ...context, messages: search ? withoutWeb(context.messages) : context.messages }, { ...options, [REQUEST]: request } as NativeOptions)
              void upstream.result().then(message => { response = message as DeepSeekMessage })
              return upstream
            }
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          } })
          complete = async () => {
            nativeState(space).traces.delete(branch.id)
            const nextTitle = response?.deepseek?.title?.trim()
            if (title && nextTitle) {
              await space.db.run('UPDATE trees SET title = ? WHERE id = ? AND title IN (?, ?) AND NOT EXISTS (SELECT 1 FROM deepseek_titles WHERE treeId = ? AND manual = 1)', nextTitle.slice(0, 200), tree.id, DEFAULT_TITLE, titleOf(firstText), tree.id)
              await space.changed()
            }
          }
        }
      }
    }
    const adapted = new Proxy(runtime, { get(target, key) {
      if (key === 'commit') return commit
      if (key === 'models') return models
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    try { await handler(task as never, adapted, ctx) } finally { await complete() }
  }])) as typeof definition.phases
  const task = { ...GenerationTask, definition: { ...definition, phases } }
  return {
    subscribe: listener => registry.subscribe(listener),
    snapshot: () => {
      const snapshot = registry.snapshot()
      return { ...snapshot, task: name => name === definition.name ? task : snapshot.task(name), tasks: () => snapshot.tasks().map(t => t.definition.name === definition.name ? task : t) }
    },
  }
}
