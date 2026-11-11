// The app's data: the server's state over one WebSocket (lib/socket.ts), what this browser keeps for itself, and the
// actions pages call. Failures of actions nobody awaits become toasts.
import type { BranchMeta, BranchesState, Effort, FileEntry, FilePreview, ModelInfo, ToolCallResult, UploadedFile, UserInfo } from '@gense/protocol'
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { toast } from 'sonner'
import { errorText, fileBase64, saveBlob, toBlob } from '../lib/format'
import { localStore, useLocal } from '../lib/local'
import { HostSocket, type SocketState } from '../lib/socket'
import { toolIndex } from '../lib/tools'
import { toTurns } from '../lib/turns'
import type { Attachment, Outgoing, Turn } from '../lib/types'

export const MAX_UPLOAD = 20 * 1024 * 1024

/** Choices that stay in this browser. `model` is `provider:id`; empty follows the server's default. */
export const localPrefs = localStore('gense.prefs', { model: '', effort: 'medium' as Effort, sidebar: true })
export const useLocalPrefs = () => useLocal(localPrefs)

/** View state (an edited draft, a filled form) per call, keyed `treeId:callId`; kept in this browser. */
const viewStates = localStore<Record<string, unknown>>('gense.viewStates', {})
const VIEW_STATES_KEPT = 400

export const modelKey = (m: ModelInfo) => `${m.provider}:${m.id}`
export const report = (e: unknown) => void toast.error(errorText(e))

export class Client {
  readonly socket: HostSocket
  #onUnauthorized: () => void
  #files: Record<string, FileEntry[]> = {}
  #fileListeners = new Set<() => void>()

  constructor(socket: HostSocket, onUnauthorized: () => void) {
    this.socket = socket
    this.#onUnauthorized = onUnauthorized
  }

  request: HostSocket['request'] = (r) => this.socket.request(r)

  /** The model new messages go to: the one chosen here while the server still offers it, else the server's default. */
  model(): ModelInfo | null {
    const { models, defaultModel } = this.socket.state
    return models.find((m) => modelKey(m) === localPrefs.get().model) ?? defaultModel
  }

  #send(treeId: string, message: Outgoing, replace?: number) {
    const model = this.model()
    const branchId = this.socket.state.shown[treeId]
    const attachments = message.attachments?.map((a) => a.id)
    return this.request<{ branchId: string }>({
      t: 'send',
      treeId,
      ...(branchId && { branchId }),
      ...(replace !== undefined && { replace }),
      text: message.text,
      requestId: crypto.randomUUID(),
      ...(model && { model }),
      effort: localPrefs.get().effort,
      ...(attachments?.length && { attachments }),
      ...(message.command && { command: message.command }),
      ...(message.mentions?.length && { mentions: message.mentions }),
    })
  }

  /** A new conversation with its first message; resolves to its id. */
  async start(message: Outgoing) {
    const tree = await this.request<{ id: string }>({ t: 'tree.create' })
    await this.#send(tree.id, message)
    return tree.id
  }

  send = (treeId: string, message: Outgoing) => this.#send(treeId, message)

  showBranch = (treeId: string, branchId: string) => void this.socket.showBranch(treeId, branchId).catch(report)

  /** Asks the turn's message again, as a new version beside it. */
  regenerate = (treeId: string, turn: Turn) => {
    const branchId = this.socket.state.shown[treeId]
    const model = this.model()
    if (!branchId) return
    void this.request<BranchMeta>({
      t: 'regenerate',
      treeId,
      branchId,
      entryId: Number(turn.id),
      requestId: crypto.randomUUID(),
      ...(model && { model }),
      effort: localPrefs.get().effort,
    }).then((b) => this.showBranch(treeId, b.id), report)
  }

  edit = (treeId: string, turn: Turn, text: string) =>
    void this.#send(treeId, { text }, Number(turn.id)).then((r) => this.showBranch(treeId, r.branchId), report)

  /** A side branch that continues from the end of `turn`. */
  fork = (treeId: string, turn: Turn) => {
    const branchId = this.socket.state.shown[treeId]
    if (!branchId || turn.lastEntryId === undefined) return
    void this.request<BranchMeta>({ t: 'branch.fork', treeId, branchId, at: turn.lastEntryId }).then((b) => this.showBranch(treeId, b.id), report)
  }

  summarize = (treeId: string) => {
    const branchId = this.socket.state.shown[treeId]
    if (branchId) void this.request({ t: 'branch.summarize', treeId, branchId, requestId: crypto.randomUUID() }).catch(report)
  }

  stop = (treeId: string) => {
    const branchId = this.socket.state.shown[treeId]
    void this.request({ t: 'abort', treeId, ...(branchId && { branchId }) }).catch(report)
  }

  async upload(file: File): Promise<Attachment> {
    if (file.size > MAX_UPLOAD) throw new Error(`${file.name} 超过 20 MB`)
    const u = await this.request<UploadedFile>({ t: 'upload', name: file.name, base64: await fileBase64(file) })
    return { id: u.id, name: u.name, size: u.size }
  }

  // The workspace listings of the conversations whose files were asked for.
  files = (treeId: string): FileEntry[] | undefined => this.#files[treeId]
  subscribeFiles = (listener: () => void) => {
    this.#fileListeners.add(listener)
    return () => void this.#fileListeners.delete(listener)
  }
  refreshFiles = (treeId: string) =>
    this.request<FileEntry[]>({ t: 'files.list', treeId }).then((files) => {
      this.#files = { ...this.#files, [treeId]: files }
      for (const l of this.#fileListeners) l()
    })

  previewFile = (treeId: string, path: string) => this.request<FilePreview>({ t: 'files.preview', treeId, path })

  async readFile(treeId: string, path: string) {
    const file = await this.request<{ name: string; mimeType: string; base64: string }>({ t: 'files.read', treeId, path })
    return { name: file.name, blob: toBlob(file.mimeType, file.base64) }
  }

  downloadFile = (treeId: string, path: string) => this.readFile(treeId, path).then((f) => saveBlob(f.name, f.blob))

  async deleteFile(treeId: string, path: string) {
    await this.request({ t: 'files.delete', treeId, path })
    await this.refreshFiles(treeId)
  }

  /** A view's own tool call; a failure comes back as an error result, as MCP reports one. */
  callTool = (treeId: string, pluginId: string, name: string, args: unknown) =>
    this.request<ToolCallResult>({ t: 'tool.call', treeId, pluginId, name, args }).catch((e: unknown): ToolCallResult => ({ content: errorText(e), isError: true }))

  setViewState = (treeId: string, callId: string, state: unknown) =>
    viewStates.set((all) => {
      const { [`${treeId}:${callId}`]: _old, ...rest } = all
      const kept = Object.entries(rest).slice(-VIEW_STATES_KEPT + 1)
      return Object.fromEntries([...kept, [`${treeId}:${callId}`, state]])
    })

  async logout() {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {})
    this.socket.close()
    this.#onUnauthorized()
  }
}

const Context = createContext<Client | null>(null)

const UserContext = createContext<UserInfo | null>(null)

/** The signed-in account. */
export function useUser() {
  const user = useContext(UserContext)
  if (!user) throw new Error('useUser outside AppProvider')
  return user
}

export function AppProvider({ user, onUnauthorized, children }: { user: UserInfo; onUnauthorized: () => void; children: ReactNode }) {
  // Made in an effect: StrictMode mounts twice, and a socket closed by the first unmount must not be the one in use.
  const [client, setClient] = useState<Client | null>(null)
  useEffect(() => {
    const made = new Client(new HostSocket(onUnauthorized), onUnauthorized)
    setClient(made)
    return () => made.socket.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    client && (
      <Context.Provider value={client}>
        <UserContext.Provider value={user}>{children}</UserContext.Provider>
      </Context.Provider>
    )
  )
}

export function useClient() {
  const client = useContext(Context)
  if (!client) throw new Error('useClient outside AppProvider')
  return client
}

/** The server's state; re-renders on every change, so read it near where it is used. */
export function useHost(): SocketState {
  const { socket } = useClient()
  return useSyncExternalStore(
    (l) => socket.subscribe(l),
    () => socket.state,
  )
}

export function useTools() {
  const { plugins } = useHost()
  return useMemo(() => toolIndex(plugins), [plugins])
}

export const useViewState = (treeId: string, callId: string) => useLocal(viewStates)[`${treeId}:${callId}`]

/** Each turn's versions: the branches that continue its anchor with their own message, and the one that wrote this one. */
const withVersions = (turns: Turn[], state: BranchesState | undefined) => {
  if (!state) return turns
  for (const t of turns) {
    const ids = t.anchor ? state.versions[t.anchor] : undefined
    if (!ids || ids.length < 2) continue
    const index = ids.findIndex((id) => state.branches.find((b) => b.id === id)?.conversationId === t.writer)
    if (index >= 0) t.versions = { ids, index }
  }
  return turns
}

/** The open conversation: its turns once the view arrives, its branches and the one shown. */
export function useChat(treeId: string) {
  const host = useHost()
  const view = host.views[treeId]
  const branches = host.branches[treeId]
  const turns = useMemo(() => (view ? withVersions(toTurns(view), branches) : []), [view, branches])
  const branchId = host.shown[treeId]
  return {
    tree: host.trees?.find((t) => t.id === treeId),
    loaded: !!view,
    turns,
    branches,
    branch: branches?.branches.find((b) => b.id === branchId),
    running: turns.some((t) => t.status === 'running' || t.status === 'queued'),
    entryCount: view?.entries.length ?? 0,
  }
}

/** A conversation's files, loaded on first use and again whenever its transcript grows (a tool may have written some). */
export function useFiles(treeId: string, active: boolean, entryCount: number) {
  const client = useClient()
  const files = useSyncExternalStore(client.subscribeFiles, () => client.files(treeId))
  useEffect(() => {
    if (active) client.refreshFiles(treeId).catch(report)
  }, [client, treeId, active, entryCount])
  return files
}
