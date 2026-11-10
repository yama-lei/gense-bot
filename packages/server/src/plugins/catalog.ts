import type { PluginSetting, PluginValue } from '@gense/protocol'
import artifact from './builtin/artifact/index.ts'
import email from './builtin/email/index.ts'
import ui from './builtin/ui/index.ts'
import web from './builtin/web/index.ts'
import image from './builtin/image/index.ts'
import sandbox from './builtin/sandbox/index.ts'
export { validSetting } from '@gense/protocol'
export type { PluginInfo, PluginSetting, PluginSettingsState, PluginValue } from '@gense/protocol'
export type { PluginDefinition as PluginEntry } from './registry.ts'

export const pluginCatalog = [artifact, email, ui, web, image, sandbox]
export const pluginSettings = (id: string): PluginSetting[] => pluginCatalog.find(p => p.id === id)?.settings ?? []
export function resolveSettings(id: string, user: Record<string, PluginValue>, server: Record<string, PluginValue | undefined> = {}): Record<string, PluginValue> {
  const out: Record<string, PluginValue> = {}
  for (const s of pluginSettings(id)) {
    const value = user[s.key] ?? server[s.key] ?? s.default
    if (value !== undefined && value !== '') out[s.key] = value
  }
  return out
}
