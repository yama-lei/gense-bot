// The Discover catalog (roadmap-6 B3): one data file for what the plugins page offers to add. Built-in plugins come
// from the catalog; MCP presets and featured Skills are listed here. Swapping in the MCP Registry replaces this file.
import type { DiscoverItem } from '@gense/protocol'
import { pluginCatalog } from './catalog.ts'

/** A rounded colored tile with a 24-unit stroke glyph, the size of a lucide icon. */
const tile = (color: string, glyph: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="${color}"/><g transform="translate(8 8)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</g></svg>`

const glyph = {
  document: '<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5M9 13h7M9 17h5"/>',
  mail: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  terminal: '<path d="m5 7 5 5-5 5M12 17h7"/>',
  book: '<path d="M2 4h7a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H2zM22 4h-7a3 3 0 0 0-3 3v14a2 2 0 0 1 2-2h8z"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  slides: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4M8 21h8M7 13l3-3 2 2 4-4"/>',
  wand: '<path d="m15 4 5 5L9 20l-5-5zM12 7l5 5M4 4v4M2 6h4M19 15v4M17 17h4"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/><path d="M12 21a3 3 0 0 1 0-6h2"/>',
}

const builtinIcons: Record<string, string> = {
  artifact: tile('#6D5BD0', glyph.document),
  email: tile('#2F7DD1', glyph.mail),
  ui: tile('#C2410C', glyph.layout),
  web: tile('#0E8A6A', glyph.globe),
  image: tile('#B4237A', glyph.image),
  sandbox: tile('#3F3F46', glyph.terminal),
}

const ANTHROPIC_SKILLS = 'https://github.com/anthropics/skills'

export const discoverCatalog: DiscoverItem[] = [
  {
    kind: 'mcp',
    id: 'alphaxiv',
    name: 'alphaXiv',
    description: '搜索和阅读论文、分析 PDF、查看论文代码库和作者，管理你的论文库。首次使用时登录 alphaXiv 账号。',
    icon: tile('#B31B1B', glyph.book),
    by: 'alphaXiv',
    homepage: 'https://www.alphaxiv.org/docs/mcp',
    install: { mcp: 'https://api.alphaxiv.org/mcp/v1', oauth: true },
  },
  {
    kind: 'mcp',
    id: 'amap',
    name: '高德地图',
    description: '地点搜索、地理编码、路线规划（驾车、步行、公交、骑行）和天气查询。需要高德开放平台的 Web 服务 Key。',
    icon: tile('#1677FF', glyph.pin),
    by: '高德开放平台',
    homepage: 'https://lbs.amap.com/api/mcp-server/summary',
    install: {
      mcp: 'https://mcp.amap.com/mcp?key={key}',
      fields: [{ key: 'key', label: 'Web 服务 Key', help: '在高德开放平台控制台创建应用后获取。Key 会成为服务器地址的一部分。', placeholder: '32 位 Key' }],
    },
  },
  {
    kind: 'skill',
    id: 'pptx',
    name: 'pptx',
    description: '创建、编辑和分析 PowerPoint 演示文稿：版式、图表、演讲者备注。需要沙箱的完整镜像。',
    icon: tile('#D24726', glyph.slides),
    by: 'Anthropic',
    homepage: `${ANTHROPIC_SKILLS}/tree/main/skills/pptx`,
    install: { git: ANTHROPIC_SKILLS, path: 'skills/pptx' },
  },
  {
    kind: 'skill',
    id: 'skill-creator',
    name: 'skill-creator',
    description: '帮你写新的 Skill：梳理触发条件、组织说明和脚本，并评估效果。',
    icon: tile('#7C3AED', glyph.wand),
    by: 'Anthropic',
    homepage: `${ANTHROPIC_SKILLS}/tree/main/skills/skill-creator`,
    install: { git: ANTHROPIC_SKILLS, path: 'skills/skill-creator' },
  },
  {
    kind: 'skill',
    id: 'frontend-design',
    name: 'frontend-design',
    description: '做有设计感的网页和前端界面，避免千篇一律的模板风格。',
    icon: tile('#0891B2', glyph.palette),
    by: 'Anthropic',
    homepage: `${ANTHROPIC_SKILLS}/tree/main/skills/frontend-design`,
    install: { git: ANTHROPIC_SKILLS, path: 'skills/frontend-design' },
  },
  ...pluginCatalog.map((p): DiscoverItem => ({ kind: 'builtin', id: p.id, name: p.name, description: p.description, icon: builtinIcons[p.id], by: 'Gense' })),
]
