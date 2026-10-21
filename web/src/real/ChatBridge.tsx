import { useAgentChat } from '@cloudflare/think/react'
import { useAgent } from 'agents/react'
import { useEffect, useState } from 'react'
import type { Effort, HubState, ToolResult, Turn, TurnBody } from '../types'
import { pending } from './pending'
import { toTurns, type ChatStatus } from './turns'

export interface ChatControls {
  send: (text: string, model: string, effort: Effort) => void
  stop: () => void
  /** `tools/call` from a view, run by the chat; `key` is the rendering tool call's id. */
  callTool: (name: string, args: unknown, key: string) => Promise<ToolResult>
  setViewState: (callId: string, state: unknown) => void
}

/** Keeps the open chat's WebSocket and projects its messages onto turns. Renders nothing. */
export function ChatBridge({
  id,
  defaults,
  onTurns,
  register,
}: {
  id: string
  defaults: HubState['prefs']
  onTurns: (id: string, turns: Turn[]) => void
  register: (id: string, c: ChatControls | null) => void
}) {
  const agent = useAgent({ agent: 'Chat', basePath: `agents/hub/chats/${encodeURIComponent(id)}` })
  const chat = useAgentChat({ agent })
  const [stopped, setStopped] = useState<ReadonlySet<string>>(new Set())
  const [viewStates, setViewStates] = useState<Record<string, unknown>>({})
  const { messages, status, error, isServerStreaming, sendMessage, stop } = chat

  useEffect(() => {
    const send = (text: string, model: string, effort: Effort) => {
      const body: TurnBody = { model, effort }
      void sendMessage({ text }, { body: { ...body } })
    }
    register(id, {
      send,
      stop: () => {
        const last = messages.findLast((m) => m.role === 'user')
        if (last) setStopped((s) => new Set(s).add(last.id))
        void stop()
      },
      callTool: (name, args, key) => agent.call<ToolResult>('callTool', [name, args, key]),
      setViewState: (callId, state) => {
        setViewStates((s) => ({ ...s, [callId]: state }))
        agent.call('setViewState', [callId, state]).catch((e: unknown) => console.error('setViewState failed', e))
      },
    })
    return () => register(id, null)
  }, [id, register, sendMessage, stop, messages, agent])

  useEffect(() => {
    if (!agent.identified) return
    agent
      .call<Record<string, unknown>>('viewStates', [])
      .then((v) => setViewStates((s) => ({ ...v, ...s })))
      .catch((e: unknown) => console.error('viewStates failed', e))
  }, [agent, agent.identified])

  // Send the message the chat was created with, once the socket is up.
  useEffect(() => {
    if (!agent.identified) return
    const first = pending.get(id)
    if (!first) return
    pending.delete(id)
    void sendMessage({ text: first.text }, { body: { model: first.model, effort: first.effort } })
  }, [agent.identified, id, sendMessage])

  useEffect(() => {
    onTurns(
      id,
      toTurns(messages, {
        status: status as ChatStatus,
        streaming: isServerStreaming,
        error: error?.message,
        stopped,
        viewStates,
        defaultEffort: defaults.defaultEffort,
        defaultModel: defaults.model,
      }),
    )
  }, [id, messages, status, error, isServerStreaming, stopped, viewStates, defaults, onTurns])

  return null
}
