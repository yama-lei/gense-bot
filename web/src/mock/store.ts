import { useCallback, useEffect, useRef, useState } from 'react'
import { planReply } from './engine'
import { seed } from './seed'
import { tools } from '../plugins'
import type { ToolContext } from '../plugins/types'
import type { Store } from '../store'
import type { AppState, Conversation, DriveFile, Effort, ToolCall, ToolResult, Turn } from '../types'
import { uid } from '../util'

// v4: files carry `size`, the account carries `driveError`.
const KEY = 'gensebot-mock-v4'
/** Upload limit from the spec's circuit-breaker table. */
export const MAX_UPLOAD = 2 * 1024 * 1024

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as AppState
  } catch {
    // Storage unavailable or corrupt: fall back to seed data.
  }
  return structuredClone(seed)
}

export function useMockStore(): Store {
  const [state, setState] = useState<AppState>(load)
  const timers = useRef(new Map<string, number[]>())
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      // Ignore quota or privacy-mode errors; the mock still works in memory.
    }
  }, [state])

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
      const ctx: ToolContext = { files: stateRef.current.files, addFile }
      return tool.execute(input as never, ctx)
    },
    [addFile],
  )

  const run = useCallback(
    (convId: string, turn: Turn) => {
      const script = planReply(turn.userMessage, stateRef.current)
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
          patch((x) => ({ ...x, toolCalls: x.toolCalls.map((c) => (c.id === call.id ? done : c)) }))
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
          const reset: Turn = { ...t, status: 'queued', assistantMessage: '', toolCalls: [], citations: [] }
          patchTurn(c.id, t.id, () => reset)
          run(c.id, reset)
        }
      }
    }
    const all = timers.current
    return () => all.forEach((ids) => ids.forEach(clearTimeout))
  }, [patchTurn, run])

  const newTurn = (message: string, model: string, effort: Effort): Turn => {
    // The last model chosen becomes the default for new conversations.
    setState((s) => (s.prefs.model === model ? s : { ...s, prefs: { ...s.prefs, model } }))
    return {
      id: uid(),
      requestId: uid(),
      status: 'queued',
      userMessage: message,
      assistantMessage: '',
      toolCalls: [],
      citations: [],
      model,
      effort,
      createdAt: Date.now(),
    }
  }

  const startConversation = (message: string, projectId: string | null, model: string, effort: Effort) => {
    const turn = newTurn(message, model, effort)
    const conv: Conversation = {
      id: uid(),
      title: message.replace(/\s+/g, ' ').slice(0, 24),
      projectId,
      pinned: false,
      updatedAt: Date.now(),
      turns: [turn],
    }
    setState((s) => ({ ...s, conversations: [conv, ...s.conversations] }))
    run(conv.id, turn)
    return Promise.resolve(conv.id)
  }

  const reply = (convId: string, message: string, model: string, effort: Effort) => {
    const turn = newTurn(message, model, effort)
    patchConv(convId, (c) => ({ ...c, updatedAt: Date.now(), turns: [...c.turns, turn] }))
    run(convId, turn)
  }

  const retry = (convId: string, turn: Turn) => reply(convId, turn.userMessage, turn.model, turn.effort)

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
  const upload = async (file: File): Promise<string | null> => {
    if (file.size > MAX_UPLOAD) return `「${file.name}」超过 2 MB 上限，未上传。`
    if (!/^text\/|json|xml/.test(file.type) && !/\.(md|txt|csv|json)$/i.test(file.name)) return `「${file.name}」不是文本文件。首版只支持文本资料。`
    addFile({ id: 'f-' + uid(), name: file.name, kind: 'source', mimeType: file.type || 'text/plain', size: file.size, content: await file.text(), modifiedTime: Date.now() })
    return null
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
  }

  return { state, setState, patchConv, startConversation, reply, retry, stop, reset, callToolFromView, setViewState, upload, setDrive, refreshFiles: () => {}, readFile, searchDrive, bridge: null }
}
