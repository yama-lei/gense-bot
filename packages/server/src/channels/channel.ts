import type { ChannelInfo, PluginSetting, PluginValue, TriggerInfo } from '@gense/protocol'

export interface InboundTrigger extends Omit<TriggerInfo, 'decision' | 'createdAt'> {
  createdAt?: number
  attachments?: string[]
  destination?: Record<string, unknown>
  context?: string
}
export interface OutboxItem {
  id: string
  channelId: string
  triggerId: string
  treeId?: string
  kind: 'message' | 'file'
  payload: Record<string, unknown>
}
export interface Channel {
  start(ingest: (trigger: InboundTrigger) => Promise<unknown>): Promise<void>
  stop(): Promise<void>
  deliver(item: OutboxItem): Promise<string>
  render?(triggerId: string, treeId: string, text: string): Promise<void>
}
export interface ChannelDefinition {
  id: string
  name: string
  description: string
  settings: PluginSetting[]
  create(config: Record<string, PluginValue>, state: (patch: Partial<Pick<ChannelInfo, 'status' | 'error' | 'bot'>>) => void): Channel
}
