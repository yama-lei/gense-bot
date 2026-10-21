import type { PluginInfo } from '../types'

/** Every plugin the customize page lists; which are available depends on the backend (mock or server). */
export const pluginCatalog: Omit<PluginInfo, 'enabled' | 'available'>[] = [
  { id: 'files', name: '资料', description: '列出、搜索、读取 Drive 中的资料和 Artifacts。只读。', sideEffect: false },
  { id: 'artifact', name: 'Artifact', description: '在会话中展示产物，并另存到 GenseBot/Artifacts/。不会覆盖已有文件。', sideEffect: false },
  { id: 'email', name: '邮件', description: '起草 smail 邮件并写入草稿箱，由你在邮箱 App 中发送。', sideEffect: true },
  { id: 'web_search', name: '网页搜索', description: '检索公开网页。', sideEffect: false },
  { id: 'mcp', name: 'MCP 服务器', description: '接入外部 MCP 工具及其界面（MCP Apps）。已预留接口。', sideEffect: true },
]
