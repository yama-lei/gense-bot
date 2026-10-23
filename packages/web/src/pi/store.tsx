// Store backed by the host's WebSocket (roadmap-3 stage 1). Conversations are pi-durable trees; what stage 1 does not
// have yet (projects, Drive, plugins, branches, workspaces) keeps its browser-only state or rejects with a notice.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { pluginCatalog } from '@gense/core/catalog'
import { useRoute } from '../router'
import type { Store } from '../store'
import type { UploadedFile } from '@gense/core/protocol'
import type { AppState, Conversation, DriveFile, Effort, ModelOption, Outgoing, PluginInfo, Preferences, ToolResult, Turn, WorkspaceFile } from '../types'
import { HostSocket } from './socket'
import { toTurns } from './turns'

const LATER = '这项功能在迁移到新内核后的阶段 3 恢复'
const later = () => Promise.reject(new Error(LATER))
const PREFS_KEY = 'gense.prefs'

const fileBase64 = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })

const toDriveFile = (u: UploadedFile): DriveFile => ({ ...u, kind: 'source' })

const toBlob = (mimeType: string, base64: string) => new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: mimeType })

function saveBase64(name: string, mimeType: string, base64: string) {
  const url = URL.createObjectURL(toBlob(mimeType, base64))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

const VIEW_STATES_KEY = 'gense.viewStates'

/** View state (an edited email, a saved artifact) is kept per browser for now, keyed by `treeId:callId`. */
const loadViewStates = (): Record<string, unknown> => {
  try {
    return JSON.parse(localStorage.getItem(VIEW_STATES_KEY) ?? '{}')
  } catch {
    return {}
  }
}
const saveViewStates = (v: Record<string, unknown>) => {
  try {
    localStorage.setItem(VIEW_STATES_KEY, JSON.stringify(v))
  } catch {
    // Then it lasts only for this tab.
  }
}
const withViewStates = (treeId: string, turns: Turn[], states: Record<string, unknown>) =>
  turns.map((t) => (t.toolCalls.some((c) => `${treeId}:${c.id}` in states) ? { ...t, toolCalls: t.toolCalls.map((c) => ({ ...c, viewState: states[`${treeId}:${c.id}`] ?? c.viewState })) } : t))

const loadPrefs = (): Partial<Preferences> => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
  } catch {
    return {}
  }
}
const savePrefs = (prefs: Preferences) => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Preferences then last only for this tab.
  }
}

/** Fields the host does not keep in stage 1; views can still edit them in this tab. */
type LocalState = Pick<AppState, 'projects' | 'memories' | 'prefs'>

export function usePiStore(onUnauthorized: () => void): Store {
  const route = useRoute()
  const socketRef = useRef<HostSocket | null>(null)
  if (!socketRef.current) socketRef.current = new HostSocket(onUnauthorized)
  const socket = socketRef.current
  useEffect(() => () => socket.close(), [socket])
  const host = useSyncExternalStore(
    (l) => socket.subscribe(l),
    () => socket.state,
  )
  const [attached, attach] = useState<string | null>(null)
  // Workspace listings of the chats whose file panel was opened; kept fresh while their conversation changes.
  const [workspaces, setWorkspaces] = useState<Record<string, WorkspaceFile[]>>({})
  const [uploads, setUploads] = useState<DriveFile[]>([])
  const [viewStates, setViewStates] = useState<Record<string, unknown>>(loadViewStates)
  const [local, setLocal] = useState<LocalState>(() => ({
    projects: [],
    memories: [],
    prefs: { language: 'zh-CN', defaultEffort: 'medium', model: '', ...loadPrefs() },
  }))

  const chatId = route.name === 'chat' ? route.id : null
  const watched = [...new Set([chatId, attached])].filter((id): id is string => !!id && !!host.trees?.some((t) => t.id === id))
  const watchKey = watched.join(',')
  useEffect(() => socket.watch(watchKey ? watchKey.split(',') : []), [socket, watchKey])

  const models = useMemo<ModelOption[]>(
    () => host.models.map((m) => ({ ...m, capabilities: { toolCall: true, efforts: ['low', 'medium', 'high'], context: 200_000, image: false } })),
    [host.models],
  )
  const defaultKey = host.defaultModel ? `${host.defaultModel.provider}:${host.defaultModel.id}` : ''
  const prefs = { ...local.prefs, model: local.prefs.model && models.some((m) => `${m.provider}:${m.id}` === local.prefs.model) ? local.prefs.model : defaultKey }

  const plugins = useMemo<PluginInfo[]>(
    () =>
      pluginCatalog.map((p) => {
        const s = host.plugins?.find((x) => x.id === p.id)
        return { ...p, enabled: false, available: false, config: { values: {}, secretsSet: [], serverKeys: [] }, issue: null, ...s }
      }),
    [host.plugins],
  )

  const state = useMemo<AppState>(
    () => ({
      ...local,
      plugins,
      skills: host.skills,
      providers: host.providers,
      prefs,
      conversations: (host.trees ?? []).map(
        (t): Conversation => ({
          id: t.id,
          title: t.title,
          projectId: null,
          pinned: t.pinned,
          updatedAt: t.updatedAt,
          turns: host.views[t.id] ? withViewStates(t.id, toTurns(host.views[t.id], { model: prefs.model, effort: prefs.defaultEffort }), viewStates) : [],
          ...(workspaces[t.id] && { files: workspaces[t.id] }),
        }),
      ),
      files: uploads,
      schedules: [],
      account: { name: '', email: host.email, driveConnected: false, driveError: null },
      models,
      modelsError: host.connected || !host.trees ? null : '与服务器的连接已断开，正在重连…',
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [local, host, models, plugins, prefs.model, workspaces, uploads, viewStates],
  )
  const stateRef = useRef(state)
  stateRef.current = state

  const report = (e: unknown) => console.error(e)
  const refreshWorkspace = (treeId: string) =>
    void socket
      .request<WorkspaceFile[]>({ t: 'files.list', treeId })
      .then((files) => setWorkspaces((w) => ({ ...w, [treeId]: files })))
      .catch(report)
  const refreshUploads = () =>
    void socket
      .request<UploadedFile[]>({ t: 'uploads' })
      .then((list) => setUploads(list.map(toDriveFile)))
      .catch(report)

  // A tool may have changed the files: reload an open panel's listing whenever its conversation grows.
  const growth = Object.keys(workspaces)
    .map((id) => `${id}:${host.views[id]?.entries.length ?? 0}`)
    .join(',')
  useEffect(() => {
    for (const id of Object.keys(workspaces)) if (host.views[id]) refreshWorkspace(id)
  }, [growth]) // eslint-disable-line react-hooks/exhaustive-deps
  const toModel = (key: string) => host.models.find((m) => `${m.provider}:${m.id}` === key)
  const send = (treeId: string, message: Outgoing, model: string, effort: Effort) => {
    const picked = toModel(model)
    const attachments = message.attachments?.map((a) => a.id)
    return socket.request({
      t: 'send',
      treeId,
      text: message.text,
      requestId: crypto.randomUUID(),
      ...(picked && { model: picked }),
      effort,
      ...(attachments?.length && { attachments }),
      ...(message.command && { command: message.command }),
      ...(message.mentions?.length && { mentions: message.mentions }),
    })
  }

  const setState = (fn: (s: AppState) => AppState) => {
    const cur = stateRef.current
    const next = fn(cur)
    if (next.conversations !== cur.conversations) {
      const byId = new Map(next.conversations.map((c) => [c.id, c]))
      for (const c of cur.conversations) {
        const n = byId.get(c.id)
        if (!n) void socket.request({ t: 'tree.delete', treeId: c.id }).catch(report)
        else if (n.title !== c.title || n.pinned !== c.pinned) void socket.request({ t: 'tree.update', treeId: c.id, title: n.title, pinned: n.pinned }).catch(report)
      }
    }
    if (next.prefs !== cur.prefs) savePrefs(next.prefs)
    const { projects, memories, prefs } = next
    setLocal({ projects, memories, prefs })
  }

  return {
    state,
    ready: host.trees !== null,
    turnsLoaded: (convId) => convId in host.views,
    setState,
    patchConv: (convId, fn) => setState((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === convId ? fn(c) : c)) })),
    startConversation: async (message, _projectId, model, effort) => {
      const tree = await socket.request<{ id: string }>({ t: 'tree.create' })
      await send(tree.id, message, model, effort)
      return tree.id
    },
    reply: (convId, message, model, effort) => void send(convId, message, model, effort).catch(report),
    regenerate: () => report(LATER),
    editMessage: () => report(LATER),
    showVersion: () => {},
    branch: later,
    summarizeSide: later,
    attach,
    stop: (convId) => void socket.request({ t: 'abort', treeId: convId }).catch(report),
    reset: () => {},
    callToolFromView: (convId, _turnId, _callId, name, args) =>
      socket.request<ToolResult>({ t: 'tool.call', treeId: convId, name, args }).catch((e: unknown) => ({ content: e instanceof Error ? e.message : String(e), isError: true })),
    setViewState: (convId, _turnId, callId, viewState) =>
      setViewStates((v) => {
        const next = { ...v, [`${convId}:${callId}`]: viewState }
        saveViewStates(next)
        return next
      }),
    upload: async (file) => {
      if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MB`)
      const uploaded = toDriveFile(await socket.request<UploadedFile>({ t: 'upload', name: file.name, base64: await fileBase64(file) }))
      setUploads((list) => [uploaded, ...list])
      return uploaded
    },
    setDrive: () => report(LATER),
    setPluginConfig: (pluginId, values, secrets) => socket.request({ t: 'plugin.set', pluginId, values, secrets }).then(() => {}),
    setPluginEnabled: (pluginId, enabled) => socket.request({ t: 'plugin.set', pluginId, enabled }).then(() => {}),
    refreshFiles: refreshUploads,
    setSkillEnabled: (name, enabled) => socket.request({ t: 'skill.set', name, enabled }),
    loginModel: (provider, type, handlers) => socket.login(provider, type, handlers),
    answerLogin: (promptId, value) => socket.request({ t: 'auth.answer', promptId, ...(value !== undefined && { value }) }),
    logoutModel: (provider) => socket.request({ t: 'auth.logout', provider }),
    readFile: later,
    searchDrive: async () => [],
    refreshWorkspace,
    workspacePreview: (treeId, path) => socket.request({ t: 'files.preview', treeId, path }),
    deleteWorkspaceFile: async (treeId, path) => {
      await socket.request({ t: 'files.delete', treeId, path })
      refreshWorkspace(treeId)
    },
    downloadWorkspaceFile: async (treeId, path) => {
      const file = await socket.request<{ name: string; mimeType: string; base64: string }>({ t: 'files.read', treeId, path })
      saveBase64(file.name, file.mimeType, file.base64)
    },
    readWorkspaceFile: async (treeId, path) => {
      const file = await socket.request<{ mimeType: string; base64: string }>({ t: 'files.read', treeId, path })
      return toBlob(file.mimeType, file.base64)
    },
    logout: async () => {
      await fetch('/api/logout', { method: 'POST' })
      socket.close()
      onUnauthorized()
    },
    bridge: null,
  }
}
