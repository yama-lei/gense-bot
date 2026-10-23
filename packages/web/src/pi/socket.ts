// The browser end of the host protocol (packages/core/src/protocol.ts). Reconnects, and re-watches after reconnecting.
import { applyImmutable, decoder, type Decoder } from '@earendil-works/chord/delta'
import type { ClientRequest, ModelInfo, ServerMessage, TreeMeta } from '@gense/core/protocol'
import type { View } from './turns'

export interface SocketState {
  email: string
  models: ModelInfo[]
  defaultModel: ModelInfo | null
  trees: TreeMeta[] | null
  views: Record<string, View>
  connected: boolean
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type Request = DistributiveOmit<ClientRequest, 'id'>

export class HostSocket {
  state: SocketState = { email: '', models: [], defaultModel: null, trees: null, views: {}, connected: false }
  #ws: WebSocket | undefined
  #next = 1
  #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  #decoders = new Map<string, Decoder>()
  #watched = new Set<string>()
  #listeners = new Set<() => void>()
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
      for (const treeId of this.#watched) void this.request({ t: 'watch', treeId }).catch(() => {})
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
        return this.#set({ email: m.email, models: m.models, defaultModel: m.defaultModel })
      case 'trees':
        return this.#set({ trees: m.trees })
      case 'view':
        this.#decoders.set(m.treeId, decoder())
        return this.#set({ views: { ...this.state.views, [m.treeId]: m.value as View } })
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

  /** Keeps exactly these trees watched. */
  watch(treeIds: string[]) {
    const next = new Set(treeIds)
    for (const id of this.#watched)
      if (!next.has(id)) {
        this.#watched.delete(id)
        this.#decoders.delete(id)
        void this.request({ t: 'unwatch', treeId: id }).catch(() => {})
      }
    for (const id of next)
      if (!this.#watched.has(id)) {
        this.#watched.add(id)
        void this.request({ t: 'watch', treeId: id }).catch(() => {})
      }
  }

  close() {
    this.#closed = true
    this.#ws?.close()
  }
}
