// The browser end of the protocol (packages/protocol). Reconnects, and re-watches after reconnecting.
import { applyImmutable, decoder, type Decoder } from '@earendil-works/chord/delta'
import type { AuthEvent, AuthType } from '@earendil-works/pi-ai'
import type {
  BranchesState,
  ChannelInfo,
  ClientRequest,
  ExportInfo,
  Feedback,
  LoginPrompt,
  Memory,
  ModelInfo,
  PluginInfo,
  Preferences,
  Project,
  ShareInfo,
  ProviderState,
  ScheduleInfo,
  ServerMessage,
  NativeTrace,
  Suggestions,
  SkillInfo,
  TreeMeta,
  WebhookInfo,
} from '@gense/protocol'
import type { View } from './turns'

export interface SocketState {
  models: ModelInfo[]
  defaultModel: ModelInfo | null
  /** Conversations to list; temporary chats are kept apart in `temporary` (roadmap-7 B5). */
  trees: TreeMeta[] | null
  temporary: TreeMeta[]
  views: Record<string, View>
  /** Per watched tree, its branches (R35), and which one `views` shows. */
  branches: Record<string, BranchesState>
  shown: Record<string, string>
  /** Null until the server sends them. */
  plugins: PluginInfo[] | null
  skills: SkillInfo[]
  canInstallSkills: boolean
  channels: ChannelInfo[] | null
  prefs: Preferences | null
  /** Null until the server sends them (roadmap-7 A). */
  memories: Memory[] | null
  projects: Project[] | null
  shares: ShareInfo[] | null
  /** Per watched tree, its answers' 👍 / 👎 by turn id (roadmap-7 D1). */
  feedback: Record<string, Record<string, Feedback>>
  /** Per watched tree, follow-ups for its newest answer (D2). */
  suggestions: Record<string, Suggestions>
  /** What DeepSeek is doing for the answer being written, per tree (roadmap-7 C2); the entry replaces it once saved. */
  native: Record<string, { branchId: string; trace: NativeTrace }>
  /** Inbox items read on any device (D3); null until the server sends them. */
  inboxRead: string[] | null
  exports: ExportInfo[]
  schedules: ScheduleInfo[]
  webhooks: WebhookInfo[]
  canCreateWebhooks: boolean
  /** Model services the user can sign in to (R62). */
  providers: ProviderState[]
  connected: boolean
}

/** What a running login shows: its events, and the prompts it waits on until each is answered or done. */
export interface LoginHandlers {
  event(event: AuthEvent): void
  prompt(promptId: string, prompt: LoginPrompt): void
  promptDone(promptId: string): void
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type Request = DistributiveOmit<ClientRequest, 'id'>

export class HostSocket {
  state: SocketState = {
    models: [],
    defaultModel: null,
    trees: null,
    temporary: [],
    views: {},
    branches: {},
    shown: {},
    plugins: null,
    skills: [],
    canInstallSkills: true,
    channels: null,
    prefs: null,
    memories: null,
    projects: null,
    shares: null,
    feedback: {},
    suggestions: {},
    native: {},
    inboxRead: null,
    exports: [],
    schedules: [],
    webhooks: [],
    canCreateWebhooks: true,
    providers: [],
    connected: false,
  }
  #ws: WebSocket | undefined
  #next = 1
  #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  #decoders = new Map<string, Decoder>()
  /** Watched trees, with the branch asked for (undefined: the tree's active one). */
  #watched = new Map<string, string | undefined>()
  #listeners = new Set<() => void>()
  #logins = new Map<string, LoginHandlers>()
  #promptLogins = new Map<string, string>()
  #retry = 0
  #closed = false
  #onUnauthorized: () => void

  constructor(onUnauthorized: () => void) {
    this.#onUnauthorized = onUnauthorized
    this.#connect()
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  #set(patch: Partial<SocketState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.#listeners) l()
  }

  #connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    this.#ws = ws
    let opened = false
    ws.onopen = () => {
      opened = true
      this.#retry = 0
      this.#set({ connected: true })
      for (const [treeId, branchId] of this.#watched) void this.request({ t: 'watch', treeId, ...(branchId && { branchId }) }).catch(() => {})
    }
    ws.onmessage = (event) => this.#receive(JSON.parse(String(event.data)) as ServerMessage)
    ws.onclose = () => {
      for (const p of this.#pending.values()) p.reject(new Error('连接已断开，请重试'))
      this.#pending.clear()
      this.#set({ connected: false })
      if (this.#closed) return
      // A refused upgrade never opens; the session is probably gone.
      if (!opened && this.#retry >= 1) {
        void fetch('/api/me').then((r) => r.status === 401 && this.#onUnauthorized(), () => {})
      }
      setTimeout(() => this.#connect(), Math.min(10_000, 500 * 2 ** this.#retry++))
    }
  }

  #receive(m: ServerMessage) {
    switch (m.t) {
      case 'hello':
        return
      case 'models':
        return this.#set({ models: m.models, defaultModel: m.defaultModel })
      case 'providers':
        return this.#set({ providers: m.providers })
      case 'auth.event':
        return this.#logins.get(m.loginId)?.event(m.event)
      case 'auth.prompt':
        this.#promptLogins.set(m.promptId, m.loginId)
        return this.#logins.get(m.loginId)?.prompt(m.promptId, m.prompt)
      case 'auth.prompt.done': {
        const loginId = this.#promptLogins.get(m.promptId)
        this.#promptLogins.delete(m.promptId)
        return loginId && this.#logins.get(loginId)?.promptDone(m.promptId)
      }
      case 'plugins':
        return this.#set({ plugins: m.plugins })
      case 'skills':
        return this.#set({ skills: m.skills, canInstallSkills: m.canInstall })
      case 'channels':
        return this.#set({ channels: m.channels })
      case 'prefs': {
        // The assistant's notion of "today" follows the browser (roadmap-6 A10).
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
        if (timeZone && m.prefs.timeZone !== timeZone) void this.request({ t: 'prefs.set', timeZone }).catch(() => {})
        return this.#set({ prefs: m.prefs })
      }
      case 'memories':
        return this.#set({ memories: m.memories })
      case 'projects':
        return this.#set({ projects: m.projects })
      case 'shares':
        return this.#set({ shares: m.shares })
      case 'feedback':
        return this.#set({ feedback: { ...this.state.feedback, [m.treeId]: Object.fromEntries(m.feedback.map((f) => [f.turnId, f])) } })
      case 'native':
        return this.#set({ native: { ...this.state.native, [m.treeId]: { branchId: m.branchId, trace: m.trace } } })
      case 'suggestions': {
        const { t: _, treeId, ...s } = m
        return this.#set({ suggestions: { ...this.state.suggestions, [treeId]: s } })
      }
      case 'inboxRead':
        return this.#set({ inboxRead: m.ids })
      case 'exports':
        return this.#set({ exports: m.exports })
      case 'schedules':
        return this.#set({ schedules: m.schedules })
      case 'webhooks':
        return this.#set({ webhooks: m.webhooks, canCreateWebhooks: m.canCreate })
      case 'trees':
        return this.#set({ trees: m.trees.filter((t) => !t.temporary), temporary: m.trees.filter((t) => t.temporary) })
      case 'branches': {
        const { t: _, treeId, ...state } = m
        return this.#set({ branches: { ...this.state.branches, [treeId]: state } })
      }
      case 'view':
        if (!this.#watched.has(m.treeId)) return
        this.#decoders.set(m.treeId, decoder())
        this.#watched.set(m.treeId, m.branchId)
        return this.#set({ views: { ...this.state.views, [m.treeId]: m.value as View }, shown: { ...this.state.shown, [m.treeId]: m.branchId } })
      case 'ops': {
        const dec = this.#decoders.get(m.treeId)
        if (!dec || !this.state.views[m.treeId]) return
        const view = applyImmutable(this.state.views[m.treeId], dec.decode(m.ops))
        return this.#set({ views: { ...this.state.views, [m.treeId]: view } })
      }
      case 'reply': {
        const p = this.#pending.get(m.id)
        this.#pending.delete(m.id)
        if (m.error !== undefined) p?.reject(new Error(m.error))
        else p?.resolve(m.value)
      }
    }
  }

  request<T = unknown>(r: Request): Promise<T> {
    const ws = this.#ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('连接已断开，请稍后重试'))
    const id = this.#next++
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      ws.send(JSON.stringify({ ...r, id }))
    })
  }

  /** Runs a login on the host; resolves when it succeeds. */
  login(provider: string, type: AuthType, handlers: LoginHandlers) {
    const loginId = crypto.randomUUID()
    this.#logins.set(loginId, handlers)
    const done = this.request<void>({ t: 'auth.login', loginId, provider, type })
    void done.finally(() => this.#logins.delete(loginId)).catch(() => {})
    return { done, cancel: () => void this.request({ t: 'auth.cancel', loginId }).catch(() => {}) }
  }

  /** Keeps exactly these trees watched. */
  watch(treeIds: string[]) {
    const next = new Set(treeIds)
    for (const id of this.#watched.keys())
      if (!next.has(id)) {
        this.#watched.delete(id)
        this.#decoders.delete(id)
        void this.request({ t: 'unwatch', treeId: id }).catch(() => {})
        // Its view stops updating here; keeping it would show a stale transcript on the way back.
        const { [id]: _view, ...views } = this.state.views
        this.#set({ views })
      }
    for (const id of next)
      if (!this.#watched.has(id)) {
        this.#watched.set(id, undefined)
        void this.request({ t: 'watch', treeId: id }).catch(() => {})
      }
  }

  /** Shows another branch of a watched tree; it becomes the tree's active one. */
  async showBranch(treeId: string, branchId: string) {
    if (!this.#watched.has(treeId)) return
    this.#watched.set(treeId, branchId)
    await this.request({ t: 'watch', treeId, branchId })
  }

  close() {
    this.#closed = true
    this.#ws?.close()
  }
}
