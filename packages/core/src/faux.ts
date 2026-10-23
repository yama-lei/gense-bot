// Scripted model for E2E tests and offline dev (GENSE_FAUX=1, ADR-0004 decision 6), on either host. Replies depend only on the
// user's own text of the last user message (its first block; notes follow it), so a restarted process answers the same way:
//   "[长回答] ..."  a long reply that streams for a few seconds
//   "[错误] ..."    a provider error
//   "[工具 name] {json}"  calls the tool, then answers "工具结果：<its text>"
//   the summarize prompt  calls `report` with "分叉总结" and the branch's earlier user messages
//   "[派出] a|b|c"  calls `agent_spawn` once for each task, in one message
//   a subagent's brief  works on its task by these same rules, except that a task "[汇报] ..." calls `report`
//   anything else   "收到：<text>"
import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ModelSetup } from './models.ts'
import { SUMMARIZE_PROMPT } from './events.ts'

export const LONG_REPLY = Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 句。`).join('')

const lastUserText = (messages: readonly Message[]) => {
  const m = messages.findLast((m) => m.role === 'user')
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  const first = m.content[0]
  return first?.type === 'text' ? first.text : ''
}

export function fauxModels(): ModelSetup {
  const faux = fauxProvider({ models: [{ id: 'faux-1', name: 'Faux' }], tokensPerSecond: 200 })
  const reply: FauxResponseFactory = (context) => {
    faux.appendResponses([reply])
    const last = context.messages.at(-1)
    if (last?.role === 'toolResult') {
      const result = last.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      return fauxAssistantMessage([fauxText(`工具结果：${result}`)])
    }
    let text = lastUserText(context.messages)
    const brief = /^你是子 agent「(.+?)」。任务：\n([\s\S]*?)\n\n完成后/.exec(text)
    const task = brief?.[2] ?? text
    if (brief && task.startsWith('[汇报]')) return fauxAssistantMessage([fauxToolCall('report', { title: `完成：${brief[1]}`, body: `${task.slice(4).trim()} 的结果` })], { stopReason: 'toolUse' })
    if (brief) text = task
    const spawn = /^\[派出\]\s*(.+)$/.exec(text)
    if (spawn) return fauxAssistantMessage(spawn[1]!.split('|').map((t) => fauxToolCall('agent_spawn', { task: t.trim(), title: t.replace(/^\[\S+\]/, '').trim() })), { stopReason: 'toolUse' })
    const tool = /^\[工具 (\S+)\]\s*([\s\S]*)$/.exec(text)
    if (text === SUMMARIZE_PROMPT) {
      const asked = context.messages.flatMap((m) => (m.role === 'user' && typeof m.content !== 'string' && m.content[0]?.type === 'text' && m.content[0].text !== SUMMARIZE_PROMPT ? [m.content[0].text] : []))
      return fauxAssistantMessage([fauxToolCall('report', { title: '分叉总结', body: asked.map((t) => `- ${t}`).join('\n') })], { stopReason: 'toolUse' })
    }
    if (tool) return fauxAssistantMessage([fauxToolCall(tool[1]!, JSON.parse(tool[2] || '{}'))], { stopReason: 'toolUse' })
    if (text.startsWith('[错误]')) return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'faux provider error' })
    if (text.startsWith('[长回答]')) return fauxAssistantMessage([fauxText(LONG_REPLY)])
    return fauxAssistantMessage([fauxText(`收到：${text}`)])
  }
  faux.setResponses([reply])
  const model = faux.getModel()
  const option = { provider: model.provider, id: model.id, name: model.name }
  return { providers: [faux.provider], options: [option], defaultModel: option }
}
