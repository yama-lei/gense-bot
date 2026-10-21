import type { WorkerEnv } from './env'
import { Agent, callable, type Connection, type ConnectionContext } from 'agents'
import { RoutedAgents } from 'agents/routing'
import { z } from 'zod'
import { builtinSkills, parseSkill } from '../src/skills'
import type { BranchNote, ChatMeta, DriveFile, HubState, Provider, TurnSettings } from '../src/types'
import type { Chat } from './chat'
import { Drive, MAX_UPLOAD_BYTES, type Folders, type TextCache } from './drive'
import { DRIVE_SCOPE, GrantRevokedError, authUrl, decrypt, encrypt, exchangeCode, refreshAccessToken, revoke } from './google'
import { defaultModel, listEndpointModels, pickCapabilities, providers } from './models'
import { availablePlugins, pluginIds } from './tools'

/** Header the Worker sets from the verified Access JWT; any client-supplied value is stripped. */
export const EMAIL_HEADER = 'x-gense-email'

const MODELS_TTL = 60 * 60 * 1000
const CAPS_TTL = 24 * 60 * 60 * 1000
const MODELS_DEV = 'https://models.dev/api.json'
const OAUTH_STATE_TTL = 10 * 60 * 1000
const MAX_SKILLS = 50
const SKILL_FILE = 'SKILL.md'
/** Folders per Drive query when looking for SKILL.md files; keeps the query string short. */
const QUERY_PARENTS = 25

const builtinInfo = builtinSkills.map(({ name, description }) => ({ name, description, source: 'builtin' as const }))

/** A skill read from GenseBot/Skills/<folder>/SKILL.md, kept until the file changes. */
interface DriveSkill {
  name: string
  description: string
  fileId: string
  folderId: string
  modifiedTime: number
}

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
    disabledSkills: z.array(z.string().max(64)).max(200),
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
    skills: builtinInfo,
    disabledSkills: [],
    skillsError: null,
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
    const skills = { skills: this.state.skills ?? builtinInfo, disabledSkills: this.state.disabledSkills ?? [], skillsError: this.state.skillsError ?? null }
    this.setState({ ...this.state, prefs, account, files: this.state.files ?? [], availablePlugins: available, enabledPlugins, ...skills })
    await this.syncChats()
    if (this.grant()) void this.refreshFiles()
    void this.refreshSkills()
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

  /** Deletes a chat with its side threads; forks are chats of their own and stay. */
  @callable()
  async deleteChat(id: string) {
    for (const c of this.state.chats) if (c.parent?.kind === 'side' && c.parent.chatId === id) await this.chats.delete(c.id)
    await this.chats.delete(id)
    await this.syncChats()
  }

  /**
   * A new chat holding a copy of `chatId` up to `messageId` (roadmap-2 "L0-3 会话树"): a fork
   * is listed like any chat; a side thread only shows beside its parent.
   */
  @callable()
  async forkChat(chatId: string, messageId: string, kind: 'fork' | 'side'): Promise<string> {
    const source = this.state.chats.find((c) => c.id === chatId)
    const src = source && (await this.chats.get(chatId))
    if (!source || !src) throw new Error('会话不存在')
    const at = z.string().min(1).max(100).parse(messageId)
    const messages = await src.pathTo(at)
    const title = kind === 'fork' ? `分支：${source.title.replace(/^分支：/, '')}`.slice(0, 40) : '支线'
    const entry = await this.chats.create({ metadata: { title, projectId: source.projectId, pinned: false, parent: { chatId, messageId: at, kind: z.enum(['fork', 'side']).parse(kind) } } })
    const stub = await this.chats.get(entry.id)
    await stub?.bind(this.name, entry.id)
    await stub?.importMessages(messages, await src.viewStates())
    await this.syncChats()
    return entry.id
  }

  /**
   * Summarizes a side thread back into its parent: a Markdown note in GenseBot/Artifacts when
   * Drive is connected, and a message in the parent chat that its model sees from then on.
   */
  @callable()
  async summarizeSide(sideId: string): Promise<BranchNote> {
    const side = this.state.chats.find((c) => c.id === sideId)
    if (side?.parent?.kind !== 'side') throw new Error('这不是一条支线')
    const main = this.state.chats.find((c) => c.id === side.parent?.chatId)
    const [sideStub, mainStub] = await Promise.all([this.chats.get(sideId), main && this.chats.get(main.id)])
    if (!main || !sideStub || !mainStub) throw new Error('主线会话已删除')
    const summary = await sideStub.summarize(side.parent.messageId)
    const note: BranchNote = { sideChatId: sideId, title: side.title, summary }
    if (this.grant()) {
      try {
        const { drive, folders } = await this.drive()
        const base = `支线总结 - ${main.title} - ${side.title}`.replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim()
        const file = await drive.create(folders, folders.artifacts, await drive.freeName(folders.artifacts, `${base}.md`), `# ${side.title}\n\n${summary}\n`)
        Object.assign(note, { fileId: file.id, fileName: file.name })
        void this.refreshFiles()
      } catch (e) {
        // The note still reaches the main chat; only the file copy is missing.
        console.warn('saving side summary failed', e)
      }
    }
    await mainStub.addNote(note)
    return note
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
    this.setState({ ...this.state, files: [], skills: builtinInfo, skillsError: null, account: { ...this.state.account, driveConnected: false, driveError: reason } })
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
      void this.refreshSkills()
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

  // ---- Skills (roadmap-2 "L2 Skills") ----

  /**
   * Re-reads GenseBot/Skills: each folder in it holding a valid SKILL.md is one skill. Built-in
   * skills always come first; a Drive skill with a name already taken is skipped and reported.
   */
  @callable()
  async refreshSkills() {
    if (!this.grant()) return this.setState({ ...this.state, skills: builtinInfo, skillsError: null })
    const kv = this.ctx.storage.kv
    try {
      const { drive, folders } = await this.drive()
      const dirs = (await drive.folders(await drive.skillsFolder(folders))).slice(0, MAX_SKILLS)
      const groups: string[][] = []
      for (let i = 0; i < dirs.length; i += QUERY_PARENTS) groups.push(dirs.slice(i, i + QUERY_PARENTS).map((d) => d.id))
      const files = (await Promise.all(groups.map((ids) => drive.named(SKILL_FILE, ids)))).flat()
      const cache = kv.get<Record<string, DriveSkill>>('driveSkills') ?? {}
      const problems: string[] = []
      const read = await Promise.all(
        dirs.map(async (dir): Promise<DriveSkill | null> => {
          const file = files.find((f) => f.parent === dir.id)
          if (!file) return problems.push(`${dir.name}：缺少 ${SKILL_FILE}`), null
          const hit = cache[dir.id]
          if (hit?.fileId === file.id && hit.modifiedTime === file.modifiedTime) return hit
          try {
            const doc = parseSkill((await drive.readText(file.id, folders)).text)
            if (doc) return { name: doc.name, description: doc.description, fileId: file.id, folderId: dir.id, modifiedTime: file.modifiedTime }
            problems.push(`${dir.name}：${SKILL_FILE} 开头缺少有效的 name 和 description`)
          } catch (e) {
            problems.push(`${dir.name}：${e instanceof Error ? e.message : String(e)}`)
          }
          return null
        }),
      )
      const found = read.filter((s): s is DriveSkill => !!s)
      kv.put('driveSkills', Object.fromEntries(found.map((s) => [s.folderId, s])))
      const taken = new Set(builtinInfo.map((s) => s.name))
      const fromDrive = found.flatMap((s) => {
        if (taken.has(s.name)) return problems.push(`${s.name}：与已有 Skill 重名，已跳过`), []
        taken.add(s.name)
        return [{ name: s.name, description: s.description, source: 'drive' as const }]
      })
      this.setState({ ...this.state, skills: [...builtinInfo, ...fromDrive], skillsError: problems.length ? `部分 Skill 没有加载：${problems.join('；')}` : null })
    } catch (e) {
      // Keep the last list; only explain why it may be stale.
      this.setState({ ...this.state, skillsError: e instanceof Error ? e.message : String(e) })
    }
  }

  /** The Drive entry of an enabled skill, or null for a built-in one. */
  private skill(name: string): DriveSkill | null {
    const info = this.state.skills.find((s) => s.name === name)
    if (!info || this.state.disabledSkills.includes(name)) throw new Error(`没有可用的 Skill「${name}」`)
    if (info.source === 'builtin') return null
    const entry = Object.values(this.ctx.storage.kv.get<Record<string, DriveSkill>>('driveSkills') ?? {}).find((s) => s.name === name)
    if (!entry) throw new Error(`Skill「${name}」需要重新读取，请在“定制”页刷新 Skills`)
    return entry
  }

  /** Files beside a skill's SKILL.md, one folder level deep, by path. */
  private async skillFiles(drive: Drive, folderId: string): Promise<{ path: string; id: string }[]> {
    const [top, dirs] = await Promise.all([drive.list(folderId, 'drive'), drive.folders(folderId)])
    const nested = await Promise.all(dirs.slice(0, 20).map(async (d) => (await drive.list(d.id, 'drive')).map((f) => ({ path: `${d.name}/${f.name}`, id: f.id }))))
    return [...top.map((f) => ({ path: f.name, id: f.id })), ...nested.flat()].filter((f) => f.path !== SKILL_FILE)
  }

  async loadSkill(name: string): Promise<{ body: string; resources: string[] }> {
    const entry = this.skill(name)
    if (!entry) return { body: builtinSkills.find((s) => s.name === name)!.body, resources: [] }
    const { drive, folders } = await this.drive()
    const [{ text }, files] = await Promise.all([drive.readText(entry.fileId, folders), this.skillFiles(drive, entry.folderId)])
    return { body: parseSkill(text)?.body ?? text, resources: files.map((f) => f.path) }
  }

  async readSkillResource(name: string, path: string): Promise<string> {
    const entry = this.skill(name)
    if (!entry) throw new Error(`内置 Skill「${name}」没有附带文件`)
    const { drive, folders } = await this.drive()
    const file = (await this.skillFiles(drive, entry.folderId)).find((f) => f.path === path.replace(/^\.?\//, ''))
    if (!file) throw new Error(`Skill「${name}」里没有 ${path}`)
    return (await drive.readText(file.id, folders, this.textCache)).text
  }

  /** Another chat of this user, as text (`chats_read`). */
  async chatText(id: string): Promise<{ title: string; text: string }> {
    const meta = this.state.chats.find((c) => c.id === id)
    const stub = meta && (await this.chats.get(id))
    if (!meta || !stub) throw new Error('会话不存在或已删除')
    return { title: meta.title, text: await stub.transcript() }
  }

  @callable()
  async readFile(id: string): Promise<{ file: DriveFile; text: string }> {
    const { drive, folders } = await this.drive()
    return drive.readText(z.string().min(1).max(200).parse(id), folders, this.textCache)
  }

  @callable()
  async searchDrive(query: string): Promise<DriveFile[]> {
    const { drive, folders } = await this.drive()
    return drive.search(z.string().min(1).max(200).parse(query), folders, 30)
  }

  // ---- RPC from the Worker and from Chat (not callable from clients) ----

  /** `POST /api/files`: any file, unchanged, into GenseBot/资料 (roadmap-2 R7). */
  async uploadFile(name: string, mimeType: string, bytes: ArrayBuffer): Promise<DriveFile> {
    const n = z.string().trim().min(1).max(200).parse(name.replace(/[\\/]+/g, ' '))
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(`「${n}」超过 20 MB 上限，未上传。`)
    const { drive, folders } = await this.drive()
    const file = await drive.upload(folders, folders.sources, await drive.freeName(folders.sources, n), mimeType, bytes)
    await this.refreshFiles()
    return file
  }

  /** Converted file text by `fileId:modifiedTime`; texts too large for one row are not kept. */
  readonly textCache: TextCache = {
    get: async (key) => {
      void this.sql`CREATE TABLE IF NOT EXISTS converted_text (key TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL)`
      return this.sql<{ text: string }>`SELECT text FROM converted_text WHERE key = ${key}`[0]?.text ?? null
    },
    put: async (key, text) => {
      if (text.length > 500_000) return
      void this.sql`CREATE TABLE IF NOT EXISTS converted_text (key TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL)`
      void this.sql`INSERT OR REPLACE INTO converted_text (key, text, at) VALUES (${key}, ${text}, ${Date.now()})`
      // Older versions of a file are never read again; keep the table small.
      void this.sql`DELETE FROM converted_text WHERE key NOT IN (SELECT key FROM converted_text ORDER BY at DESC LIMIT 200)`
    },
  }

  cachedText(key: string) {
    return this.textCache.get(key)
  }

  cacheText(key: string, text: string) {
    return this.textCache.put(key, text)
  }


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
    const skills = this.state.skills.filter((s) => !this.state.disabledSkills.includes(s.name)).map(({ name, description }) => ({ name, description }))
    return { enabledPlugins, memories: memories.map((m) => m.text), language: prefs.language, models, driveConnected: account.driveConnected, projectContext, skills }
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
