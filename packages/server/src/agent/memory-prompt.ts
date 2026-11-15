// What the model reads about memory and projects (roadmap-7 A). Written and reviewed as prose: change it here, then
// update test/prompt.snapshot.md. Wiring (tables, tools, sections) lives in memory.ts / projects.ts.
import type { Memory, Project } from '@gense/protocol'
import { MEMORY_LIMITS, projectDir } from '@gense/protocol'

export const MEMORY_TOOL = {
  name: 'memory',
  label: '记忆',
  description: [
    'Save, correct or delete a long-term memory about the user. Memories are shown to you at the start of every later conversation, on the web and in chat apps.',
    '',
    'Use it when the user:',
    '- asks you to remember something ("remember that…", "from now on…", "always/never…") → add',
    '- corrects a memory or says it is out of date → update that entry',
    '- asks you to forget something → remove that entry',
    '',
    'Only save durable facts about the user: their background, ongoing projects, stable preferences for how you should work. Do not save one-off task details, things that only matter in this conversation, or what you can find again in the conversation itself. Never save passwords, API keys, ID or card numbers; the tool rejects them.',
    '',
    'Write each memory as one self-contained sentence in the user\'s language, about the user in the third person ("Prefers metric units", "用户在南京大学读研"). Prefer updating an existing entry to adding a near-duplicate. The user sees every change and can undo it, so do not ask before saving what they asked you to remember; mention it in a few words in your answer.',
  ].join('\n'),
  parameters: {
    action: 'add | update | remove',
    text: 'The memory as one sentence. Required for add and update; at most 500 characters.',
    id: 'The entry to update or remove, as shown in <memories>.',
    scope: '`project` to keep it only for the current project (default when the conversation is in a project and the fact is about that project); `global` otherwise.',
  },
} as const

/** Added to the tool description when the user chose `memoryWrites: 'explicit'`. */
export const MEMORY_EXPLICIT_ONLY = 'The user asked you to save memories only when they explicitly tell you to remember something; never save one on your own initiative.'

/** Added when the user chose `auto`: the model may also save what the user did not explicitly ask to keep. */
export const MEMORY_AUTO =
  'You may also save a memory without being asked, when the user states a durable fact or preference that will clearly help in future conversations. Do this sparingly: at most one or two per conversation.'

/** The memory section of the system prompt, or undefined when there is nothing to show. */
export function memorySection(entries: readonly Memory[], projectId: string | null): string | undefined {
  const visible = entries.filter((m) => m.enabled && (m.projectId === null || m.projectId === projectId)).sort((a, b) => b.updatedAt - a.updatedAt)
  const lines: string[] = []
  let size = 0
  for (const m of visible) {
    const line = `- [${m.id}]${m.projectId ? ' (project)' : ''} ${m.text}`
    if (size + line.length > MEMORY_LIMITS.prompt) break
    lines.push(line)
    size += line.length + 1
  }
  const intro =
    'What the user asked you to remember, or you saved earlier with the `memory` tool. Use it when relevant, without mentioning that you remembered unless asked. If the user contradicts an entry, follow the user and update the entry.'
  if (lines.length === 0) return `${intro}\n<memories>\n(none yet)\n</memories>`
  const hidden = visible.length - lines.length
  return `${intro}\n<memories>\n${lines.join('\n')}\n</memories>${hidden > 0 ? `\n(${hidden} older entries are not shown.)` : ''}`
}

/** The project section of the system prompt for a conversation in `project`. */
export function projectSection(project: Project, files: readonly { path: string; size: number }[]): string {
  const dir = projectDir(project.id)
  const parts = [`This conversation belongs to the user's project "${project.name}".`]
  if (project.instructions.trim()) {
    parts.push(`The project's instructions apply to every conversation in it. Where they differ from your default guidance, follow them:\n<project_instructions>\n${project.instructions.trim()}\n</project_instructions>`)
  }
  if (files.length > 0) {
    const shown = files.slice(0, 50).map((f) => `- ${f.path.replace(`${dir}/`, '')} (${formatSize(f.size)})`)
    parts.push(
      `The project's files are in ${dir}/ (read-only; copy one into the conversation's workspace before changing it). Read the ones relevant to the question before answering from memory:\n${shown.join('\n')}${files.length > 50 ? `\n(and ${files.length - 50} more; list the directory to see them)` : ''}`,
    )
  }
  return parts.join('\n\n')
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
