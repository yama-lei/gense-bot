import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { planReply } from './engine'
import { seed } from './seed'
import { tools } from '../plugins'
import type { ToolContext } from '../plugins/types'
import type { Store } from '../store'
import type { AppState, BranchNote, Conversation, DriveFile, Effort, Outgoing, ToolCall, ToolResult, Turn, Versions, WebSource } from '../types'
import { MAX_UPLOAD_BYTES, uid } from '../util'

// v6: skills.
const KEY = 'gensebot-mock-v6'
/** Older versions by the id of the message they replaced: the turns from there on, per chat. */
const BRANCHES_KEY = 'gensebot-mock-branches-v1'
type Branches = Record<string, Record<string, Turn[]>>

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as AppState
  } catch {
    // Storage unavailable or corrupt: fall back to seed data.
  }
  return structuredClone(seed)
}

/** A turn's message sent again (regenerate, edit) keeps its attachments, command and mentions. */
const resend = (t: Turn, text: string): Outgoing => ({ text, attachments: t.attachments, command: t.command && { ...t.command, prompt: '' }, mentions: t.mentions })

function loadBranches(): Branches {
  try {
    return JSON.parse(localStorage.getItem(BRANCHES_KEY) ?? '{}') as Branches
  } catch {
    return {}
  }
}

const addVersion = (v: Versions | undefined, first: string, id: string): Versions => {
  const ids = [...(v?.ids ?? [first]), id]
  return { ids, index: ids.length - 1 }
}

export function useMockStore(): Store {
  const [raw, setState] = useState<AppState>(load)
  const [branches, setBranches] = useState<Branches>(loadBranches)
  // Chats showing an older version: the turns shown instead of the live ones (not persisted).
  const [views, setViews] = useState<Record<string, Turn[]>>({})
  const state = useMemo(
    () => (Object.keys(views).length ? { ...raw, conversations: raw.conversations.map((c) => (views[c.id] ? { ...c, turns: views[c.id], viewingOld: true } : c)) } : raw),
    [raw, views],
  )
  const timers = useRef(new Map<string, number[]>())
  const stateRef = useRef(raw)
  useEffect(() => {
    stateRef.current = raw
  }, [raw])

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(raw))
      localStorage.setItem(BRANCHES_KEY, JSON.stringify(branches))
    } catch {
      // Ignore quota or privacy-mode errors; the mock still works in memory.
    }
  }, [raw, branches])

  const patchConv = useCallback((convId: string, fn: (c: Conversation) => Conversation) => {
    setState((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === convId ? fn(c) : c)) }))
  }, [])

  const patchTurn = useCallback(
    (convId: string, turnId: string, fn: (t: Turn) => Turn) => {
      patchConv(convId, (c) => ({ ...c, updatedAt: Date.now(), turns: c.turns.map((t) => (t.id === turnId ? fn(t) : t)) }))
    },
    [patchConv],
  )

  const addFile = useCallback((file: DriveFile) => setState((s) => ({ ...s, files: [file, ...s.files] })), [])

  const exec = useCallback(
    (name: string, input: unknown): ToolResult => {
      const tool = tools[name]
      if (!tool) return { content: `工具 ${name} 未注册`, isError: true }
      const ctx: ToolContext = { files: stateRef.current.files, addFile, conversations: stateRef.current.conversations }
      return tool.execute(input as never, ctx)
    },
    [addFile],
  )

  const run = useCallback(
    (convId: string, turn: Turn) => {
      const script = planReply(turn, stateRef.current)
      const ids: number[] = []
      timers.current.set(turn.id, ids)
      let t = 0
      const at = (delay: number, fn: () => void) => {
        t += delay
        ids.push(window.setTimeout(fn, t))
      }
      const patch = (fn: (t: Turn) => Turn) => patchTurn(convId, turn.id, fn)
      const [gap, tail] = script.fast ? [40, 60] : [300, 500]

      at(700, () => patch((x) => ({ ...x, status: 'running', summary: script.summary })))
      for (const step of script.steps) {
        const call: ToolCall = { id: uid(), name: step.name, status: 'running', input: step.input, resourceUri: tools[step.name]?.resourceUri, origin: 'model' }
        at(gap, () => patch((x) => ({ ...x, toolCalls: [...x.toolCalls, call] })))
        at(step.durationMs + tail, () => {
          const result = exec(step.name, step.input)
          const done: ToolCall = { ...call, status: result.isError ? 'failed' : 'succeeded', result, durationMs: step.durationMs }
          const found = (result.structuredContent as { sources?: WebSource[] } | undefined)?.sources ?? []
          patch((x) => ({
            ...x,
            toolCalls: x.toolCalls.map((c) => (c.id === call.id ? done : c)),
            sources: found.length ? [...new Map([...(x.sources ?? []), ...found].map((s) => [s.url, s])).values()] : x.sources,
          }))
        })
      }
      if (script.error) {
        at(900, () => patch((x) => ({ ...x, status: 'failed', error: script.error })))
      } else {
        const chunks = script.text.match(/[\s\S]{1,4}/g) ?? []
        at(300, () => {})
        chunks.forEach((chunk) => at(18, () => patch((x) => ({ ...x, assistantMessage: x.assistantMessage + chunk }))))
        at(200, () => patch((x) => ({ ...x, status: 'succeeded', citations: script.citations })))
      }
      at(0, () => timers.current.delete(turn.id))
    },
    [patchTurn, exec],
  )

  // Accepted work survives a page reload (spec S4): restart scripted turns that were in flight.
  useEffect(() => {
    for (const c of stateRef.current.conversations) {
      for (const t of c.turns) {
        if (t.status === 'queued' || t.status === 'running') {
          const reset: Turn = { ...t, status: 'queued', assistantMessage: '', toolCalls: [], citations: [], sources: [] }
          patchTurn(c.id, t.id, () => reset)
          run(c.id, reset)
        }
      }
    }
    const all = timers.current
    return () => all.forEach((ids) => ids.forEach(clearTimeout))
  }, [patchTurn, run])

  const newTurn = ({ text, attachments, command, mentions }: Outgoing, model: string, effort: Effort): Turn => {
    // The last model chosen becomes the default for new conversations.
    setState((s) => (s.prefs.model === model ? s : { ...s, prefs: { ...s.prefs, model } }))
    return {
      id: uid(),
      requestId: uid(),
      status: 'queued',
      userMessage: text,
      assistantMessage: '',
      toolCalls: [],
      citations: [],
      model,
      effort,
      createdAt: Date.now(),
      attachments: attachments?.length ? attachments : undefined,
      command: command && { id: command.id, label: command.label },
      mentions: mentions?.length ? mentions : undefined,
    }
  }

  const startConversation = (message: Outgoing, projectId: string | null, model: string, effort: Effort) => {
    const turn = newTurn(message, model, effort)
    const conv: Conversation = {
      id: uid(),
      title: message.text.replace(/\s+/g, ' ').slice(0, 24),
      projectId,
      pinned: false,
      updatedAt: Date.now(),
      turns: [turn],
    }
    setState((s) => ({ ...s, conversations: [conv, ...s.conversations] }))
    run(conv.id, turn)
    return Promise.resolve(conv.id)
  }

  const reply = (convId: string, message: Outgoing, model: string, effort: Effort) => {
    const turn = newTurn(message, model, effort)
    patchConv(convId, (c) => ({ ...c, updatedAt: Date.now(), turns: [...c.turns, turn] }))
    run(convId, turn)
  }

  const live = (convId: string) => stateRef.current.conversations.find((c) => c.id === convId)
  const showLive = (convId: string) =>
    setViews((v) => {
      const { [convId]: _, ...rest } = v
      return rest
    })

  /** Replaces the turn and everything after it with `next`, keeping the old ones under `oldId`. */
  const replaceFrom = (convId: string, turn: Turn, oldId: string, next: Turn) => {
    const c = live(convId)
    const i = c?.turns.findIndex((t) => t.id === turn.id) ?? -1
    if (!c || i < 0) return
    setBranches((b) => ({ ...b, [convId]: { ...b[convId], [oldId]: c.turns.slice(i) } }))
    showLive(convId)
    patchConv(convId, (x) => ({ ...x, updatedAt: Date.now(), turns: [...x.turns.slice(0, i), next] }))
    run(convId, next)
  }

  const regenerate = (convId: string, turn: Turn, model: string, effort: Effort) => {
    const requestId = uid()
    const next: Turn = { ...newTurn(resend(turn, turn.userMessage), model, effort), id: turn.id, requestId, userVersions: turn.userVersions, answerVersions: addVersion(turn.answerVersions, turn.requestId, requestId) }
    replaceFrom(convId, turn, turn.requestId, next)
  }

  const editMessage = (convId: string, turn: Turn, text: string, model: string, effort: Effort) => {
    const next = newTurn(resend(turn, text), model, effort)
    replaceFrom(convId, turn, turn.id, { ...next, userVersions: addVersion(turn.userVersions, turn.id, next.id) })
  }

  const showVersion = (convId: string, messageId: string) => {
    if (!messageId) return showLive(convId)
    const c = state.conversations.find((x) => x.id === convId)
    const i = c?.turns.findIndex((t) => t.userVersions?.ids.includes(messageId) || t.answerVersions?.ids.includes(messageId)) ?? -1
    if (!c || i < 0) return
    const liveTurns = live(convId)?.turns ?? []
    if (liveTurns.some((t) => t.id === messageId || t.requestId === messageId)) return showLive(convId)
    const old = branches[convId]?.[messageId]
    if (!old) return
    const at = c.turns[i]
    const pick = (v: Versions | undefined) => v && { ...v, index: v.ids.indexOf(messageId) }
    const first = at.userVersions?.ids.includes(messageId) ? { ...old[0], userVersions: pick(at.userVersions) } : { ...old[0], answerVersions: pick(at.answerVersions) }
    setViews((v) => ({ ...v, [convId]: [...c.turns.slice(0, i), first, ...old.slice(1)] }))
  }

  const branch = async (convId: string, turn: Turn, kind: 'fork' | 'side') => {
    const c = state.conversations.find((x) => x.id === convId)
    const i = c?.turns.findIndex((t) => t.id === turn.id) ?? -1
    if (!c || i < 0) throw new Error('会话不存在')
    const conv: Conversation = {
      id: uid(),
      title: kind === 'fork' ? `分支：${c.title.replace(/^分支：/, '')}`.slice(0, 40) : '支线',
      projectId: c.projectId,
      pinned: false,
      updatedAt: Date.now(),
      turns: c.turns.slice(0, i + 1).map((t) => ({ ...t, userVersions: undefined, answerVersions: undefined })),
      parent: { chatId: convId, messageId: turn.id, kind },
    }
    setState((s) => ({ ...s, conversations: [conv, ...s.conversations] }))
    return conv.id
  }

  const summarizeSide = async (sideId: string) => {
    const side = live(sideId)
    if (!side?.parent) throw new Error('这不是一条支线')
    const at = side.turns.findIndex((t) => t.id === side.parent!.messageId)
    const asked = side.turns.slice(at + 1).filter((t) => t.status === 'succeeded')
    if (!asked.length) throw new Error('支线里还没有对话，无需总结')
    await new Promise((r) => setTimeout(r, 900))
    const summary = `支线讨论了 ${asked.length} 个问题。（Mock 总结）\n\n${asked.map((t) => `- **${t.userMessage.slice(0, 40)}**：${t.assistantMessage.replace(/\s+/g, ' ').slice(0, 60)}…`).join('\n')}`
    const note: BranchNote = { sideChatId: sideId, title: side.title, summary }
    if (stateRef.current.account.driveConnected) {
      const file: DriveFile = { id: 'f-' + uid(), name: `支线总结 - ${side.title}.md`, kind: 'artifact', mimeType: 'text/markdown', size: summary.length, modifiedTime: Date.now(), content: `# ${side.title}\n\n${summary}\n` }
      addFile(file)
      Object.assign(note, { fileId: file.id, fileName: file.name })
    }
    const noteTurn: Turn = { id: uid(), requestId: uid(), status: 'succeeded', userMessage: '', assistantMessage: '', toolCalls: [], citations: [], model: side.turns[0]?.model ?? '', effort: 'medium', createdAt: Date.now(), note }
    patchConv(side.parent.chatId, (c) => ({ ...c, updatedAt: Date.now(), turns: [...c.turns, noteTurn] }))
  }

  /** `tools/call` from a view: recorded on the turn so the process list shows it. */
  const callToolFromView = async (convId: string, turnId: string, _callId: string, name: string, input: unknown): Promise<ToolResult> => {
    const start = Date.now()
    await new Promise((r) => setTimeout(r, 500))
    const result = exec(name, input)
    const call: ToolCall = {
      id: uid(),
      name,
      status: result.isError ? 'failed' : 'succeeded',
      input,
      result,
      origin: 'view',
      durationMs: Date.now() - start,
    }
    patchTurn(convId, turnId, (t) => ({ ...t, toolCalls: [...t.toolCalls, call] }))
    return result
  }

  const setViewState = (convId: string, turnId: string, callId: string, viewState: unknown) =>
    patchTurn(convId, turnId, (t) => ({ ...t, toolCalls: t.toolCalls.map((c) => (c.id === callId ? { ...c, viewState } : c)) }))

  /** Returns an error message, or null when the file was added. */
  const upload = async (file: File): Promise<DriveFile> => {
    if (!stateRef.current.account.driveConnected) throw new Error('还没有连接 Google Drive。请先在“定制”页连接。')
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`「${file.name}」超过 20 MB 上限，未上传。`)
    const text = /^text\/|json|xml/.test(file.type) || /\.(md|txt|csv|json)$/i.test(file.name)
    // Only text is kept in the browser; other files get a stand-in for what conversion would read.
    const content = text ? await file.text() : `（Mock 演示：这里是「${file.name}」转换后的文字。真实版本会把 PDF、Word、Excel、PPT 转成文字，图片直接给模型看。）`
    const added: DriveFile = { id: 'f-' + uid(), name: file.name, kind: 'source', mimeType: file.type || 'application/octet-stream', size: file.size, content, modifiedTime: Date.now() }
    addFile(added)
    return added
  }

  const setDrive = (driveConnected: boolean) => setState((s) => ({ ...s, account: { ...s.account, driveConnected, driveError: null } }))

  const readFile = async (id: string) => {
    const file = stateRef.current.files.find((f) => f.id === id)
    if (!file) throw new Error('文件不存在，或你的 Google 账号无权访问')
    return { file, text: file.content ?? '' }
  }

  const searchDrive = async (query: string) => {
    await new Promise((r) => setTimeout(r, 300))
    return stateRef.current.files.filter((f) => f.name.includes(query) || f.content?.includes(query))
  }

  const stop = (convId: string, turnId: string) => {
    timers.current.get(turnId)?.forEach(clearTimeout)
    timers.current.delete(turnId)
    patchTurn(convId, turnId, (t) => ({
      ...t,
      status: 'interrupted',
      toolCalls: t.toolCalls.map((c) => (c.status === 'running' ? { ...c, status: 'failed', result: { content: '已被你停止', isError: true } } : c)),
    }))
  }

  const reset = () => {
    timers.current.forEach((ids) => ids.forEach(clearTimeout))
    timers.current.clear()
    setState(structuredClone(seed))
    setBranches({})
    setViews({})
  }

  return { state, ready: true, turnsLoaded: () => true, setState, patchConv, startConversation, reply, regenerate, editMessage, showVersion, branch, summarizeSide, attach: () => {}, stop, reset, callToolFromView, setViewState, upload, setDrive, refreshFiles: () => {}, refreshSkills: () => {}, readFile, searchDrive, bridge: null }
}
