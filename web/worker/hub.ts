import type { WorkerEnv } from './env'
import { Agent, callable, type Connection, type ConnectionContext } from 'agents'
import { RoutedAgents } from 'agents/routing'
import { z } from 'zod'
import type { ChatMeta, HubState, Provider, TurnSettings } from '../src/types'
import type { Chat } from './chat'
import { defaultModel, listEndpointModels, pickCapabilities, providers } from './models'
import { pluginTools } from './tools'

/** Header the Worker sets from the verified Access JWT; any client-supplied value is stripped. */
export const EMAIL_HEADER = 'x-gense-email'

const MODELS_TTL = 60 * 60 * 1000
const CAPS_TTL = 24 * 60 * 60 * 1000
const MODELS_DEV = 'https://models.dev/api.json'

type Meta = Omit<ChatMeta, 'id' | 'updatedAt'>

const effort = z.enum(['low', 'medium', 'high'])
const patchSchema = z
  .object({
    projects: z.array(z.object({ id: z.string().max(64), name: z.string().max(200), description: z.string().max(4000), pinned: z.boolean() })).max(500),
    memories: z.array(z.object({ id: z.string().max(64), text: z.string().max(2000) })).max(200),
    prefs: z.object({ language: z.string().max(32), defaultEffort: effort, model: z.string().max(200) }),
    enabledPlugins: z.array(z.string().max(64)).max(50),
  })
  .partial()
  .strict()

const chatPatchSchema = z
  .object({ title: z.string().min(1).max(200), projectId: z.string().max(64).nullable(), pinned: z.boolean() })
  .partial()
  .strict()

/**
 * One per signed-in user, named by the Access `sub` (architecture "Agent 拓扑").
 * Owns the chat catalog and everything shared across chats; every chat is its own top-level
 * Chat Durable Object reached through `/agents/hub/chats/<id>`.
 */
export class UserHub extends Agent<WorkerEnv, HubState> {
  readonly chats = new RoutedAgents<Chat, Meta>({ namespace: this.env.Chat, route: 'chats' })

  initialState: HubState = {
    chats: [],
    projects: [],
    memories: [],
    prefs: { language: 'zh-CN', defaultEffort: 'medium', model: '' },
    enabledPlugins: Object.keys(pluginTools),
    availablePlugins: Object.keys(pluginTools),
    account: { name: '', email: '', driveConnected: false },
    models: [],
    modelsError: null,
  }

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env)
    this.lifecycle.use(this.chats)
  }

  async onStart() {
    const prefs = this.state.prefs.model ? this.state.prefs : { ...this.state.prefs, model: defaultModel(this.env) ?? '' }
    // The deployed code decides which plugins exist.
    this.setState({ ...this.state, prefs, availablePlugins: Object.keys(pluginTools) })
    await this.syncChats()
    if (Date.now() - (this.ctx.storage.kv.get<number>('modelsAt') ?? 0) > MODELS_TTL) void this.refreshModels()
  }

  // Clients only read state; every write goes through a callable that validates it.
  validateStateChange(_next: HubState, source: Connection | 'server') {
    if (source !== 'server') throw new Error('state is read-only for clients')
  }

  onConnect(_connection: Connection, ctx: ConnectionContext) {
    const email = ctx.request.headers.get(EMAIL_HEADER)
    if (email && email !== this.state.account.email) {
      this.setState({ ...this.state, account: { ...this.state.account, email, name: email.split('@')[0] } })
    }
  }

  @callable()
  async createChat(title: string, projectId: string | null): Promise<string> {
    const meta = chatPatchSchema.required({ title: true }).parse({ title: title.replace(/\s+/g, ' ').trim().slice(0, 40) || '新会话', projectId })
    const entry = await this.chats.create({ metadata: { title: meta.title, projectId: meta.projectId ?? null, pinned: false } })
    const stub = await this.chats.get(entry.id)
    await stub?.bind(this.name, entry.id)
    await this.syncChats()
    return entry.id
  }

  @callable()
  async updateChat(id: string, patch: Partial<Meta>) {
    const current = this.state.chats.find((c) => c.id === id)
    if (!current) throw new Error('会话不存在')
    const { id: _, updatedAt: __, ...meta } = current
    await this.chats.setMetadata(id, { ...meta, ...chatPatchSchema.parse(patch) })
    await this.syncChats()
  }

  @callable()
  async deleteChat(id: string) {
    await this.chats.delete(id)
    await this.syncChats()
  }

  @callable()
  update(patch: z.infer<typeof patchSchema>) {
    this.setState({ ...this.state, ...patchSchema.parse(patch) })
  }

  /** Lists the endpoints' models (cached 1 h) and decorates them with models.dev capabilities (cached 1 day). */
  @callable()
  async refreshModels() {
    const kv = this.ctx.storage.kv
    try {
      // A failing endpoint falls back to its default model alone (architecture "模型列表").
      const errors: string[] = []
      const lists = await Promise.all(
        providers(this.env).map(async (p) => ({
          p,
          ids: await listEndpointModels(this.env, p).catch((e: unknown) => {
            errors.push(`${p}：${e instanceof Error ? e.message : String(e)}`)
            return [] as string[]
          }),
        })),
      )
      let caps = kv.get<{ at: number; api: Record<string, unknown> }>('modelsDev')
      if (!caps || Date.now() - caps.at > CAPS_TTL) {
        const res = await fetch(MODELS_DEV)
        // models.dev only adds capabilities; a failure leaves them unknown rather than failing the list.
        if (res.ok) {
          const api = (await res.json()) as Record<string, unknown>
          // Keep only the providers we use; the full file is several MB.
          caps = { at: Date.now(), api: { anthropic: api.anthropic, openai: api.openai } }
          kv.put('modelsDev', caps)
        }
      }
      const defaults: Record<Provider, string | undefined> = { anthropic: this.env.DEFAULT_ANTHROPIC_MODEL, openai: this.env.DEFAULT_OPENAI_MODEL }
      const models = lists.flatMap(({ p, ids }) => {
        // The configured default is always offered, even when the endpoint does not list it.
        const all = [...new Set([defaults[p], ...ids].filter((id): id is string => !!id))]
        const known = pickCapabilities(caps?.api, p, all)
        // A multi-API proxy may list every model on both endpoints; the Anthropic endpoint
        // keeps only models models.dev knows as Anthropic's.
        const shown = p === 'anthropic' ? all.filter((id) => known[id] || id === defaults[p]) : all
        return shown.map((id) => {
          const { name, ...c } = known[id] ?? {}
          return { provider: p, id, name: name ?? id, capabilities: known[id] ? (c as NonNullable<HubState['models'][number]['capabilities']>) : null }
        })
      })
      kv.put('modelsAt', Date.now())
      this.setState({ ...this.state, models, modelsError: errors.length ? `列表获取失败（${errors.join('；')}）` : null })
    } catch (e) {
      this.setState({ ...this.state, modelsError: e instanceof Error ? e.message : String(e) })
    }
  }

  // ---- RPC from Chat (not callable from clients) ----

  /** Settings a chat needs to run one turn. */
  turnSettings(): TurnSettings {
    const { enabledPlugins, memories, prefs, models } = this.state
    return { enabledPlugins, memories: memories.map((m) => m.text), language: prefs.language, models }
  }

  /** Bumps the chat to the top of the list after a turn and remembers the model chosen. */
  async recordTurn(chatId: string, model: string) {
    const current = this.state.chats.find((c) => c.id === chatId)
    if (!current) return
    const { id: _, updatedAt: __, ...meta } = current
    await this.chats.setMetadata(chatId, meta)
    if (model && model !== this.state.prefs.model) this.setState({ ...this.state, prefs: { ...this.state.prefs, model } })
    await this.syncChats()
  }

  private async syncChats() {
    const chats = (await this.chats.list()).map((e): ChatMeta => ({ title: '新会话', projectId: null, pinned: false, ...e.metadata, id: e.id, updatedAt: e.updatedAt }))
    this.setState({ ...this.state, chats })
  }
}
