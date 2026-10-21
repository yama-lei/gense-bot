import type { WorkerEnv } from './env'
import { Agent, callable, type Connection, type ConnectionContext } from 'agents'
import { RoutedAgents } from 'agents/routing'
import { z } from 'zod'
import type { ChatMeta, DriveFile, HubState, Provider, TurnSettings } from '../src/types'
import type { Chat } from './chat'
import { Drive, MAX_TEXT_BYTES, isText, type Folders } from './drive'
import { DRIVE_SCOPE, GrantRevokedError, authUrl, decrypt, encrypt, exchangeCode, refreshAccessToken, revoke } from './google'
import { defaultModel, listEndpointModels, pickCapabilities, providers } from './models'
import { availablePlugins, pluginIds } from './tools'

/** Header the Worker sets from the verified Access JWT; any client-supplied value is stripped. */
export const EMAIL_HEADER = 'x-gense-email'

const MODELS_TTL = 60 * 60 * 1000
const CAPS_TTL = 24 * 60 * 60 * 1000
const MODELS_DEV = 'https://models.dev/api.json'
const OAUTH_STATE_TTL = 10 * 60 * 1000

/** What UserHub keeps about the Google grant; never part of the broadcast state. */
interface GoogleGrant {
  /** Refresh token, AES-GCM sealed. */
  refresh: string
  folders: Folders
}

/** Access token handed to a chat for one tool call. */
export interface DriveAccess {
  token: string
  folders: Folders
}

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
    enabledPlugins: [...pluginIds],
    availablePlugins: [...pluginIds],
    account: { name: '', email: '', driveConnected: false, driveError: null },
    files: [],
    models: [],
    modelsError: null,
  }

  /** Short-lived Google access token; lost on eviction, which only costs one refresh. */
  private access: { token: string; exp: number } | undefined

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env)
    this.lifecycle.use(this.chats)
  }

  async onStart() {
    const prefs = this.state.prefs.model ? this.state.prefs : { ...this.state.prefs, model: defaultModel(this.env) ?? '' }
    // The deployed code decides which plugins exist.
    // State saved by an older deployment may lack newer fields.
    const account = { ...this.state.account, driveConnected: !!this.grant(), driveError: this.state.account.driveError ?? null }
    // A plugin this user has never seen starts enabled; one they turned off stays off.
    const available = availablePlugins(this.env)
    const seen = this.ctx.storage.kv.get<string[]>('seenPlugins') ?? ['files', 'artifact']
    const enabledPlugins = [...this.state.enabledPlugins, ...available.filter((id) => !seen.includes(id) && !this.state.enabledPlugins.includes(id))]
    this.ctx.storage.kv.put('seenPlugins', [...new Set([...seen, ...available])])
    this.setState({ ...this.state, prefs, account, files: this.state.files ?? [], availablePlugins: available, enabledPlugins })
    await this.syncChats()
    if (this.grant()) void this.refreshFiles()
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

  // ---- Google Drive ----

  private grant() {
    return this.ctx.storage.kv.get<GoogleGrant>('google')
  }

  private setAccount(patch: Partial<HubState['account']>) {
    this.setState({ ...this.state, account: { ...this.state.account, ...patch } })
  }

  /** A valid access token, refreshed when it is about to expire. */
  async driveAccess(): Promise<DriveAccess> {
    const grant = this.grant()
    if (!grant) throw new Error('还没有连接 Google Drive。请先在“定制”页连接。')
    if (!this.access || this.access.exp < Date.now() + 60_000) {
      try {
        const t = await refreshAccessToken(this.env, await decrypt(this.env, grant.refresh))
        this.access = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 }
      } catch (e) {
        if (e instanceof GrantRevokedError) this.dropGrant(e.message)
        throw e
      }
    }
    return { token: this.access.token, folders: grant.folders }
  }

  private async drive() {
    const { token, folders } = await this.driveAccess()
    return { drive: new Drive(token), folders }
  }

  private dropGrant(reason: string | null) {
    this.ctx.storage.kv.delete('google')
    this.access = undefined
    this.setState({ ...this.state, files: [], account: { ...this.state.account, driveConnected: false, driveError: reason } })
  }

  /** Called by the Worker for `/oauth/google/start`; the state is single-use. */
  beginGoogleAuth(redirectUri: string): string {
    const state = crypto.randomUUID()
    this.ctx.storage.kv.put('oauthState', { state, exp: Date.now() + OAUTH_STATE_TTL })
    return authUrl(this.env, redirectUri, state, this.state.account.email)
  }

  /** Called by the Worker for the OAuth callback; a failure is shown on the customize page via `driveError`. */
  async finishGoogleAuth(params: { code?: string; state?: string; error?: string }, redirectUri: string) {
    const error = await this.completeGoogleAuth(params, redirectUri)
    if (error) this.setAccount({ driveError: error })
  }

  private async completeGoogleAuth({ code, state, error }: { code?: string; state?: string; error?: string }, redirectUri: string): Promise<string | null> {
    const kv = this.ctx.storage.kv
    const saved = kv.get<{ state: string; exp: number }>('oauthState')
    kv.delete('oauthState')
    if (!saved || saved.state !== state || saved.exp < Date.now()) return '授权请求已过期，请重新连接。'
    if (error) return error === 'access_denied' ? '你取消了 Google 授权。' : `Google 授权失败：${error}`
    if (!code) return 'Google 没有返回授权码，请重新连接。'
    try {
      const t = await exchangeCode(this.env, code, redirectUri)
      if (!t.scope?.split(' ').includes(DRIVE_SCOPE)) return '没有获得 Drive 权限。请在 Google 授权页勾选“查看、修改、创建和删除您的所有 Google 云端硬盘文件”。'
      if (!t.refresh_token) return 'Google 没有返回 refresh token，请重新连接。'
      const old = this.grant()
      if (old) await revoke(await decrypt(this.env, old.refresh).catch(() => ''))
      const folders = await new Drive(t.access_token).ensureFolders()
      kv.put('google', { refresh: await encrypt(this.env, t.refresh_token), folders } satisfies GoogleGrant)
      this.access = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 }
      this.setAccount({ driveConnected: true, driveError: null })
      await this.refreshFiles()
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  @callable()
  async disconnectDrive() {
    const grant = this.grant()
    if (grant) await revoke(await decrypt(this.env, grant.refresh).catch(() => ''))
    this.dropGrant(null)
  }

  /** Re-reads GenseBot/资料 and GenseBot/Artifacts into the broadcast file list. */
  @callable()
  async refreshFiles() {
    if (!this.grant()) return
    try {
      const { drive, folders } = await this.drive()
      const [sources, artifacts] = await Promise.all([drive.list(folders.sources, 'source'), drive.list(folders.artifacts, 'artifact')])
      this.setState({ ...this.state, files: [...sources, ...artifacts], account: { ...this.state.account, driveError: null } })
    } catch (e) {
      if (this.grant()) this.setAccount({ driveError: e instanceof Error ? e.message : String(e) })
    }
  }

  @callable()
  async readFile(id: string): Promise<{ file: DriveFile; text: string }> {
    const { drive, folders } = await this.drive()
    return drive.readText(z.string().min(1).max(200).parse(id), folders)
  }

  @callable()
  async searchDrive(query: string): Promise<DriveFile[]> {
    const { drive, folders } = await this.drive()
    return drive.search(z.string().min(1).max(200).parse(query), folders, 30)
  }

  /** Uploads a text file into GenseBot/资料 (Spec S5: text only, at most 2 MB). */
  @callable()
  async uploadFile(name: string, text: string): Promise<DriveFile> {
    const n = z.string().min(1).max(200).parse(name)
    const body = z.string().parse(text)
    if (!isText('', n)) throw new Error(`「${n}」不是文本文件。首版只支持 .md、.txt、.csv、.json 等文本资料。`)
    if (new TextEncoder().encode(body).length > MAX_TEXT_BYTES) throw new Error(`「${n}」超过 2 MB 上限，未上传。`)
    const { drive, folders } = await this.drive()
    const file = await drive.create(folders, folders.sources, await drive.freeName(folders.sources, n), body)
    await this.refreshFiles()
    return file
  }

  // ---- RPC from Chat (not callable from clients) ----

  /** A chat wrote to Drive; refresh the list in the background. */
  filesChanged() {
    void this.refreshFiles()
  }

  /** Settings a chat needs to run one turn. */
  turnSettings(chatId?: string): TurnSettings {
    const { enabledPlugins, memories, prefs, models, account, chats, projects } = this.state
    const projectId = chats.find((c) => c.id === chatId)?.projectId
    const project = projects.find((p) => p.id === projectId)
    const projectContext = project ? [`项目：${project.name}`, project.description.trim()].filter(Boolean).join('\n') : ''
    return { enabledPlugins, memories: memories.map((m) => m.text), language: prefs.language, models, driveConnected: account.driveConnected, projectContext }
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
