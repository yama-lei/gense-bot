// What the plugins page lists (roadmap-6 B1, B3, B5): installed plugins and Skills joined with the Discover catalog,
// so a preset that was added shows as installed, with its icon, and an installed one keeps the icon of its preset.
import { fromTemplate, type DiscoverItem, type PluginInfo, type SkillInfo } from '@gense/protocol'

export interface Entry {
  key: string
  kind: 'builtin' | 'mcp' | 'skill'
  name: string
  description: string
  by: string
  icon?: string
  plugin?: PluginInfo
  skill?: SkillInfo
  /** The Discover item it is, or was added from. */
  preset?: DiscoverItem
}

/** Added: a Skill or MCP server that exists, or a built-in plugin that is on. */
export const isAdded = (e: Entry) => !!e.skill || e.plugin?.kind === 'mcp' || !!e.plugin?.enabled

/** Hides secrets people put in an address, such as Amap's `?key=`. */
export const maskUrl = (url: string) => url.replace(/([?&](?:key|token|api_?key|access_token)=)[^&#]+/gi, '$1••••')

const skillBy: Record<SkillInfo['source'], string> = { builtin: '内置', upload: '上传', git: 'Git' }

function presetOf(catalog: DiscoverItem[], p: PluginInfo) {
  if (p.kind === 'builtin') return catalog.find((d) => d.kind === 'builtin' && d.id === p.id)
  return catalog.find((d) => d.kind === 'mcp' && d.install && 'mcp' in d.install && !!p.mcp && fromTemplate(p.mcp.url, d.install.mcp))
}

export function pluginEntry(p: PluginInfo, catalog: DiscoverItem[]): Entry {
  const preset = presetOf(catalog, p)
  const host = p.mcp ? hostOf(p.mcp.url) : ''
  return {
    key: `plugin:${p.id}`,
    kind: p.kind,
    name: p.name,
    description: p.description || (p.mcp ? maskUrl(p.mcp.url) : ''),
    by: preset?.by ?? (p.kind === 'builtin' ? 'Gense' : host),
    ...(preset?.icon && { icon: preset.icon }),
    plugin: p,
    ...(preset && { preset }),
  }
}

export function skillEntry(s: SkillInfo, catalog: DiscoverItem[]): Entry {
  const preset = catalog.find((d) => d.kind === 'skill' && d.id === s.name)
  return {
    key: `skill:${s.name}`,
    kind: 'skill',
    name: s.name,
    description: s.description,
    by: preset?.by ?? (s.plugin ? `随插件 ${s.plugin}` : skillBy[s.source]),
    ...(preset?.icon && { icon: preset.icon }),
    skill: s,
    ...(preset && { preset }),
  }
}

/** A Discover item, joined with what is installed from it. */
export function discoverEntry(d: DiscoverItem, plugins: PluginInfo[], skills: SkillInfo[]): Entry {
  const install = d.install
  const plugin =
    d.kind === 'builtin'
      ? plugins.find((p) => p.kind === 'builtin' && p.id === d.id)
      : install && 'mcp' in install
        ? plugins.find((p) => !!p.mcp && fromTemplate(p.mcp.url, install.mcp))
        : undefined
  const skill = d.kind === 'skill' ? skills.find((s) => s.name === d.id) : undefined
  return { key: `discover:${d.kind}:${d.id}`, kind: d.kind, name: d.name, description: d.description, by: d.by, ...(d.icon && { icon: d.icon }), preset: d, ...(plugin && { plugin }), ...(skill && { skill }) }
}

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Every word of the query appears in the name, description or maker; case-insensitive, any language. */
export function matches(e: Entry, query: string) {
  const text = `${e.name} ${e.description} ${e.by} ${e.plugin?.id ?? ''}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w))
}
