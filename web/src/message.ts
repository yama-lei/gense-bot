import type { Attachment, Outgoing, UserMetadata } from './types'

// A user message carries its attachments, command and mentions twice: in the metadata for the
// UI, and in hidden text parts for the model, so regenerations, edits and any model see them.

const ATTACHMENTS = '[附件]'
const COMMAND = '[命令]'
const MENTIONS = '[提及]'

/** Text parts the UI hides. */
export const isHiddenNote = (text: string) => [ATTACHMENTS, COMMAND, MENTIONS].some((p) => text.startsWith(p))

export function attachmentNote(files: Attachment[]): string {
  return `${ATTACHMENTS} 用户随这条消息附上了以下文件，需要时用 files_read 读取：\n${files.map((f) => `- ${f.name}（id: ${f.id}，${f.mimeType}）`).join('\n')}`
}

/** The parts and metadata of a message sent from the composer. */
export function userMessage({ text, attachments = [], command, mentions = [] }: Outgoing) {
  const notes: string[] = []
  if (command) notes.push(`${COMMAND} /${command.label}\n${command.prompt}`)
  if (mentions.length)
    notes.push(
      `${MENTIONS} 用户在消息中提到了：\n` +
        mentions
          .map((m) => (m.kind === 'plugin' ? `- 插件「${m.label}」：本轮优先使用这个插件的工具。` : `- 会话「${m.label}」（id: ${m.id}）：用 chats_read 读取它的内容作为上下文。`))
          .join('\n'),
    )
  if (attachments.length) notes.push(attachmentNote(attachments))
  const metadata: UserMetadata = {
    ...(attachments.length ? { attachments } : {}),
    ...(command ? { command: { id: command.id, label: command.label } } : {}),
    ...(mentions.length ? { mentions } : {}),
  }
  return {
    parts: [{ type: 'text' as const, text }, ...notes.map((n) => ({ type: 'text' as const, text: n }))],
    metadata,
  }
}
