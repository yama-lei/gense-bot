// Reading documents (roadmap-3 R33: R9). `read` turns PDF, Word, Excel and PowerPoint files into text, so the model
// pages through them with offset/limit like any text file. Pure JavaScript, so Workers run it too: the Office formats
// are zipped XML, PDFs go through pdf.js (unpdf). Scanned PDFs have no text layer and are reported as such.
import type { Context } from '@earendil-works/chord/context'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { createReadTool } from '@earendil-works/pi-durable/tools'
import { strFromU8, unzipSync } from 'fflate'
import { DATA_DIR } from './workspace.ts'

export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'pptx'

const KINDS: Record<string, DocumentKind> = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' }
/** Older binary formats we cannot open; the model is told to ask for the newer one. */
const LEGACY: Record<string, string> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' }

const extension = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''

export const documentKind = (path: string): DocumentKind | undefined => KINDS[extension(path)]

/** Extracted text lands here, keyed by the file's path, size and time, so paging does not parse the file again. */
const CACHE_DIR = `${DATA_DIR}/.cache/documents`

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (entities[e] ?? m),
  )

/** Text of each `<tag>` paragraph in `xml`, joining the runs `<run>` inside it; tabs and breaks kept. */
function paragraphs(xml: string, tag: string, run: string) {
  const out: string[] = []
  for (const p of xml.matchAll(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'g'))) {
    let text = ''
    for (const m of p[0].matchAll(new RegExp(`<${run}(?:\\s[^>]*)?>([\\s\\S]*?)</${run}>|<[a-z]:(tab|br|cr)\\b[^>]*/>`, 'g')))
      text += m[2] === 'tab' ? '\t' : m[2] ? '\n' : unescape(m[1]!)
    out.push(text)
  }
  return out
}

function docx(files: Record<string, Uint8Array>) {
  const xml = files['word/document.xml']
  if (!xml) throw new Error('不是有效的 Word 文档')
  // A table row becomes one paragraph of tab-separated cells.
  const body = strFromU8(xml).replace(/<w:tr[\s>][\s\S]*?<\/w:tr>/g, (row) => {
    const cells = [...row.matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)].map((c) => paragraphs(c[0], 'w:p', 'w:t').join(' '))
    return `<w:p><w:r><w:t>${cells.join('\t').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`
  })
  return paragraphs(body, 'w:p', 'w:t').join('\n')
}

const byNumber = (prefix: string, files: Record<string, Uint8Array>) =>
  Object.keys(files)
    .filter((f) => new RegExp(`^${prefix}\\d+\\.xml$`).test(f))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))

function pptx(files: Record<string, Uint8Array>) {
  const slides = byNumber('ppt/slides/slide', files)
  if (!slides.length) throw new Error('不是有效的 PowerPoint 文件')
  return slides
    .map((f, i) => {
      const text = paragraphs(strFromU8(files[f]!), 'a:p', 'a:t').filter((l) => l.trim())
      const notes = files[f.replace('slides/slide', 'notesSlides/notesSlide')]
      const noteText = notes ? paragraphs(strFromU8(notes), 'a:p', 'a:t').filter((l) => l.trim() && !/^\d+$/.test(l.trim())) : []
      return [`## 第 ${i + 1} 页`, ...text, ...(noteText.length ? ['', '备注：', ...noteText] : [])].join('\n')
    })
    .join('\n\n')
}

/** Column letters of a cell reference to a 0-based index. */
const column = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1

function xlsx(files: Record<string, Uint8Array>) {
  const book = files['xl/workbook.xml']
  if (!book) throw new Error('不是有效的 Excel 文件')
  const shared = files['xl/sharedStrings.xml'] ? paragraphs(strFromU8(files['xl/sharedStrings.xml']), 'si', 't') : []
  const rels = new Map<string, string>()
  for (const m of strFromU8(files['xl/_rels/workbook.xml.rels'] ?? new Uint8Array()).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1]
    const target = /Target="([^"]+)"/.exec(m[0])?.[1]
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`)
  }
  const out: string[] = []
  for (const s of strFromU8(book).matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescape(/name="([^"]*)"/.exec(s[0])?.[1] ?? '')
    const xml = files[rels.get(/r:id="([^"]+)"/.exec(s[0])?.[1] ?? '') ?? '']
    if (!xml) continue
    const rows: string[] = []
    for (const r of strFromU8(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!
        const inner = c[2] ?? ''
        const type = /\bt="(\w+)"/.exec(attrs)?.[1]
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
        const value =
          type === 's' ? (shared[Number(v)] ?? '') : type === 'inlineStr' ? paragraphs(inner, 'is', 't').join('') : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : unescape(v ?? '')
        const at = column(/\br="([A-Z]+)/.exec(attrs)?.[1] ?? '')
        while (cells.length < at) cells.push('')
        cells[at >= 0 ? at : cells.length] = value.replace(/[\t\n]/g, ' ')
      }
      if (cells.some((c) => c)) rows.push(cells.join('\t'))
    }
    out.push([`## 工作表：${name}`, ...rows].join('\n'))
  }
  return out.join('\n\n')
}

async function pdf(bytes: Uint8Array) {
  const { extractText, getDocumentProxy } = await import('unpdf')
  // A copy: pdf.js wants a plain Uint8Array (Node hands out Buffers) and may transfer its buffer.
  const doc = await getDocumentProxy(new Uint8Array(bytes))
  const { text } = await extractText(doc, { mergePages: false })
  if (!text.some((t) => t.trim())) throw new Error('这个 PDF 没有文字层（可能是扫描件），无法提取文字')
  return text.map((t, i) => `## 第 ${i + 1} 页\n${t.trim()}`).join('\n\n')
}

/** The document's text: pages, slides or sheets under `##` headings. Throws a message for the model when it cannot. */
export async function extractDocument(kind: DocumentKind, bytes: Uint8Array) {
  if (kind === 'pdf') return pdf(bytes)
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new Error('文件已损坏或不是 Office 2007 之后的格式')
  }
  return kind === 'docx' ? docx(files) : kind === 'pptx' ? pptx(files) : xlsx(files)
}

async function digest(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(hash).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The cached text of the document at `path`, extracting it the first time. */
async function documentText(env: ExecutionEnv, path: string, kind: DocumentKind, ctx: Context) {
  const absolute = await env.absolutePath(path, ctx)
  if (!absolute.ok) throw absolute.error
  const info = await env.fileInfo(absolute.value, ctx)
  if (!info.ok) throw info.error
  const cached = `${CACHE_DIR}/${await digest(`${absolute.value}\n${info.value.size}\n${info.value.mtimeMs}`)}.txt`
  const exists = await env.exists(cached, ctx)
  if (exists.ok && exists.value) return cached
  const bytes = await env.readBinaryFile(absolute.value, ctx)
  if (!bytes.ok) throw bytes.error
  const text = await extractDocument(kind, bytes.value)
  await env.createDir(CACHE_DIR, { recursive: true }, ctx)
  const written = await env.writeFile(cached, text || '（文档里没有文字）', ctx)
  if (!written.ok) throw written.error
  return cached
}

/** pi-durable's `read`, which also reads documents as text. */
export function createDocumentReadTool(): ToolRegistration {
  const read = createReadTool() as unknown as ToolRegistration
  return {
    ...read,
    description: `${read.description} PDF, Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files are read as extracted text, with "## " headings per page, slide or sheet; page through them with offset/limit the same way.`,
    async execute(args, api, ctx) {
      const { path } = args as { path: string }
      const legacy = LEGACY[extension(path)]
      if (legacy) throw new Error(`不支持旧的 .${extension(path)} 格式，请让用户另存为 .${legacy} 后再上传`)
      const kind = documentKind(path)
      if (!kind || !api.env) return read.execute(args, api, ctx)
      return read.execute({ ...(args as object), path: await documentText(api.env, path, kind, ctx) }, api, ctx)
    },
  }
}
