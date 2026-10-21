import { useAgent } from 'agents/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pluginCatalog } from '../plugins/catalog'
import { useRoute } from '../router'
import type { Store } from '../store'
import type { AppState, Conversation, DriveFile, Effort, HubState, Turn } from '../types'
import { ChatBridge, type ChatControls } from './ChatBridge'
import { pending } from './pending'

const emptyHub: HubState = {
  chats: [],
  projects: [],
  memories: [],
  prefs: { language: 'zh-CN', defaultEffort: 'medium', model: '' },
  enabledPlugins: [],
  availablePlugins: [],
  account: { name: '', email: '', driveConnected: false, driveError: null },
  models: [],
  modelsError: null,
  files: [],
}

/** Spec "兜底限制": text files up to 2 MB; the hub checks again. */
const MAX_UPLOAD = 2 * 1024 * 1024
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Store backed by the user's UserHub (state) and the open chat's Think agent (turns). */
export function useRealStore(): Store {
  const route = useRoute()
  const hubAgent = useAgent<HubState>({ agent: 'UserHub', basePath: 'agents/hub' })
  const hub = hubAgent.state ?? emptyHub
  const [turns, setTurns] = useState<Record<string, Turn[]>>({})
  // A local edit shows at once and is dropped when the hub broadcasts its own state.
  const [local, setLocal] = useState<{ base: HubState | undefined; state: AppState } | null>(null)
  const controls = useRef(new Map<string, ChatControls>())

  const derived = useMemo<AppState>(
    () => ({
      projects: hub.projects,
      conversations: hub.chats.map((c): Conversation => ({ ...c, turns: turns[c.id] ?? [] })),
      files: hub.files,
      schedules: [],
      plugins: pluginCatalog.map((p) => ({ ...p, enabled: hub.enabledPlugins.includes(p.id), available: hub.availablePlugins.includes(p.id) })),
      memories: hub.memories,
      prefs: hub.prefs,
      account: hub.account,
      models: hub.models,
      modelsError: hub.modelsError,
    }),
    [hub, turns],
  )
  const hubState = hubAgent.state
  const state = useMemo(() => (local && local.base === hubState ? { ...local.state, conversations: derived.conversations } : derived), [local, hubState, derived])
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const call = useCallback(
    (method: string, args: unknown[]) =>
      hubAgent.call(method, args).catch((e: unknown) => {
        console.error(`hub.${method} failed`, e)
        setLocal(null)
      }),
    [hubAgent],
  )

  // Views edit AppState as a whole; send the hub only what changed.
  const setState = (fn: (s: AppState) => AppState) => {
    const cur = stateRef.current
    const next = fn(cur)
    const patch: Record<string, unknown> = {}
    if (next.projects !== cur.projects) patch.projects = next.projects
    if (next.memories !== cur.memories) patch.memories = next.memories
    if (next.prefs !== cur.prefs) patch.prefs = next.prefs
    if (next.plugins !== cur.plugins) patch.enabledPlugins = next.plugins.filter((p) => p.enabled).map((p) => p.id)
    if (Object.keys(patch).length) void call('update', [patch])
    if (next.conversations !== cur.conversations) {
      const byId = new Map(next.conversations.map((c) => [c.id, c]))
      for (const c of cur.conversations) {
        const n = byId.get(c.id)
        if (!n) void call('deleteChat', [c.id])
        else if (n.title !== c.title || n.pinned !== c.pinned || n.projectId !== c.projectId)
          void call('updateChat', [c.id, { title: n.title, pinned: n.pinned, projectId: n.projectId }])
      }
    }
    stateRef.current = next
    setLocal({ base: hubAgent.state, state: next })
  }

  const patchConv = (convId: string, fn: (c: Conversation) => Conversation) => setState((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === convId ? fn(c) : c)) }))

  const startConversation = async (message: string, projectId: string | null, model: string, effort: Effort) => {
    const id = await hubAgent.call<string>('createChat', [message, projectId])
    pending.set(id, { text: message, model, effort })
    return id
  }

  const reply = (convId: string, message: string, model: string, effort: Effort) => {
    const c = controls.current.get(convId)
    if (c) c.send(message, model, effort)
    else pending.set(convId, { text: message, model, effort })
  }

  const chatId = route.name === 'chat' ? route.id : null
  const onTurns = useCallback((id: string, t: Turn[]) => setTurns((s) => ({ ...s, [id]: t })), [])
  const register = useCallback((id: string, c: ChatControls | null) => {
    if (c) controls.current.set(id, c)
    else controls.current.delete(id)
  }, [])

  return {
    state,
    ready: hubAgent.state != null,
    turnsLoaded: (convId) => convId in turns,
    setState,
    patchConv,
    startConversation,
    reply,
    retry: (convId, turn) => reply(convId, turn.userMessage, turn.model, turn.effort),
    stop: (convId) => controls.current.get(convId)?.stop(),
    reset: () => {},
    callToolFromView: async (convId, _turnId, callId, name, input) => {
      const c = controls.current.get(convId)
      if (!c) return { content: '会话未连接，请稍后重试', isError: true }
      return c.callTool(name, input, callId).catch((e: unknown) => ({ content: errorText(e), isError: true }))
    },
    setViewState: (convId, _turnId, callId, viewState) => controls.current.get(convId)?.setViewState(callId, viewState),
    upload: async (file) => {
      if (file.size > MAX_UPLOAD) return `「${file.name}」超过 2 MB 上限，未上传。`
      try {
        await hubAgent.call<DriveFile>('uploadFile', [file.name, await file.text()])
        return null
      } catch (e) {
        return errorText(e)
      }
    },
    setDrive: (connected) => {
      // OAuth needs a top-level navigation; the callback returns to the customize page.
      if (connected) location.href = '/oauth/google/start'
      else void call('disconnectDrive', [])
    },
    refreshFiles: () => void call('refreshFiles', []),
    readFile: (id) => hubAgent.call<{ file: DriveFile; text: string }>('readFile', [id]),
    searchDrive: (query) => hubAgent.call<DriveFile[]>('searchDrive', [query]),
    bridge: chatId && hub.chats.some((c) => c.id === chatId) ? <ChatBridge key={chatId} id={chatId} defaults={hub.prefs} onTurns={onTurns} register={register} /> : null,
  }
}
