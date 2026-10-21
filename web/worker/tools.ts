import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { Citation, DriveFile, ToolResult } from '../src/types'
import { findQuote } from '../src/util'
import type { Drive, Folders } from './drive'

// Server half of the plugins (architecture "插件与界面"). Each execute() returns an MCP-style
// CallToolResult: `content` goes to the model, `structuredContent` only to the view.
// Tool names use `_` because both model APIs reject `.` in tool names.

/** What tools need from the chat running them. */
export interface ToolHost {
  /** Throws when Google Drive is not connected. */
  drive(): Promise<{ drive: Drive; folders: Folders }>
  /** Tells the hub to refresh its file list after a write. */
  filesChanged(): void
  /** Texts read in this chat instance, so citations can be checked without another download. */
  readCache: Map<string, { name: string; text: string }>
}

/** Characters per `files_read` call; longer files are read in parts. */
const READ_CHUNK = 20_000
const QUOTE_MAX = 200

const toModelOutput = ({ output }: { output: ToolResult }) =>
  output.isError ? { type: 'error-text' as const, value: output.content } : { type: 'text' as const, value: output.content }

/** Tool failures become results the model can read and explain, not turn failures. */
const guarded =
  <I, O>(fn: (input: I, opts: O) => Promise<ToolResult>) =>
  async (input: I, opts: O): Promise<ToolResult> => {
    try {
      return await fn(input, opts)
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true }
    }
  }

const describe = (f: DriveFile) => `- ${f.name}（id: ${f.id}，${f.mimeType}${f.size != null ? `，${f.size} 字节` : ''}，修改于 ${new Date(f.modifiedTime).toISOString().slice(0, 10)}）`

export const artifactInput = z.object({
  title: z.string().min(1).max(120).describe('产物标题，也用作保存时的文件名'),
  type: z.enum(['markdown', 'code']),
  language: z.string().max(32).optional().describe('type 为 code 时的语言，例如 python'),
  content: z.string().describe('完整内容'),
})
export type ArtifactInput = z.infer<typeof artifactInput>

/** Saves an artifact as a new file; retrying with the same key returns the first file (Spec S5). */
export async function saveArtifact(host: ToolHost, input: ArtifactInput, key: string): Promise<ToolResult> {
  const { drive, folders } = await host.drive()
  const existing = await drive.findByKey(folders.artifacts, key)
  if (existing) return { content: `已保存过：GenseBot/Artifacts/${existing.name}`, structuredContent: { fileId: existing.id, name: existing.name } }
  const ext = input.type === 'code' ? extension(input.language) : 'md'
  const base = input.title.replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim() || 'Artifact'
  const name = await drive.freeName(folders.artifacts, `${base}.${ext}`)
  const file = await drive.create(folders, folders.artifacts, name, input.content, { idempotencyKey: key })
  host.filesChanged()
  return { content: `已保存到 GenseBot/Artifacts/${file.name}`, structuredContent: { fileId: file.id, name: file.name } }
}

function extension(language = '') {
  const map: Record<string, string> = { python: 'py', javascript: 'js', typescript: 'ts', bash: 'sh', shell: 'sh', markdown: 'md', rust: 'rs', golang: 'go' }
  const l = language.toLowerCase()
  return map[l] ?? (/^[a-z0-9]{1,8}$/.test(l) ? l : 'txt')
}

export function createTools(host: ToolHost) {
  const read = async (fileId: string) => {
    const { drive, folders } = await host.drive()
    const { file, text } = await drive.readText(fileId, folders)
    host.readCache.set(file.id, { name: file.name, text })
    return { file, text }
  }

  return {
    files: {
      files_list: tool({
        description: '列出 GenseBot/资料/（用户上传的资料）和 GenseBot/Artifacts/（已保存的产物）中的文件。',
        inputSchema: z.object({ kind: z.enum(['source', 'artifact']).optional().describe('只列资料（source）或只列 Artifacts（artifact）；不填则都列') }),
        execute: guarded(async ({ kind }) => {
          const { drive, folders } = await host.drive()
          const [sources, artifacts] = await Promise.all([
            kind === 'artifact' ? [] : drive.list(folders.sources, 'source'),
            kind === 'source' ? [] : drive.list(folders.artifacts, 'artifact'),
          ])
          const section = (title: string, files: DriveFile[]) => `${title}（${files.length}）\n${files.map(describe).join('\n') || '（空）'}`
          const parts = [kind !== 'artifact' && section('资料', sources), kind !== 'source' && section('Artifacts', artifacts)].filter(Boolean)
          return { content: parts.join('\n\n'), structuredContent: { files: [...sources, ...artifacts] } }
        }),
        toModelOutput,
      }),
      files_search: tool({
        description: '在用户的整个 Google Drive 中按文件名和全文搜索，返回文件 ID。',
        inputSchema: z.object({ query: z.string().min(1).max(200).describe('关键词') }),
        execute: guarded(async ({ query }) => {
          const { drive, folders } = await host.drive()
          const files = await drive.search(query, folders)
          return { content: files.length ? `找到 ${files.length} 个文件：\n${files.map(describe).join('\n')}` : `没有找到包含「${query}」的文件`, structuredContent: { files } }
        }),
        toModelOutput,
      }),
      files_read: tool({
        description: `按文件 ID 读取文本（Google 文档导出为 Markdown）。每次最多返回 ${READ_CHUNK} 字，较长的文件用 offset 继续读。`,
        inputSchema: z.object({ fileId: z.string().min(1), offset: z.number().int().min(0).optional().describe('从第几个字符开始，默认 0') }),
        execute: guarded(async ({ fileId, offset = 0 }) => {
          const { file, text } = await read(fileId)
          const part = text.slice(offset, offset + READ_CHUNK)
          const end = offset + part.length
          const more = end < text.length ? `\n\n[第 ${offset}–${end} 字，共 ${text.length} 字；用 offset=${end} 继续读]` : ''
          return {
            content: `文件：${file.name}（id: ${file.id}）\n\n${part}${more}`,
            structuredContent: { file, offset, end, total: text.length },
          }
        }),
        toModelOutput,
      }),
      files_cite: tool({
        description: `回答用到了文件内容时，最后调用一次，记录引用。quote 必须是原文中连续的一段，逐字摘录，不超过 ${QUOTE_MAX} 字；找不到原文的引用会被丢弃。`,
        inputSchema: z.object({
          citations: z
            .array(z.object({ fileId: z.string().min(1), quote: z.string().min(1).max(QUOTE_MAX * 2) }))
            .min(1)
            .max(8),
        }),
        execute: guarded(async ({ citations }) => {
          const kept: Citation[] = []
          let dropped = 0
          for (const c of citations) {
            const quote = c.quote.trim().slice(0, QUOTE_MAX)
            const source = host.readCache.get(c.fileId) ?? (await read(c.fileId).then(({ file, text }) => ({ name: file.name, text })).catch(() => null))
            // Architecture "引用": a quote the source does not contain is dropped, so the model cannot invent one.
            if (source && findQuote(source.text, quote)) kept.push({ fileId: c.fileId, name: source.name, quote })
            else dropped++
          }
          const note = dropped ? `，丢弃 ${dropped} 条（原文中找不到，请逐字摘录）` : ''
          return { content: `已记录 ${kept.length} 条引用${note}`, structuredContent: { citations: kept } }
        }),
        toModelOutput,
      }),
    },
    artifact: {
      artifact_create: tool({
        description: '在会话中展示一个产物（提纲、报告、代码等），用户可以预览并保存到 Drive。只用于展示，不会保存。',
        inputSchema: artifactInput,
        execute: async (input): Promise<ToolResult> => ({ content: `已展示 Artifact「${input.title}」（未保存）`, structuredContent: input }),
        toModelOutput,
      }),
      artifact_save: tool({
        description: '把产物另存为 GenseBot/Artifacts/ 下的新文件。不会覆盖已有文件。只在用户要求保存时调用。',
        inputSchema: artifactInput,
        execute: guarded(async (input, { toolCallId }) => saveArtifact(host, input, toolCallId)),
        toModelOutput,
      }),
    },
  } satisfies Record<string, ToolSet>
}

export type PluginId = keyof ReturnType<typeof createTools>
/** Plugins this server implements; the hub offers only these. */
export const pluginIds: PluginId[] = ['files', 'artifact']
/** Plugin of each tool, for checking calls made by views. */
export const toolPlugin = (all: ReturnType<typeof createTools>, name: string) => (Object.entries(all) as [PluginId, ToolSet][]).find(([, set]) => name in set)?.[0]

/** Tools of the enabled plugins (Spec S8: a disabled plugin's tools are never offered). */
export function enabledTools(all: ReturnType<typeof createTools>, enabled: string[]): ToolSet {
  const out: ToolSet = {}
  for (const [id, set] of Object.entries(all)) if (enabled.includes(id)) Object.assign(out, set)
  return out
}
