import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ToolResult } from '../src/types'

// Server half of the plugins (architecture "插件与界面"). Each execute() returns an MCP-style
// CallToolResult: `content` goes to the model, `structuredContent` only to the view.
// Tool names use `_` because both model APIs reject `.` in tool names.

const toModelOutput = ({ output }: { output: ToolResult }) =>
  output.isError ? { type: 'error-text' as const, value: output.content } : { type: 'text' as const, value: output.content }

const artifactInput = z.object({
  title: z.string().describe('产物标题'),
  type: z.enum(['markdown', 'code']),
  language: z.string().optional().describe('type 为 code 时的语言'),
  content: z.string().describe('完整内容'),
})

export const pluginTools = {
  artifact: {
    artifact_create: tool({
      description: '在会话中展示一个产物（提纲、报告、代码等），用户可以预览并保存到 Drive。只用于展示，不会保存。',
      inputSchema: artifactInput,
      execute: async (input): Promise<ToolResult> => ({ content: `已展示 Artifact「${input.title}」（未保存）`, structuredContent: input }),
      toModelOutput,
    }),
  },
} satisfies Record<string, ToolSet>

export type PluginId = keyof typeof pluginTools

/** Tools of the enabled plugins (Spec S8: a disabled plugin's tools are never offered). */
export function enabledTools(enabled: string[]): ToolSet {
  const out: ToolSet = {}
  for (const [id, set] of Object.entries(pluginTools)) if (enabled.includes(id)) Object.assign(out, set)
  return out
}
