// The browser end of the host protocol (packages/core/src/protocol.ts). Reconnects, and re-watches after reconnecting.
import { applyImmutable, decoder, type Decoder } from '@earendil-works/chord/delta'
import type { AuthEvent, AuthType } from '@earendil-works/pi-ai'
import type { BranchesState, ClientRequest, LoginPrompt, ModelInfo, ProviderState, ScheduleInfo, ServerMessage, SkillInfo, TreeMeta, WebhookInfo } from '@gense/core/protocol'
import type { PluginState } from '@gense/core/catalog'
import type { View } from './turns'

export interface SocketState {
  email: string
  models: ModelInfo[]
  defaultModel: ModelInfo | null
  trees: TreeMeta[] | null
  views: Record<string, View>
  /** Per watched tree, its branches (R35), and which one `views` shows. */
  branches: Record<string, BranchesState>
  shown: Record<string, string>
  /** The user's plugin switches and settings; null until the host sends them. */
  plugins: PluginState[] | null
  skills: SkillInfo[]
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
  state: SocketState = { email: '', models: [], defaultModel: null, trees: null, views: {}, branches: {}, shown: {}, plugins: null, skills: [], schedules: [], webhooks: [], canCreateWebhooks: true, providers: [], connected: false }
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
        return this.#set({ email: m.email })
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
        return this.#set({ skills: m.skills })
      case 'schedules':
        return this.#set({ schedules: m.schedules })
      case 'webhooks':
        return this.#set({ webhooks: m.webhooks, canCreateWebhooks: m.canCreate })
      case 'trees':
        return this.#set({ trees: m.trees })
      case 'branches': {
        const { t: _, treeId, ...state } = m
        return this.#set({ branches: { ...this.state.branches, [treeId]: state } })
      }
      case 'view':
        this.#decoders.set(m.treeId, decoder())
        if (this.#watched.has(m.treeId)) this.#watched.set(m.treeId, m.branchId)
        return this.#set({ views: { ...this.state.views, [m.treeId]: m.value as View }, shown: { ...this.state.shown, [m.treeId]: m.branchId } })
      case 'ops': {
        const dec = this.#decoders.get(m.treeId)
        if (!dec) return
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
