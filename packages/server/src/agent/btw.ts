// A side question about a branch ("btw", roadmap: no conversation tree). A metered model call outside the durable
// conversation: it reads the branch's messages and is never written back, so the main line does not change.
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import type { ModelInfo } from '@gense/protocol'
import { BTW_CONTEXT_CHARS, BTW_QUESTION_CHARS, BTW_SYSTEM, btwInput } from './btw-prompt.ts'
import { chatText } from './branches.ts'
import type { UserSpace } from './space.ts'

/** Answers `question` from the branch's conversation, calling `onText` with the answer so far; resolves to all of it. */
export async function btw(
  space: UserSpace,
  treeId: string,
  input: { branchId?: string; question: string; model?: ModelInfo },
  onText: (text: string) => void,
  signal: AbortSignal,
  ctx: Context = BACKGROUND_CONTEXT,
): Promise<string> {
  const question = input.question.trim()
  if (!question) throw new Error('问题不能为空')
  if (question.length > BTW_QUESTION_CHARS) throw new Error(`问题太长了（最多 ${BTW_QUESTION_CHARS} 字）`)
  const { branch } = await space.branchRow(treeId, input.branchId)
  await space.checkModel(input.model)
  const conv = await space.open(branch, ctx)
  const agent = await conv.agent(ctx)
  const fallback = await space.accounts.defaultModel()
  const chosen = input.model ?? (agent.model ? { provider: agent.model.provider, id: agent.model.modelId } : fallback)
  const model = chosen && space.accounts.models.getModel(chosen.provider, chosen.id)
  if (!model) throw new Error('没有可用的模型')
  const { messages } = await conv.context(ctx)
  const stream = space.accounts.models.streamSimple(
    model,
    { systemPrompt: BTW_SYSTEM, messages: [{ role: 'user', content: btwInput(chatText(messages, BTW_CONTEXT_CHARS), question), timestamp: space.now() }], tools: [] },
    // pi-ai's simple API disables thinking when no reasoning level is supplied: a side answer should be quick.
    { maxTokens: 2000, timeoutMs: 60_000, maxRetries: 0, signal },
  )
  let text = ''
  for await (const event of stream) {
    if (event.type !== 'text_delta') continue
    text += event.delta
    onText(text)
  }
  const final = await stream.result()
  if (signal.aborted || final.stopReason === 'aborted') throw new Error('已取消')
  if (final.stopReason === 'error') throw new Error(final.errorMessage || '回答失败，请重试')
  return text || final.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
}
