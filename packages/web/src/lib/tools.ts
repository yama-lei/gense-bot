// Which plugin a tool belongs to and what its calls render with, from the server's plugin list.
import type { PluginInfo } from '@gense/protocol'

export interface ToolMeta {
  name: string
  title: string
  pluginId: string
  pluginName: string
  pluginKind: PluginInfo['kind']
  resourceUri?: string
  viewOnly?: boolean
}

export type ToolIndex = ReadonlyMap<string, ToolMeta>

export function toolIndex(plugins: PluginInfo[] | null): ToolIndex {
  const index = new Map<string, ToolMeta>()
  for (const p of plugins ?? [])
    for (const t of p.tools)
      index.set(t.name, {
        name: t.name,
        title: t.title || t.name,
        pluginId: p.id,
        pluginName: p.name,
        pluginKind: p.kind,
        ...(t.resourceUri && { resourceUri: t.resourceUri }),
        ...(t.viewOnly && { viewOnly: true }),
      })
  return index
}
