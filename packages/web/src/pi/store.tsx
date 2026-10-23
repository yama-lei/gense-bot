// Store backed by the host's WebSocket (roadmap-3 stage 1). Conversations are pi-durable trees; what stage 1 does not
// have yet (projects, Drive, plugins, branches, workspaces) keeps its browser-only state or rejects with a notice.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { pluginCatalog } from '../plugins/catalog'
import { useRoute } from '../router'
import type { Store } from '../store'
import type { AppState, Conversation, Effort, ModelOption, Outgoing, Preferences } from '../types'
import { HostSocket } from './socket'
import { toTurns } from './turns'

const LATER = '这项功能在迁移到新内核后的阶段 3 恢复'
const later = () => Promise.reject(new Error(LATER))
const PREFS_KEY = 'gense.prefs'

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
type LocalState = Pick<AppState, 'projects' | 'memories' | 'plugins' | 'skills' | 'prefs'>

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
  const [local, setLocal] = useState<LocalState>(() => ({
    projects: [],
    memories: [],
    plugins: pluginCatalog.map((p) => ({ ...p, enabled: false, available: false, config: { values: {}, secretsSet: [], serverKeys: [] }, issue: null })),
    skills: [],
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

  const state = useMemo<AppState>(
    () => ({
      ...local,
      prefs,
      conversations: (host.trees ?? []).map(
        (t): Conversation => ({
          id: t.id,
          title: t.title,
          projectId: null,
          pinned: t.pinned,
          updatedAt: t.updatedAt,
          turns: host.views[t.id] ? toTurns(host.views[t.id], { model: prefs.model, effort: prefs.defaultEffort }) : [],
        }),
      ),
      files: [],
      schedules: [],
      skillsError: null,
      account: { name: '', email: host.email, driveConnected: false, driveError: null },
      models,
      modelsError: host.connected || !host.trees ? null : '与服务器的连接已断开，正在重连…',
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [local, host, models, prefs.model],
  )
  const stateRef = useRef(state)
  stateRef.current = state

  const report = (e: unknown) => console.error(e)
  const toModel = (key: string) => host.models.find((m) => `${m.provider}:${m.id}` === key)
  const send = (treeId: string, message: Outgoing, model: string, effort: Effort) => {
    const text = message.command ? `${message.command.prompt}\n\n${message.text}` : message.text
    const picked = toModel(model)
    return socket.request({ t: 'send', treeId, text, requestId: crypto.randomUUID(), ...(picked && { model: picked }), effort })
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
    const { projects, memories, plugins, skills, prefs } = next
    setLocal({ projects, memories, plugins, skills, prefs })
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
    callToolFromView: async () => ({ content: LATER, isError: true }),
    setViewState: () => {},
    upload: later,
    setDrive: () => report(LATER),
    setPluginConfig: later,
    refreshFiles: () => {},
    refreshSkills: () => {},
    readFile: later,
    searchDrive: async () => [],
    refreshWorkspace: () => {},
    workspacePreview: later,
    deleteWorkspaceFile: later,
    workspaceFileUrl: () => '',
    logout: async () => {
      await fetch('/api/logout', { method: 'POST' })
      socket.close()
      onUnauthorized()
    },
    bridge: null,
  }
}
