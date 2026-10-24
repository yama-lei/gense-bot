// Plugin declarations (roadmap-3 D8): names, descriptions and settings, shared by the hosts, which validate and resolve
// settings, and the customize page, which renders them. Pure data and functions: the web client imports it too.

export type PluginValue = string | boolean

/** One plugin setting; values are checked against it on the host. */
export interface PluginSetting {
  key: string
  label: string
  help?: string
  /** `secret` values are encrypted on the host and never sent back. */
  kind: 'text' | 'url' | 'secret' | 'select' | 'toggle'
  options?: { value: string; label: string }[]
  default?: PluginValue
  placeholder?: string
}

export interface PluginEntry {
  id: string
  name: string
  description: string
  /** Its tools change things outside the conversation. */
  sideEffect: boolean
  settings: PluginSetting[]
  /** On until the user switches it off. */
  defaultEnabled?: boolean
  /** Only self-hosted deployments implement it. */
  selfHosted?: boolean
}

/** A plugin's settings as the host sends them; secrets appear only as `secretsSet`. */
export interface PluginSettingsState {
  /** Values the user set; others fall back to the host's, then to the declared default. */
  values: Record<string, PluginValue>
  secretsSet: string[]
  /** Keys the host configures (`.env`), used when the user sets none. */
  serverKeys: string[]
}

/** A plugin as the host reports it to the customize page. */
export interface PluginState {
  id: string
  enabled: boolean
  /** This host implements it. */
  available: boolean
  config: PluginSettingsState
  /** Why it offers no tools with its current settings; null when it does. */
  issue: string | null
}

/** Every plugin the customize page lists. */
export const pluginCatalog: PluginEntry[] = [
  {
    id: 'artifact',
    name: 'Artifact',
    description: '在会话中展示文档、网页、代码等产物，并保存到会话工作区。',
    sideEffect: false,
    settings: [],
  },
  { id: 'email', name: '邮件', description: '起草邮件，由你检查后复制或在邮箱 App 中发送。', sideEffect: false, settings: [] },
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
    ],
  },
  {
    id: 'image',
    name: '图片',
    description: '按描述生成图片，显示在会话中，并保存到会话工作区。',
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
    ],
  },
  {
    id: 'sandbox',
    name: '代码沙箱',
    description: '在你自己的隔离容器里运行命令和代码（Python、Node、git 等），可以联网安装依赖，产生的文件保存在会话工作区。只在自部署上可用。',
    sideEffect: true,
    defaultEnabled: true,
    selfHosted: true,
    settings: [
      {
        key: 'image',
        label: '镜像',
        help: '切换后下次启动沙箱时生效',
        kind: 'select',
        options: [
          { value: 'slim', label: '精简：Python、Node、git、uv 和常用命令行工具' },
          { value: 'full', label: '完整：另有常用 Python 包、编译工具链、ffmpeg、pandoc' },
        ],
        default: 'slim',
      },
    ],
  },
  {
    id: 'drive',
    name: 'Google Drive',
    description: '连接 Google Drive：附件和 @ 可以选 Drive 文件，Skills 可以来自 Drive，助手可以搜索和读取 Drive。只读。',
    sideEffect: false,
    settings: [],
  },
  { id: 'mcp', name: 'MCP 服务器', description: '接入外部 MCP 工具及其界面（MCP Apps）。已预留接口。', sideEffect: true, settings: [] },
]

export const pluginSettings = (id: string): PluginSetting[] => pluginCatalog.find((p) => p.id === id)?.settings ?? []

/** Settings with the user's values over the host's over the declared defaults. */
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
  if (s.kind === 'url' && value) return /^https?:\/\/[^\s]+$/.test(value)
  return true
}

const str = (v: PluginValue | undefined) => (typeof v === 'string' ? v : '')

/** Why a plugin offers no tools with these resolved settings; null when it is ready. */
export function pluginIssue(id: string, config: Record<string, PluginValue>): string | null {
  if (id === 'web') return str(config.deepseekKey) ? null : '需要填写 DeepSeek API Key'
  if (id === 'image') {
    const missing = [!str(config.baseUrl) && '端点地址', !str(config.apiKey) && 'API Key', !str(config.model) && '模型'].filter(Boolean)
    return missing.length ? `需要填写${missing.join('、')}` : null
  }
  return null
}
