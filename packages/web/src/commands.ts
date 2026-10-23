import type { Outgoing, SkillInfo, WorkspaceFile } from './types'

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

export const skillCommand = (s: Pick<SkillInfo, 'name' | 'description'>): Command => ({
  id: `skill:${s.name}`,
  label: s.name,
  hint: s.description,
  prompt: `用户要求使用 Skill「${s.name}」：先用 read 读取它的 SKILL.md（路径见系统提示里的 Skill 列表），再按其中的说明完成任务。`,
})

/** A chat's own skills: folders of skills/ in its workspace holding a SKILL.md (roadmap-3 R33: R29). */
export function localSkillNames(files: WorkspaceFile[] = []): string[] {
  return files.flatMap((f) => (f.readOnly ? [] : (/^\/data\/sessions\/[^/]+\/skills\/([^/]+)\/SKILL\.md$/.exec(f.path)?.[1] ?? [])))
}

/** Commands offered in a composer: built-ins whose plugin is on, the enabled skills, then the chat's own skills (which win on a name clash). */
export function availableCommands(enabledPlugins: string[], skills: SkillInfo[], local: string[] = []): Command[] {
  return [
    ...builtinCommands.filter((c) => !c.plugin || enabledPlugins.includes(c.plugin)),
    ...skills.filter((s) => s.enabled && !local.includes(s.name)).map(skillCommand),
    ...local.map((name) => skillCommand({ name, description: '本会话的 Skill' })),
  ]
}

export const toOutgoingCommand = (c: Command): NonNullable<Outgoing['command']> => ({ id: c.id, label: c.label, prompt: c.prompt })
