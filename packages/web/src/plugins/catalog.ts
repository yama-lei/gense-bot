import type { PluginInfo, PluginSetting, PluginValue } from '../types'

export type PluginEntry = Omit<PluginInfo, 'enabled' | 'available' | 'config' | 'issue'>

/** Every plugin the customize page lists, with its settings; which are available the host decides. */
export const pluginCatalog: PluginEntry[] = [
  {
    id: 'files',
    name: '资料',
    description: '列出、搜索、读取你 Google Drive 中的文件，并在回答中引用原文。只读。',
    sideEffect: false,
    settings: [
      {
        key: 'searchScope',
        label: '搜索范围',
        kind: 'select',
        options: [
          { value: 'drive', label: '整个 Drive' },
          { value: 'gensebot', label: '只搜 GenseBot 的资料和 Artifacts' },
        ],
        default: 'drive',
      },
    ],
  },
  {
    id: 'artifact',
    name: 'Artifact',
    description: '在会话中展示产物，并另存到 GenseBot/Artifacts/。不会覆盖已有文件。',
    sideEffect: false,
    settings: [{ key: 'autoSave', label: '自动保存', help: '展示的同时存到 Drive；关闭时只在你要求时保存', kind: 'toggle', default: false }],
  },
  { id: 'email', name: '邮件', description: '起草 smail 邮件并写入草稿箱，由你在邮箱 App 中发送。', sideEffect: true, settings: [] },
  {
    id: 'ui',
    name: '界面',
    description: '用卡片、表格和图表展示回答，界面中的按钮可以继续对话。',
    sideEffect: false,
    settings: [
      {
        key: 'usage',
        label: '使用倾向',
        kind: 'select',
        options: [
          { value: 'auto', label: '需要时使用' },
          { value: 'often', label: '尽量使用' },
        ],
        default: 'auto',
      },
    ],
  },
  {
    id: 'web',
    name: '网页',
    description: '搜索公开网页、读取网页正文，复杂问题可以深度搜索。回答附来源链接。',
    sideEffect: false,
    settings: [
      { key: 'deepseekKey', label: 'DeepSeek API Key', help: '用于搜索和读取网页', kind: 'secret' },
      {
        key: 'searchCount',
        label: '每次搜索结果数',
        kind: 'select',
        options: ['5', '8', '12', '20'].map((v) => ({ value: v, label: v })),
        default: '8',
      },
      { key: 'researchModel', label: '深度搜索模型', help: 'OpenAI 端点上支持网页搜索的模型；留空则不提供深度搜索', kind: 'model' },
    ],
  },
  {
    id: 'image',
    name: '图片',
    description: '按描述生成图片，显示在会话中，可下载或存到 Drive。',
    sideEffect: false,
    settings: [
      { key: 'baseUrl', label: '端点地址', help: 'OpenAI 兼容的 Images API', kind: 'url', placeholder: 'https://api.openai.com/v1' },
      { key: 'apiKey', label: 'API Key', kind: 'secret' },
      { key: 'model', label: '模型', kind: 'text', default: 'gpt-image-2' },
      {
        key: 'size',
        label: '默认尺寸',
        kind: 'select',
        options: [
          { value: 'auto', label: '自动' },
          { value: '1024x1024', label: '方形 1024×1024' },
          { value: '1536x1024', label: '横向 1536×1024' },
          { value: '1024x1536', label: '纵向 1024×1536' },
        ],
        default: 'auto',
      },
      {
        key: 'quality',
        label: '质量',
        help: '越高越慢',
        kind: 'select',
        options: [
          { value: 'auto', label: '自动' },
          { value: 'low', label: '低' },
          { value: 'medium', label: '中' },
          { value: 'high', label: '高' },
        ],
        default: 'auto',
      },
      { key: 'saveToDrive', label: '保存到 Drive', help: '连接 Drive 时另存到 GenseBot/Artifacts/', kind: 'toggle', default: true },
    ],
  },
  { id: 'mcp', name: 'MCP 服务器', description: '接入外部 MCP 工具及其界面（MCP Apps）。已预留接口。', sideEffect: true, settings: [] },
]

export const pluginSettings = (id: string): PluginSetting[] => pluginCatalog.find((p) => p.id === id)?.settings ?? []

/** Settings with the user's values over the server's over the declared defaults. */
export function resolveSettings(id: string, user: Record<string, PluginValue>, server: Record<string, PluginValue | undefined> = {}): Record<string, PluginValue> {
  const out: Record<string, PluginValue> = {}
  for (const s of pluginSettings(id)) {
    const v = user[s.key] ?? server[s.key] ?? s.default
    if (v !== undefined && v !== '') out[s.key] = v
  }
  return out
}

/** Whether `value` fits setting `s`; a select only takes one of its options. */
export function validSetting(s: PluginSetting, value: unknown): value is PluginValue {
  if (s.kind === 'toggle') return typeof value === 'boolean'
  if (typeof value !== 'string' || value.length > 2000) return false
  if (s.kind === 'select') return !!s.options?.some((o) => o.value === value)
  if (s.kind === 'url' && value) return /^https:\/\/[^\s]+$/.test(value)
  return true
}

const str = (v: PluginValue | undefined) => (typeof v === 'string' ? v : '')

/**
 * Tools a plugin can offer with these resolved settings, or why it offers none; plugins without
 * a `tools` list offer all of theirs. `openai` says whether the server has an OpenAI endpoint.
 */
export function pluginReadiness(id: string, config: Record<string, PluginValue>, openai: boolean): { tools?: string[]; issue: string | null } {
  if (id === 'web') {
    const tools = [...(str(config.deepseekKey) ? ['web_search', 'web_fetch'] : []), ...(str(config.researchModel) && openai ? ['web_research'] : [])]
    return { tools, issue: tools.length ? null : '需要填写 DeepSeek API Key 或深度搜索模型' }
  }
  if (id === 'image') {
    const missing = [!str(config.baseUrl) && '端点地址', !str(config.apiKey) && 'API Key', !str(config.model) && '模型'].filter(Boolean)
    return { tools: missing.length ? [] : ['image_generate'], issue: missing.length ? `需要填写${missing.join('、')}` : null }
  }
  return { issue: null }
}
