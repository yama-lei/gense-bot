import { uid } from '../../util'
import type { PluginTool } from '../types'

export interface ArtifactInput {
  title: string
  type: 'markdown' | 'code'
  language?: string
  content: string
}

export const artifactTools: PluginTool[] = [
  {
    name: 'artifact.create',
    plugin: 'artifact',
    description: '在会话中展示一个产物（显示工具）',
    resourceUri: 'ui://artifact/view',
    sideEffect: false,
    execute: (input: ArtifactInput) => ({ content: `已创建 Artifact「${input.title}」（未保存）`, structuredContent: input }),
  },
  {
    name: 'artifact.save',
    plugin: 'artifact',
    description: '把产物保存为 GenseBot/Artifacts/ 下的新文件，不覆盖已有文件',
    sideEffect: false,
    execute: (input: ArtifactInput, { addFile }) => {
      const ext = input.type === 'code' ? (input.language ?? 'txt') : 'md'
      const file = { id: 'f-' + uid(), name: `${input.title}.${ext}`, kind: 'artifact' as const, mimeType: 'text/plain', content: input.content, modifiedTime: Date.now() }
      addFile(file)
      return { content: `已保存到 GenseBot/Artifacts/${file.name}`, structuredContent: { fileId: file.id, name: file.name } }
    },
  },
]
