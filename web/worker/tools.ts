import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { WorkerEnv } from './env'
import type { Citation, DriveFile, ToolResult } from '../src/types'
import { findQuote } from '../src/util'
import { isImage, toFile, type Drive, type Folders, type TextCache } from './drive'
import { webAvailable, webFetch, webResearch, webSearch } from './web'

// Server half of the plugins (architecture "插件与界面"). Each execute() returns an MCP-style
// CallToolResult: `content` goes to the model, `structuredContent` only to the view.
// Tool names use `_` because both model APIs reject `.` in tool names.

/** What tools need from the chat running them. */
export interface ToolHost {
  env: WorkerEnv
  /** Throws when Google Drive is not connected. */
  drive(): Promise<{ drive: Drive; folders: Folders }>
  /** Tells the hub to refresh its file list after a write. */
  filesChanged(): void
  /** Texts read in this chat instance, so citations can be checked without another download. */
  readCache: Map<string, { name: string; text: string }>
  /** Converted Office/PDF text, kept by the hub across chats. */
  textCache: TextCache
  /** Whether this turn's model accepts images; unknown models are assumed to. */
  seesImages: boolean
  /** Transcript of another of the user's chats; throws for an unknown id. */
  readChat(id: string): Promise<{ title: string; text: string }>
  /** Instructions of an enabled skill and the paths of the files beside its SKILL.md. */
  loadSkill(name: string): Promise<{ body: string; resources: string[] }>
  readSkillResource(name: string, path: string): Promise<string>
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
    const { file, text } = await drive.readText(fileId, folders, host.textCache)
    host.readCache.set(file.id, { name: file.name, text })
    return { file, text }
  }

  // Every model step converts the whole history again; keep recent images instead of downloading them each time.
  const images = new Map<string, { mediaType: string; data: string }>()
  const seeImage = async (id: string) => {
    const hit = images.get(id)
    if (hit) return hit
    const { drive } = await host.drive()
    const { mediaType, data } = await drive.image(id)
    images.set(id, { mediaType, data })
    if (images.size > 8) images.delete(images.keys().next().value!)
    return { mediaType, data }
  }

  /** One `READ_CHUNK` of a long text, with how to read on. */
  const chunk = (text: string, offset: number) => {
    const part = text.slice(offset, offset + READ_CHUNK)
    const end = offset + part.length
    return { part, end, more: end < text.length ? `\n\n[第 ${offset}–${end} 字，共 ${text.length} 字；用 offset=${end} 继续读]` : '' }
  }
  const offsetInput = z.number().int().min(0).optional().describe('从第几个字符开始，默认 0')

  return {
    // Always on (roadmap-2 L2): skills and @-mentioned chats are not plugins the user switches off.
    core: {
      skill_activate: tool({
        description: '激活一个 Skill，取得它的完整说明。任务符合系统提示里列出的某个 Skill，或用户用命令指定了 Skill 时，先调用它，再按说明完成任务。',
        inputSchema: z.object({ name: z.string().min(1).max(64).describe('Skill 名称，与列表中一致') }),
        execute: guarded(async ({ name }) => {
          const { body, resources } = await host.loadSkill(name)
          const files = resources.length ? `\n\n这个 Skill 附带的文件（需要时用 skill_read 读取）：\n${resources.map((p) => `- ${p}`).join('\n')}` : ''
          return { content: `Skill「${name}」的说明：\n\n${body}${files}`, structuredContent: { name, resources } }
        }),
        toModelOutput,
      }),
      skill_read: tool({
        description: `读取已激活的 Skill 附带的文件。path 是 skill_activate 列出的路径。每次最多 ${READ_CHUNK} 字。`,
        inputSchema: z.object({ name: z.string().min(1).max(64), path: z.string().min(1).max(300), offset: offsetInput }),
        execute: guarded(async ({ name, path, offset = 0 }) => {
          const { part, more } = chunk(await host.readSkillResource(name, path), offset)
          return { content: `Skill「${name}」的文件 ${path}：\n\n${part}${more}` }
        }),
        toModelOutput,
      }),
      chats_read: tool({
        description: `读取用户的另一个会话（用户用 @ 提到的会话），作为本轮的上下文。每次最多 ${READ_CHUNK} 字。`,
        inputSchema: z.object({ id: z.string().min(1).max(100).describe('会话 id'), offset: offsetInput }),
        execute: guarded(async ({ id, offset = 0 }) => {
          const { title, text } = await host.readChat(id)
          const { part, more } = chunk(text, offset)
          return { content: `会话「${title}」：\n\n${part || '（还没有内容）'}${more}`, structuredContent: { id, title } }
        }),
        toModelOutput,
      }),
    },
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
        description: `按文件 ID 读取内容。文本、Google 文档、PDF（含扫描件 OCR）、Word、Excel、PowerPoint 读成文字，每次最多 ${READ_CHUNK} 字，较长的文件用 offset 继续读；图片会直接给你看。`,
        inputSchema: z.object({ fileId: z.string().min(1), offset: offsetInput }),
        execute: guarded(async ({ fileId, offset = 0 }) => {
          const { drive } = await host.drive()
          const meta = await drive.get(fileId)
          // Only the id is stored; the pixels are fetched when the model reads the result.
          if (isImage(meta.mimeType)) return { content: `图片：${meta.name}（id: ${meta.id}）`, structuredContent: { file: toFile(meta, 'drive'), image: true } }
          const { file, text } = await read(fileId)
          const { part, end, more } = chunk(text, offset)
          return {
            content: `文件：${file.name}（id: ${file.id}）\n\n${part}${more}`,
            structuredContent: { file, offset, end, total: text.length },
          }
        }),
        toModelOutput: async ({ output }: { output: ToolResult }) => {
          const image = output.structuredContent as { file?: DriveFile; image?: boolean } | undefined
          if (output.isError || !image?.image || !image.file) return toModelOutput({ output })
          if (!host.seesImages) return { type: 'text' as const, value: `${output.content}\n\n当前模型不支持图像输入，看不到这张图片。请告诉用户换一个支持图片的模型再试。` }
          try {
            const { mediaType, data } = await seeImage(image.file.id)
            return { type: 'content' as const, value: [{ type: 'text' as const, text: output.content }, { type: 'image-data' as const, data, mediaType }] }
          } catch (e) {
            return { type: 'error-text' as const, value: `${output.content}\n\n读取图片失败：${e instanceof Error ? e.message : String(e)}` }
          }
        },
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
    web: webTools(host.env),
  } satisfies Record<string, ToolSet>
}

/** Web plugin; tools whose backend is not configured are left out. */
function webTools(env: WorkerEnv): ToolSet {
  const has = webAvailable(env)
  const out: ToolSet = {}
  if (has.search) {
    out.web_search = tool({
      description: '搜索公开网页，返回标题、链接、日期和摘要。适合查事实、找最新信息和找链接。支持 site:域名、"精确短语"、-排除词、after:2025 等语法。',
      inputSchema: z.object({
        query: z.string().min(1).max(128).describe('搜索词，最多 128 字'),
        count: z.number().int().min(1).max(20).optional().describe('结果数，默认 8'),
      }),
      execute: guarded(async ({ query, count = 8 }) => {
        const hits = await webSearch(env, query, count)
        if (!hits.length) return { content: `没有找到「${query}」的结果`, structuredContent: { sources: [] } }
        const lines = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.url}${h.date ? `（${h.date.slice(0, 10)}）` : ''}\n${h.summary}`)
        return { content: lines.join('\n\n'), structuredContent: { sources: hits.map(({ url, title, site }) => ({ url, title, site })) } }
      }),
      toModelOutput,
    })
    out.web_fetch = tool({
      description: `读取一个网页的正文（Markdown）。每次最多返回 ${READ_CHUNK} 字，较长的网页用 offset 继续读。`,
      inputSchema: z.object({
        url: z.string().url().max(8192),
        offset: z.number().int().min(0).optional().describe('从第几个字符开始，默认 0'),
      }),
      execute: guarded(async ({ url, offset = 0 }) => {
        if (!/^https?:\/\//i.test(url) || new URL(url).username) return { content: '只能读取 http(s) 网页', isError: true }
        const page = await webFetch(env, url)
        const part = page.content.slice(offset, offset + READ_CHUNK)
        const end = offset + part.length
        const more = end < page.content.length ? `\n\n[第 ${offset}–${end} 字，共 ${page.content.length} 字；用 offset=${end} 继续读]` : ''
        return {
          content: `网页：${page.title}\n${url}\n\n${part || '（没有正文）'}${more}`,
          structuredContent: { sources: [{ url, title: page.title, site: new URL(url).hostname.replace(/^www\./, '') }] },
        }
      }),
      toModelOutput,
    })
  }
  if (has.research) {
    out.web_research = tool({
      description: '深度搜索：由另一个模型多次搜索、打开网页并交叉核对，返回带来源的研究结论。耗时较长（约半分钟到两分钟），只在问题复杂、需要多方对比，或 web_search 结果不够时使用。',
      inputSchema: z.object({ question: z.string().min(1).max(2000).describe('完整的研究问题，写明背景和需要的细节') }),
      execute: guarded(async ({ question }, { abortSignal }) => {
        const r = await webResearch(env, question, abortSignal)
        const refs = r.sources.map((s, i) => `[${i + 1}] ${s.title} ${s.url}`).join('\n')
        return { content: `${r.text}${refs ? `\n\n来源：\n${refs}` : ''}`, structuredContent: { sources: r.sources } }
      }),
      toModelOutput,
    })
  }
  return out
}

export type PluginId = Exclude<keyof ReturnType<typeof createTools>, 'core'>
/** Plugins this server implements; the hub offers only these. */
export const pluginIds: PluginId[] = ['files', 'artifact', 'web']
/** Plugins this deployment can offer, given which backends `.env` configures. */
export function availablePlugins(env: WorkerEnv): PluginId[] {
  const web = webAvailable(env)
  return pluginIds.filter((id) => id !== 'web' || web.search || web.research)
}
/** Plugin of each tool, for checking calls made by views. */
export const toolPlugin = (all: ReturnType<typeof createTools>, name: string) => (Object.entries(all) as [PluginId | 'core', ToolSet][]).find(([, set]) => name in set)?.[0]

/** The core tools and those of the enabled plugins (Spec S8: a disabled plugin's tools are never offered). */
export function enabledTools(all: ReturnType<typeof createTools>, enabled: string[]): ToolSet {
  const out: ToolSet = {}
  for (const [id, set] of Object.entries(all)) if (id === 'core' || enabled.includes(id)) Object.assign(out, set)
  return out
}
