// The app's data: the server's state over one WebSocket (lib/socket.ts), what this browser keeps for itself, and the
// actions pages call. Failures of actions nobody awaits become toasts.
import type { BranchMeta, BranchesState, CompactionOutcome, Effort, ExportInfo, FeedbackReason, FileEntry, FileKind, LibraryPage, FilePreview, Memory, MemorySource, ModelInfo, Preferences, Project, ShareInfo, ShareSnapshot, ToolCallResult, TreeMeta, UploadedFile, UserInfo } from '@gense/protocol'
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { toast } from 'sonner'
import { errorText, fileBase64, saveBlob, toBlob } from '../lib/format'
import { importLocal } from './importLocal'
import { localStore, useLocal } from '../lib/local'
import { HostSocket, type SocketState } from '../lib/socket'
import { toolIndex } from '../lib/tools'
import { compactionState, toTurns } from '../lib/turns'
import type { Attachment, Outgoing, Turn } from '../lib/types'

export const MAX_UPLOAD = 20 * 1024 * 1024

/** Choices that stay in this browser. `model` is `provider:id`; empty follows the server's default. */
export const localPrefs = localStore('gense.prefs', { model: '', effort: 'medium' as Effort, sidebar: true, nav: true })
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

  /** A new conversation with its first message, in `projectId` or temporary when asked; resolves to its id. */
  async start(message: Outgoing, where: { projectId?: string; temporary?: boolean } = {}) {
    const tree = await this.request<{ id: string }>({ t: 'tree.create', ...(where.projectId && { projectId: where.projectId }), ...(where.temporary && { temporary: true }) })
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

  /** A side question about the shown branch (btw), with the chosen model; nothing is written to the chat. */
  btw = (treeId: string, question: string, onText: (text: string) => void) => {
    const branchId = this.socket.state.shown[treeId]
    const model = this.model()
    return this.socket.aside({ treeId, ...(branchId && { branchId }), question, ...(model && { model }) }, onText)
  }

  /** Compacts the shown branch's context now (roadmap-6 C3); progress and the summary arrive in its view. */
  compact = (treeId: string, instructions?: string) => {
    const branchId = this.socket.state.shown[treeId]
    // Failure shows above the composer, from the view; a short chat has nothing to compact, which only this reply says.
    void this.request<{ outcome: CompactionOutcome }>({ t: 'compact', treeId, ...(branchId && { branchId }), ...(instructions && { instructions }), wait: true }).then(({ outcome }) => {
      if (outcome.status === 'nothing') toast('对话还不长，暂时不需要压缩')
    }, report)
  }

  stop = (treeId: string) => {
    const branchId = this.socket.state.shown[treeId]
    void this.request({ t: 'abort', treeId, ...(branchId && { branchId }) }).catch(report)
  }

  setPrefs = (patch: Partial<Omit<Preferences, 'timeZone'>>) => void this.request({ t: 'prefs.set', ...patch }).catch(report)

  // Memory and projects (roadmap-7 A): the server pushes `memories` / `projects` after each change.
  addMemory = (memory: { text: string; source?: MemorySource; treeId?: string; projectId?: string | null; enabled?: boolean }) =>
    this.request<Memory>({ t: 'memory.add', ...memory })
  updateMemory = (memoryId: string, patch: { text?: string; enabled?: boolean; projectId?: string | null }) =>
    void this.request<Memory>({ t: 'memory.update', memoryId, ...patch }).catch(report)
  removeMemory = (memoryId: string) => void this.request({ t: 'memory.remove', memoryId }).catch(report)

  createShare = (treeId: string, snapshot: ShareSnapshot) => this.request<ShareInfo>({ t: 'share.create', treeId, snapshot })
  updateShare = (token: string, snapshot: ShareSnapshot) => this.request<ShareInfo>({ t: 'share.update', token, snapshot })
  deleteShare = (token: string) => this.request({ t: 'share.delete', token })

  // Roadmap-7 D: what used to stay in this browser.
  setFeedback = (treeId: string, turnId: string, value: 'up' | 'down' | null, more: { reasons?: FeedbackReason[]; comment?: string } = {}) =>
    this.request({ t: 'feedback.set', treeId, turnId, value, ...more })
  markRead = (ids: string[]) => {
    const known = new Set(this.socket.state.inboxRead ?? [])
    const fresh = ids.filter((id) => !known.has(id))
    if (fresh.length) void this.request({ t: 'inbox.read', ids: fresh }).catch(report)
  }
  listLibrary = (q: { query?: string; kind?: FileKind; cursor?: string; limit?: number }) => this.request<LibraryPage>({ t: 'library.list', ...q })
  createExport = () => this.request<ExportInfo>({ t: 'export.create' })
  deleteExport = (exportId: string) => void this.request({ t: 'export.delete', exportId }).catch(report)

  createProject = (project: { name: string; instructions?: string; color?: number }) => this.request<Project>({ t: 'project.create', ...project })
  updateProject = (projectId: string, patch: { name?: string; instructions?: string; color?: number }) =>
    void this.request<Project>({ t: 'project.update', projectId, ...patch }).catch(report)
  deleteProject = (projectId: string, deleteChats: boolean) => this.request({ t: 'project.delete', projectId, deleteChats })
  /** Puts a conversation in one project, or none. */
  moveToProject = (treeId: string, projectId: string | null) => void this.request({ t: 'tree.update', treeId, projectId }).catch(report)

  projectFiles = (projectId: string) => this.request<FileEntry[]>({ t: 'project.files.list', projectId })
  addProjectFiles = (projectId: string, uploads: string[]) => this.request<FileEntry[]>({ t: 'project.files.add', projectId, uploads })
  deleteProjectFile = (projectId: string, path: string) => this.request({ t: 'project.files.delete', projectId, path })
  async readProjectFile(projectId: string, path: string) {
    const file = await this.request<{ name: string; mimeType: string; base64: string }>({ t: 'project.files.read', projectId, path })
    saveBlob(file.name, toBlob(file.mimeType, file.base64))
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
    const stop = made.socket.subscribe(() => importLocal(made))
    return () => {
      stop()
      made.socket.close()
    }
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

export const useMemories = () => useHost().memories
export const useProjects = () => useHost().projects
export const useShares = () => useHost().shares

/** A conversation by id, listed or temporary. */
export const findTree = (host: SocketState, treeId: string) => host.trees?.find((t) => t.id === treeId) ?? host.temporary.find((t) => t.id === treeId)

/** The project a conversation is in. */
export const projectOf = (projects: readonly Project[] | null, tree: TreeMeta | undefined) => (tree?.projectId ? projects?.find((p) => p.id === tree.projectId) : undefined)

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
  const branchId = host.shown[treeId]
  const live = host.native[treeId]
  const native = live && live.branchId === branchId ? live.trace : undefined
  const turns = useMemo(() => (view ? withVersions(toTurns(view, native), branches) : []), [view, branches, native])
  const compaction = useMemo(() => compactionState(view), [view])
  return {
    tree: findTree(host, treeId),
    loaded: !!view,
    turns,
    branches,
    branch: branches?.branches.find((b) => b.id === branchId),
    running: turns.some((t) => t.status === 'running' || t.status === 'queued'),
    entryCount: view?.entries.length ?? 0,
    compaction,
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
