import type { PluginTool } from '../types'

// Mock half of the always-on tools: Think's workspace file tools (the server gets them from
// @cloudflare/computer) and reading another chat.

export const coreTools: PluginTool[] = [
  {
    name: 'read',
    plugin: 'core',
    description: '读取工作区文件',
    sideEffect: false,
    execute: ({ path }: { path: string }, ctx) => {
      const text = ctx.workspace.read(path)
      return text == null ? { content: `ENOENT: ${path}`, isError: true } : { content: text }
    },
  },
  {
    name: 'write',
    plugin: 'core',
    description: '写入工作区文件',
    sideEffect: true,
    execute: ({ path, content }: { path: string; content: string }, ctx) => {
      if (path.startsWith('/skills/')) return { content: `EROFS: ${path} 是只读的`, isError: true }
      ctx.workspace.write(path, content)
      return { content: `Wrote ${content.length} characters to ${path}` }
    },
  },
  {
    name: 'ls',
    plugin: 'core',
    description: '列出工作区目录',
    sideEffect: false,
    execute: ({ path }: { path: string }, ctx) => ({
      content: ctx.workspace
        .list()
        .filter((f) => f.path.startsWith(path.replace(/\/?$/, '/')))
        .map((f) => `${f.path}  ${f.size} B`)
        .join('\n'),
    }),
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
