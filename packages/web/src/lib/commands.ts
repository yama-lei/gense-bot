import type { FileEntry, SkillInfo } from '@gense/protocol'
import type { Outgoing } from './types'

/** A `/` command (roadmap-2 R17). A client command runs in the browser and sends nothing. */
export interface Command {
  id: string
  label: string
  hint: string
  /** Instruction added to the message for the model. */
  prompt: string
  /** Plugin the command needs; hidden while it is off. */
  plugin?: string
  client?: boolean
}

export const builtinCommands: Command[] = [
  {
    id: 'research',
    label: '深度搜索',
    hint: '多方检索、交叉核对，给出带来源的结论',
    prompt: '用户要求深度搜索：用 deep_search 从多个角度检索并读取网页，必要时再用 web_search / web_fetch 补充，交叉核对后回答，并用链接注明来源。',
    plugin: 'web',
  },
  {
    id: 'fetch',
    label: '读网页',
    hint: '读取消息里的网址，再回答',
    prompt: '用户要求读网页：用 web_fetch 读取消息中的网址（没有网址时先问用户要），根据正文回答。',
    plugin: 'web',
  },
  {
    id: 'summarize',
    label: '总结会话',
    hint: '把到目前为止的对话整理成要点',
    prompt: '用户要求总结会话：把本会话到目前为止的内容整理成简洁的要点（结论、待办、未决问题），不需要调用工具。',
  },
]

/** Runs in the browser: the message's text, if any, becomes extra instructions for the summary (roadmap-6 C3). */
export const compactCommand: Command = {
  id: 'compact',
  label: '压缩上下文',
  hint: '把较早的对话总结成摘要，腾出上下文；可附上要保留的重点',
  prompt: '',
  client: true,
}

export const skillCommand = (s: Pick<SkillInfo, 'name' | 'description'>): Command => ({
  id: `skill:${s.name}`,
  label: s.name,
  hint: s.description,
  prompt: `用户要求使用 Skill「${s.name}」：先用 read 读取它的 SKILL.md（路径见系统提示里的 Skill 列表），再按其中的说明完成任务。`,
})

/** A chat's own skills: folders of skills/ in its workspace holding a SKILL.md (roadmap-3 R33: R29). */
export function localSkillNames(files: FileEntry[] = []): string[] {
  return files.flatMap((f) => (f.readOnly ? [] : (/^\/data\/sessions\/[^/]+\/skills\/([^/]+)\/SKILL\.md$/.exec(f.path)?.[1] ?? [])))
}

/** Runs in the browser: the message's text is a side question about this chat, answered beside it and never added to it. */
export const btwCommand: Command = {
  id: 'btw',
  label: '顺便问',
  hint: '就当前对话快速问一句；回答不进对话、不影响后续，也不用工具',
  prompt: '',
  client: true,
}

/**
 * Commands offered in a composer: built-ins whose plugin is on (side questions and compaction only in an existing chat), the enabled
 * skills, then the chat's own skills (which win on a name clash).
 */
export function availableCommands(enabledPlugins: string[], skills: SkillInfo[], local: string[] = [], inChat = false): Command[] {
  return [
    ...builtinCommands.filter((c) => !c.plugin || enabledPlugins.includes(c.plugin)),
    ...(inChat ? [btwCommand, compactCommand] : []),
    ...skills.filter((s) => s.enabled && (!s.plugin || enabledPlugins.includes(s.plugin)) && !local.includes(s.name)).map(skillCommand),
    ...local.map((name) => skillCommand({ name, description: '本会话的 Skill' })),
  ]
}

export const toOutgoingCommand = (c: Command): NonNullable<Outgoing['command']> => ({ id: c.id, label: c.label, prompt: c.prompt })
