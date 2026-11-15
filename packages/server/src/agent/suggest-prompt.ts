// What the model reads when it proposes follow-ups after an answer (roadmap-7 D2). Written and reviewed as prose:
// change it here, then update test/prompt.snapshot.md. Wiring (when to call, parsing, pushing) lives elsewhere.

/** System prompt of the side call. It sees no tools, files or memories: only the last exchange. */
export const SUGGEST_SYSTEM = [
  'You suggest what the user might say next in a chat with an AI assistant. You are shown their last question and the assistant\'s answer.',
  '',
  'Write 3 short follow-ups the user would plausibly send next, each as the user speaking to the assistant:',
  '- Specific to this answer: dig into a point it raised, ask for the next step, apply it to a concrete case, or check a doubtful claim. Never generic ("tell me more", "give an example") unless nothing better fits.',
  '- Each different in direction; no two that ask the same thing.',
  '- In the language the user wrote in. At most 20 words, or 30 characters in Chinese or Japanese. No numbering, quotes or trailing period.',
  '- Nothing the answer already covers, nothing that needs information the assistant cannot have, nothing unsafe.',
  '',
  'If the exchange is a greeting, a finished small task, or a refusal, or no follow-up would help, return an empty list.',
  '',
  'Reply with JSON only: {"items": ["…", "…", "…"]}',
].join('\n')

/** Characters of the answer the side call sees; longer answers keep their start and end. */
export const SUGGEST_ANSWER_CHARS = 6000

/** The user message of the side call. */
export function suggestInput(question: string, answer: string): string {
  const half = SUGGEST_ANSWER_CHARS / 2
  const shown = answer.length > SUGGEST_ANSWER_CHARS ? `${answer.slice(0, half)}\n…\n${answer.slice(-half)}` : answer
  return `<question>\n${question.slice(0, 2000)}\n</question>\n\n<answer>\n${shown}\n</answer>`
}

/** Parses the reply; anything malformed is treated as no suggestions. At most 3, each trimmed to 40 characters. */
export function parseSuggestions(reply: string): string[] {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]
  if (!json) return []
  try {
    const items = (JSON.parse(json) as { items?: unknown }).items
    if (!Array.isArray(items)) return []
    const seen = new Set<string>()
    return items
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim().replace(/^["“]|["”。.]$/g, '').slice(0, 40))
      .filter((s) => s && !seen.has(s) && seen.add(s))
      .slice(0, 3)
  } catch {
    return []
  }
}
