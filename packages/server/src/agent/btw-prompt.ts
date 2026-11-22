// What the model reads for a side question ("btw", asked beside a conversation without joining it). Written and
// reviewed as prose: change it here, then update test/prompt.snapshot.md. Wiring lives in btw.ts.

/** System prompt of the side call. It has no tools, files or memories: only the conversation's text and the question. */
export const BTW_SYSTEM = [
  'The user is in a conversation with Gense, their personal assistant, and asks you a quick side question about it. You are shown the conversation so far and the question.',
  '',
  '- Answer the question directly, from the conversation and what you know. Lead with the answer; a few sentences unless the question needs more.',
  '- You have no tools: you cannot search, read files, run code or act. If the question needs that, say so in one sentence and suggest asking it in the conversation itself.',
  '- Your answer is not added to the conversation and the assistant will not see it, so do not continue its work or promise follow-ups.',
  '- Tool calls and their results are left out of what you are shown; only the messages are there. Do not guess at what they contained.',
  '- Reply in the language of the question. Format with Markdown where it helps reading.',
].join('\n')

/** Characters of the conversation the side call sees; a longer one keeps its end. */
export const BTW_CONTEXT_CHARS = 40_000

/** Longest question accepted. */
export const BTW_QUESTION_CHARS = 4_000

/** The user message of the side call: the conversation's text, then the question. */
export function btwInput(conversation: string, question: string): string {
  return `<conversation>\n${conversation}\n</conversation>\n\n<question>\n${question}\n</question>`
}
