// The Discover catalog (roadmap-6 B3): plugins and Skills the owner can add with one click. Pure types and functions;
// the server keeps the data, so it can later come from the MCP Registry instead.

/** A value the owner fills in before an MCP preset is added, such as an API key in the address. */
export interface DiscoverField {
  key: string
  label: string
  help?: string
  placeholder?: string
}

/** How an entry is added: an MCP address template with `{key}` fields, or a Git folder of Skills. */
export type DiscoverInstall = { mcp: string; fields?: DiscoverField[]; oauth?: boolean } | { git: string; ref?: string; path?: string }

export interface DiscoverItem {
  kind: 'mcp' | 'skill' | 'builtin'
  /** The plugin id for `builtin`, the Skill's name for `skill`, a stable slug for `mcp`. */
  id: string
  name: string
  description: string
  /** An SVG document; entries without one show the name's initial. */
  icon?: string
  /** Who makes it. */
  by: string
  homepage?: string
  /** Absent for `builtin`: built-in plugins are always installed and only switched on. */
  install?: DiscoverInstall
}

/** The address with each `{key}` replaced by its URL-encoded value. */
export function fillTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(values[k] ?? ''))
}

/** Whether `url` was made from `template`: everything before the first field matches (exactly, when it has none). */
export function fromTemplate(url: string, template: string) {
  const at = template.indexOf('{')
  const strip = (s: string) => s.replace(/\/+$/, '')
  return at < 0 ? strip(url) === strip(template) : url.startsWith(template.slice(0, at))
}
