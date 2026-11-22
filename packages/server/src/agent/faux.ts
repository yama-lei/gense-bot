// Scripted model for E2E tests and offline dev (GENSE_FAUX=1, ADR-0004 decision 6), on either host. Replies depend only on the
// user's own text of the last user message (its first block; notes follow it), so a restarted process answers the same way:
//   "[长回答] ..."  a long reply that streams for a few seconds
//   "[错误] ..."    a provider error
//   "[工具 name] {json}"  calls the tool, then answers "工具结果：<its text>"
//   "[派出] a|b|c"  calls `agent_spawn` once for each task, in one message
//   a subagent's brief  works on its task by these same rules, except that a task "[汇报] ..." calls `report`
//   a side question (btw)  "顺便回答：<the side call's whole user message>"
//   anything else   "收到：<text>"
import type { Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ModelSetup } from './models.ts'
import { SUGGEST_SYSTEM } from './suggest-prompt.ts'
import { BTW_SYSTEM } from './btw-prompt.ts'

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
    if (context.messages.some(m => m.role === 'system' && m.content === SUGGEST_SYSTEM)) return fauxAssistantMessage([fauxText('{"items":[]}')])
    if (context.messages.some(m => m.role === 'system' && m.content === BTW_SYSTEM)) return fauxAssistantMessage([fauxText(`顺便回答：${lastUserText(context.messages)}`)])
    // A tool may change a dynamic prompt section (memory, projects), adding a system patch after its result.
    const last = context.messages.findLast(m => m.role !== 'system')
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
