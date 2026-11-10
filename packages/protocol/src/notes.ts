// The parts of a user message besides its text (roadmap-3 R33: R17, R18): attachments, the `/` command and `@`
// mentions. Each is a text block the model reads and the web client parses back to show a chip instead. Pure, so
// the browser imports it too.

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

export const attachmentsText = (paths: string[]) => `<attachments>\n${paths.join('\n')}\n</attachments>`

const attr = (s: string) => JSON.stringify(s)

export const commandText = (c: CommandNote) => `<command id=${attr(c.id)} label=${attr(c.label)}>\n${c.prompt}\n</command>`

/** `detail` is what the model should do with each mention; a mentioned conversation carries its transcript. */
export const mentionsText = (mentions: (Mention & { detail: string })[]) =>
  `<mentions>\n${mentions.map((m) => `<mention kind=${attr(m.kind)} id=${attr(m.id)} label=${attr(m.label)}>\n${m.detail}\n</mention>`).join('\n')}\n</mentions>`

const STRING = '"(?:[^"\\\\]|\\\\.)*"'

export interface ParsedNotes {
  attachments: string[]
  command?: { id: string; label: string }
  mentions: Mention[]
}

/** Reads one text block: the notes it holds, or null when it is the user's own text. */
export function parseNote(text: string): ParsedNotes | null {
  const attached = /^<attachments>\n([\s\S]*)\n<\/attachments>$/.exec(text)
  if (attached) return { attachments: attached[1]!.split('\n'), mentions: [] }
  const command = new RegExp(`^<command id=(${STRING}) label=(${STRING})>\\n[\\s\\S]*\\n</command>$`).exec(text)
  if (command) return { attachments: [], command: { id: JSON.parse(command[1]!), label: JSON.parse(command[2]!) }, mentions: [] }
  if (text.startsWith('<mentions>\n') && text.endsWith('\n</mentions>')) {
    const mentions: Mention[] = []
    for (const m of text.matchAll(new RegExp(`^<mention kind=(${STRING}) id=(${STRING}) label=(${STRING})>$`, 'gm')))
      mentions.push({ kind: JSON.parse(m[1]!), id: JSON.parse(m[2]!), label: JSON.parse(m[3]!) })
    return { attachments: [], mentions }
  }
  return null
}
