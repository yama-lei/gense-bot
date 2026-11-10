import type { Context } from '@earendil-works/chord/context'
import type { Extension } from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import type { PluginSetting, PluginValue, ToolCallResult } from '@gense/protocol'

export type PluginConfig = Record<string, PluginValue>
export interface ViewTool {
  description: string
  call(args: unknown, env: ExecutionEnv, ctx: Context): Promise<ToolCallResult>
}
export interface PluginDefinition {
  id: string
  name: string
  description: string
  sideEffect: boolean
  settings: PluginSetting[]
  defaultEnabled?: boolean
  needsSandbox?: boolean
  issue(config: PluginConfig): string | null
  extension(config: () => PluginConfig): Extension
  resources?: Record<string, string>
  viewTools?: Record<string, ViewTool>
}
export const definePlugin = (definition: PluginDefinition): PluginDefinition => definition
