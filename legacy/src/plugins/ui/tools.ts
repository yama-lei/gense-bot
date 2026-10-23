import type { PluginTool } from '../types'
import type { UiInput } from './schema'

// Mock half of the generative UI plugin: the input is the UI, the view renders it.
export const uiTools: PluginTool[] = [
  {
    name: 'ui_render',
    plugin: 'ui',
    description: '在回答中插入卡片、表格或图表',
    resourceUri: 'ui://ui/render',
    sideEffect: false,
    execute: (input: UiInput) => ({ content: `已在界面中显示${input.title ? `「${input.title}」` : '内容'}`, structuredContent: input }),
  },
]
