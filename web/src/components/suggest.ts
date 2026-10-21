import { availableCommands, type Command } from '../commands'
import type { Store } from '../store'
import { listed, type Attachment } from '../types'

/** A candidate in the `@` menu; a file becomes an attachment, a plugin or chat a mention. */
export interface MentionOption {
  kind: 'plugin' | 'file' | 'chat'
  id: string
  label: string
  hint?: string
  file?: Attachment
}

export interface Suggestions {
  commands: Command[]
  mentions: MentionOption[]
}

/** What the composer's `/` and `@` menus offer (roadmap-2 R17, R18). */
export function suggestions(store: Store, opts: { convId?: string; side?: boolean } = {}): Suggestions {
  const { plugins, skills, files, conversations } = store.state
  const enabled = plugins.filter((p) => p.enabled && p.available)
  return {
    commands: availableCommands(
      enabled.map((p) => p.id),
      skills,
      { side: !!opts.side },
    ),
    mentions: [
      ...enabled.map((p): MentionOption => ({ kind: 'plugin', id: p.id, label: p.name })),
      ...files.map((f): MentionOption => ({ kind: 'file', id: f.id, label: f.name, hint: f.kind === 'artifact' ? 'Artifacts' : '资料', file: { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size } })),
      ...listed(conversations)
        .filter((c) => c.id !== opts.convId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((c): MentionOption => ({ kind: 'chat', id: c.id, label: c.title })),
    ],
  }
}
