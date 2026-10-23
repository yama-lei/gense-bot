import type { WebSource } from '../../types'
import type { PluginTool } from '../types'

// Mock half of the web plugin: canned pages, so the demo shows search, fetch and sources offline.
const PAGES: (WebSource & { summary: string })[] = [
  { url: 'https://developers.cloudflare.com/agents/', title: 'Agents · Cloudflare Agents docs', site: 'developers.cloudflare.com', summary: 'Agents SDK 让你在 Durable Objects 上构建有状态的 AI 智能体，内置 WebSocket、调度与持久化。' },
  { url: 'https://blog.cloudflare.com/project-think/', title: 'Project Think: building the next generation of AI agents', site: 'blog.cloudflare.com', summary: 'Think 是构建在 Agents SDK 之上的智能体运行时：消息树、断线恢复、Skills 与工作区工具。' },
  { url: 'https://api-docs.deepseek.com/guides/search/', title: 'Search & Fetch | DeepSeek API Docs', site: 'api-docs.deepseek.com', summary: 'DeepSeek 提供独立的搜索与网页读取接口，返回带摘要、日期和权威度的结果。' },
]

export const webTools: PluginTool[] = [
  {
    name: 'web_search',
    plugin: 'web',
    description: '搜索公开网页',
    sideEffect: false,
    execute: ({ query }: { query: string }) => ({
      content: PAGES.map((p, i) => `[${i + 1}] ${p.title}\n${p.url}\n${p.summary}`).join('\n\n') + `\n\n（Mock：「${query}」的固定结果）`,
      structuredContent: { sources: PAGES.map(({ url, title, site }) => ({ url, title, site })) },
    }),
  },
  {
    name: 'web_fetch',
    plugin: 'web',
    description: '读取网页正文',
    sideEffect: false,
    execute: ({ url }: { url: string }) => {
      const page = PAGES.find((p) => p.url === url) ?? PAGES[0]
      return { content: `网页：${page.title}\n${page.url}\n\n${page.summary}`, structuredContent: { sources: [{ url: page.url, title: page.title, site: page.site }] } }
    },
  },
]
