// The parts of a user message besides its text (roadmap-3 R33: R17, R18): attachments, the `/` command and `@`
// mentions. Each is a text block the model reads and the web client parses back to show a chip instead. Pure, so
// the browser imports it too.
import type { ParsedAttachment } from './deepseek.js'

export interface CommandNote {
  id: string
  label: string
  /** The instruction for the model. */
  prompt: string
}

/** An `@`-mentioned plugin, workspace file (`id` is its path) or conversation (`id` is its tree id). */
export interface Mention {
  kind: 'plugin' | 'workspace' | 'chat'
  id: string
  label: string
}

/**
 * One line per file: its path, or, once the server has read it into text (roadmap-7 C-3),
 * `<path> -> <textPath> (text)` / `<path> -> <textPath> (ocr, N pages)` so the model reads the text file instead.
 */
export const attachmentsText = (items: (string | ParsedAttachment)[]) =>
  `<attachments>\n${items.map((a) => (typeof a === 'string' ? a : `${a.path} -> ${a.textPath} (${a.how}${a.pages ? `, ${a.pages} pages` : ''})`)).join('\n')}\n</attachments>`

const PARSED = /^(.+) -> (.+) \((text|ocr)(?:, (\d+) pages?)?\)$/

const attr = (s: string) => JSON.stringify(s)

export const commandText = (c: CommandNote) => `<command id=${attr(c.id)} label=${attr(c.label)}>\n${c.prompt}\n</command>`

/** `detail` is what the model should do with each mention; a mentioned conversation carries its transcript. */
export const mentionsText = (mentions: (Mention & { detail: string })[]) =>
  `<mentions>\n${mentions.map((m) => `<mention kind=${attr(m.kind)} id=${attr(m.id)} label=${attr(m.label)}>\n${m.detail}\n</mention>`).join('\n')}\n</mentions>`

const STRING = '"(?:[^"\\\\]|\\\\.)*"'

export interface ParsedNotes {
  /** The attached files' own paths, read into text or not. */
  attachments: string[]
  /** The ones the server read into text. */
  parsedAttachments: ParsedAttachment[]
  command?: { id: string; label: string }
  mentions: Mention[]
}

/** Reads one text block: the notes it holds, or null when it is the user's own text. */
export function parseNote(text: string): ParsedNotes | null {
  const attached = /^<attachments>\n([\s\S]*)\n<\/attachments>$/.exec(text)
  if (attached) {
    const attachments: string[] = []
    const parsedAttachments: ParsedAttachment[] = []
    for (const line of attached[1]!.split('\n')) {
      const m = PARSED.exec(line)
      if (!m) {
        attachments.push(line)
        continue
      }
      attachments.push(m[1]!)
      parsedAttachments.push({ path: m[1]!, textPath: m[2]!, how: m[3] as ParsedAttachment['how'], ...(m[4] && { pages: Number(m[4]) }) })
    }
    return { attachments, parsedAttachments, mentions: [] }
  }
  const command = new RegExp(`^<command id=(${STRING}) label=(${STRING})>\\n[\\s\\S]*\\n</command>$`).exec(text)
  if (command) return { attachments: [], parsedAttachments: [], command: { id: JSON.parse(command[1]!), label: JSON.parse(command[2]!) }, mentions: [] }
  if (text.startsWith('<mentions>\n') && text.endsWith('\n</mentions>')) {
    const mentions: Mention[] = []
    for (const m of text.matchAll(new RegExp(`^<mention kind=(${STRING}) id=(${STRING}) label=(${STRING})>$`, 'gm')))
      mentions.push({ kind: JSON.parse(m[1]!), id: JSON.parse(m[2]!), label: JSON.parse(m[3]!) })
    return { attachments: [], parsedAttachments: [], mentions }
  }
  return null
}
