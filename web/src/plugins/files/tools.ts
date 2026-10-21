import type { DriveFile } from '../../types'
import type { PluginTool } from '../types'

const summary = (f: DriveFile) => ({ id: f.id, name: f.name, kind: f.kind, size: new Blob([f.content]).size, modifiedTime: f.modifiedTime })

export const filesTools: PluginTool[] = [
  {
    name: 'files.list',
    plugin: 'files',
    description: '列出资料与 Artifacts',
    sideEffect: false,
    execute: (_input: { kind?: DriveFile['kind'] }, { files }) => {
      const list = files.map(summary)
      return { content: `${list.length} 个文件`, structuredContent: { files: list } }
    },
  },
  {
    name: 'files.search',
    plugin: 'files',
    description: '按名称搜索文件',
    sideEffect: false,
    execute: ({ query }: { query: string }, { files }) => {
      const list = files.filter((f) => f.name.includes(query)).map(summary)
      return { content: `匹配 ${list.length} 个文件`, structuredContent: { files: list } }
    },
  },
  {
    name: 'files.read',
    plugin: 'files',
    description: '按文件 ID 读取文本',
    sideEffect: false,
    execute: ({ fileId }: { fileId: string }, { files }) => {
      const f = files.find((x) => x.id === fileId)
      if (!f) return { content: `文件 ${fileId} 不存在或无权访问`, isError: true }
      return { content: `读取 ${f.name}，${f.content.length} 字`, structuredContent: { id: f.id, name: f.name, text: f.content } }
    },
  },
]
