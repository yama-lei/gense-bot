// Scripted model for E2E tests and offline dev (GENSE_FAUX=1, ADR-0004 decision 6). Replies depend only on the last
// user message, so a restarted process answers the same way:
//   "[长回答] ..."  a long reply that streams for a few seconds
//   "[错误] ..."    a provider error
//   anything else   "收到：<text>"
import { createModels, type Message } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxText, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import type { ModelSetup } from '@gense/core'

export const LONG_REPLY = Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 句。`).join('')

const lastUserText = (messages: readonly Message[]) => {
  const m = messages.findLast((m) => m.role === 'user')
  if (!m) return ''
  return typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

export function fauxModels(): ModelSetup {
  const faux = fauxProvider({ models: [{ id: 'faux-1', name: 'Faux' }], tokensPerSecond: 200 })
  const reply: FauxResponseFactory = (context) => {
    faux.appendResponses([reply])
    const text = lastUserText(context.messages)
    if (text.startsWith('[错误]')) return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'faux provider error' })
    if (text.startsWith('[长回答]')) return fauxAssistantMessage([fauxText(LONG_REPLY)])
    return fauxAssistantMessage([fauxText(`收到：${text}`)])
  }
  faux.setResponses([reply])
  const models = createModels()
  models.setProvider(faux.provider)
  const model = faux.getModel()
  const option = { provider: model.provider, id: model.id, name: model.name }
  return { models, options: [option], defaultModel: option }
}
