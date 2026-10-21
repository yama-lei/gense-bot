import { useAgentChat } from '@cloudflare/think/react'
import { useAgent } from 'agents/react'
import type { UIMessage } from 'ai'
import { useEffect, useState } from 'react'
import { userMessage } from '../message'
import type { Effort, HubState, Outgoing, ToolResult, Turn, TurnBody } from '../types'
import { pending } from './pending'
import { toTurns, type ChatStatus } from './turns'

export interface ChatControls {
  send: (message: Outgoing, model: string, effort: Effort) => void
  stop: () => void
  regenerate: (turn: Turn, body: TurnBody) => void
  edit: (turn: Turn, text: string, body: TurnBody) => void
  /** Shows the version through `messageId`; the live path when it is on it. */
  show: (messageId: string) => void
  /** `tools/call` from a view, run by the chat; `key` is the rendering tool call's id. */
  callTool: (name: string, args: unknown, key: string) => Promise<ToolResult>
  setViewState: (callId: string, state: unknown) => void
}

type Siblings = Record<string, string[]>

/** Keeps a chat's WebSocket and projects its messages onto turns. Renders nothing. */
export function ChatBridge({
  id,
  defaults,
  onTurns,
  register,
}: {
  id: string
  defaults: HubState['prefs']
  onTurns: (id: string, turns: Turn[], viewingOld: boolean) => void
  register: (id: string, c: ChatControls | null) => void
}) {
  const agent = useAgent({ agent: 'Chat', basePath: `agents/hub/chats/${encodeURIComponent(id)}` })
  const chat = useAgentChat({ agent })
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set())
  const [viewStates, setViewStates] = useState<Record<string, unknown>>({})
  const [siblings, setSiblings] = useState<Siblings>({})
  // An older version being read; null shows the live conversation.
  const [viewing, setViewing] = useState<{ messages: UIMessage[]; siblings: Siblings } | null>(null)
  const { messages, status, error, isServerStreaming, sendMessage, regenerate, stop } = chat

  useEffect(() => {
    const unstop = (turnId: string) =>
      setStopped((s) => {
        const next = new Set(s)
        next.delete(turnId)
        return next
      })
    register(id, {
      send: (message, model, effort) => {
        setViewing(null)
        const body: TurnBody = { model, effort }
        void sendMessage(userMessage(message), { body: { ...body } })
      },
      stop: () => {
        const last = messages.findLast((m) => m.role === 'user')
        if (last) setStopped((s) => new Set(s).add(last.id))
        void stop()
      },
      regenerate: (turn, body) => {
        setViewing(null)
        unstop(turn.id)
        void regenerate({ messageId: turn.id, body: { ...body } })
      },
      edit: (turn, text, body) => {
        setViewing(null)
        agent.call('editMessage', [turn.id, text, body]).catch((e: unknown) => console.error('editMessage failed', e))
      },
      show: (messageId) => {
        if (!messageId || messages.some((m) => m.id === messageId)) return setViewing(null)
        agent
          .call<{ messages: UIMessage[]; siblings: Siblings }>('view', [messageId])
          .then(setViewing)
          .catch((e: unknown) => console.error('view failed', e))
      },
      callTool: (name, args, key) => agent.call<ToolResult>('callTool', [name, args, key]),
      setViewState: (callId, state) => {
        setViewStates((s) => ({ ...s, [callId]: state }))
        agent.call('setViewState', [callId, state]).catch((e: unknown) => console.error('setViewState failed', e))
      },
    })
    return () => register(id, null)
  }, [id, register, sendMessage, regenerate, stop, messages, agent])

  useEffect(() => {
    if (!agent.identified) return
    agent
      .call<Record<string, unknown>>('viewStates', [])
      .then((v) => setViewStates((s) => ({ ...v, ...s })))
      .catch((e: unknown) => console.error('viewStates failed', e))
  }, [agent, agent.identified])

  // Versions change only when messages are added; ask again once a turn settles.
  const settled = status === 'ready' && !isServerStreaming
  const path = messages.map((m) => m.id).join()
  useEffect(() => {
    if (!agent.identified || !settled || !path) return
    agent
      .call<Siblings>('versions', [])
      .then(setSiblings)
      .catch((e: unknown) => console.error('versions failed', e))
  }, [agent, agent.identified, settled, path])

  // Send the message the chat was created with, once the socket is up.
  useEffect(() => {
    if (!agent.identified) return
    const first = pending.get(id)
    if (!first) return
    pending.delete(id)
    void sendMessage(userMessage(first.message), { body: { model: first.model, effort: first.effort } })
  }, [agent.identified, id, sendMessage])

  useEffect(() => {
    const base = { stopped, viewStates, defaultEffort: defaults.defaultEffort, defaultModel: defaults.model }
    const turns = viewing
      ? toTurns(viewing.messages, { ...base, status: 'ready', streaming: false, siblings: viewing.siblings })
      : toTurns(messages, { ...base, status: status as ChatStatus, streaming: isServerStreaming, error: error?.message, siblings })
    onTurns(id, turns, viewing != null)
  }, [id, messages, status, error, isServerStreaming, stopped, viewStates, defaults, onTurns, siblings, viewing])

  return null
}
