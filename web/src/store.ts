import { useCallback, useEffect, useRef, useState } from 'react'
import { planReply, uid } from './mock/engine'
import { seed } from './mock/seed'
import type { AppState, Conversation, Effort, Turn } from './types'

const KEY = 'gensebot-mock-v1'

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as AppState
  } catch {
    // Storage unavailable or corrupt: fall back to seed data.
  }
  return structuredClone(seed)
}

export type Store = ReturnType<typeof useStore>

export function useStore() {
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

  const run = useCallback(
    (convId: string, turn: Turn) => {
      const script = planReply(turn.userMessage, stateRef.current.docs)
      const ids: number[] = []
      timers.current.set(turn.id, ids)
      let t = 0
      const at = (delay: number, fn: () => void) => {
        t += delay
        ids.push(window.setTimeout(fn, t))
      }
      const patch = (fn: (t: Turn) => Turn) => patchTurn(convId, turn.id, fn)

      at(700, () => patch((x) => ({ ...x, status: 'running', summary: script.summary })))
      for (const tool of script.tools) {
        at(300, () => patch((x) => ({ ...x, toolCalls: [...x.toolCalls, { ...tool, status: 'running', output: undefined }] })))
        at((tool.durationMs ?? 200) + 500, () =>
          patch((x) => ({ ...x, toolCalls: x.toolCalls.map((c) => (c.id === tool.id ? { ...tool, status: 'succeeded' } : c)) })),
        )
      }
      if (script.error) {
        at(900, () => patch((x) => ({ ...x, status: 'failed', error: script.error })))
      } else {
        const chunks = script.text.match(/[\s\S]{1,4}/g) ?? []
        at(300, () => {})
        chunks.forEach((chunk) => at(18, () => patch((x) => ({ ...x, assistantMessage: x.assistantMessage + chunk }))))
        at(200, () =>
          patch((x) => ({ ...x, status: 'succeeded', citations: script.citations, confirmation: script.confirmation })),
        )
      }
      at(0, () => timers.current.delete(turn.id))
    },
    [patchTurn],
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

  const newTurn = (message: string, model: string, effort: Effort): Turn => ({
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
  })

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
    return conv.id
  }

  const reply = (convId: string, message: string, model: string, effort: Effort) => {
    const turn = newTurn(message, model, effort)
    patchConv(convId, (c) => ({ ...c, updatedAt: Date.now(), turns: [...c.turns, turn] }))
    run(convId, turn)
  }

  const retry = (convId: string, turn: Turn) => reply(convId, turn.userMessage, turn.model, turn.effort)

  const stop = (convId: string, turnId: string) => {
    timers.current.get(turnId)?.forEach(clearTimeout)
    timers.current.delete(turnId)
    patchTurn(convId, turnId, (t) => ({
      ...t,
      status: 'interrupted',
      toolCalls: t.toolCalls.map((c) => (c.status === 'running' ? { ...c, status: 'failed', output: '已被你停止' } : c)),
    }))
  }

  const reset = () => {
    timers.current.forEach((ids) => ids.forEach(clearTimeout))
    timers.current.clear()
    setState(structuredClone(seed))
  }

  return { state, setState, patchConv, patchTurn, startConversation, reply, retry, stop, reset }
}
