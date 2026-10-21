import { builtinSkills } from '../../skills'
import type { PluginTool } from '../types'

// Mock half of the always-on tools: skills and reading another chat.

export const coreTools: PluginTool[] = [
  {
    name: 'skill_activate',
    plugin: 'core',
    description: '激活 Skill',
    sideEffect: false,
    execute: ({ name }: { name: string }) => {
      const skill = builtinSkills.find((s) => s.name === name)
      return skill ? { content: skill.body } : { content: `没有名为「${name}」的 Skill`, isError: true }
    },
  },
  {
    name: 'chats_read',
    plugin: 'core',
    description: '读取另一个会话',
    sideEffect: false,
    execute: ({ id }: { id: string }, ctx) => {
      const c = ctx.conversations.find((x) => x.id === id)
      if (!c) return { content: '会话不存在', isError: true }
      return { content: `会话「${c.title}」：\n\n${c.turns.map((t) => `用户：${t.userMessage}\n助手：${t.assistantMessage}`).join('\n\n')}` }
    },
  },
]
