import type { DriveFile } from '../src/types'
import { MAX_UPLOAD_BYTES } from '../src/util'

export { MAX_UPLOAD_BYTES }

// Minimal Drive v3 client (architecture "Drive 存储"). Reads anywhere in the user's Drive;
// every write goes through `create`, which only accepts a parent inside GenseBot/.

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
const RESUMABLE = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'
const FOLDER = 'application/vnd.google-apps.folder'
const FIELDS = 'id,name,mimeType,size,modifiedTime,parents'
const DOC = 'application/vnd.google-apps.document'
const SHEET = 'application/vnd.google-apps.spreadsheet'
const SLIDES = 'application/vnd.google-apps.presentation'

export const ROOT_NAME = 'GenseBot'
export const SOURCES_NAME = '资料'
export const ARTIFACTS_NAME = 'Artifacts'
export const SKILLS_NAME = 'Skills'
/** Converted copies live here only while they are read (roadmap-2 "L0-2 附件管线"). */
export const CACHE_NAME = '.cache'
/** Text written by the assistant and plain text files read as-is. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** Longest side of an image shown to a model; Drive renders the thumbnail. */
const IMAGE_SIDE = 1024
/** Originals up to this size are sent when Drive has no thumbnail. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export interface Folders {
  root: string
  sources: string
  artifacts: string
}

interface RawFile {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
  parents?: string[]
  thumbnailLink?: string
}

/** Google Workspace types and the text format each is exported as. */
const EXPORTS: Record<string, string> = {
  [DOC]: 'text/markdown',
  [SHEET]: 'text/csv',
  [SLIDES]: 'text/plain',
}

/** Office, ODF, RTF and PDF files are read by converting a copy into the matching Workspace type. */
const CONVERTS: Record<string, string> = {
  'application/pdf': DOC,
  'application/msword': DOC,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': DOC,
  'application/vnd.oasis.opendocument.text': DOC,
  'application/rtf': DOC,
  'text/rtf': DOC,
  'application/vnd.ms-excel': SHEET,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': SHEET,
  'application/vnd.oasis.opendocument.spreadsheet': SHEET,
  'application/vnd.ms-powerpoint': SLIDES,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': SLIDES,
  'application/vnd.oasis.opendocument.presentation': SLIDES,
}

export const isImage = (mimeType: string) => /^image\/(png|jpe?g|gif|webp|heic|heif|bmp)$/.test(mimeType)

/** Converted text kept by `fileId:modifiedTime`, so a file is converted once (UserHub's SQLite). */
export interface TextCache {
  get(key: string): Promise<string | null>
  put(key: string, text: string): Promise<void>
}

export const isText = (mimeType: string, name = '') =>
  mimeType in EXPORTS || /^text\//.test(mimeType) || /json|xml|yaml|javascript|typescript/.test(mimeType) || /\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|html?)$/i.test(name)

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Drive query literal: backslashes and quotes escaped. */
const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

export class Drive {
  constructor(private readonly token: string) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${this.token}`, ...init.headers } })
    if (res.ok) return res
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    const detail = body?.error?.message ?? res.statusText
    if (res.status === 404) throw new DriveError('文件不存在，或你的 Google 账号无权访问', 404)
    if (res.status === 401) throw new DriveError('Google 授权已失效，请重新连接 Google Drive', 401)
    if (res.status === 403 || res.status === 429) throw new DriveError(`Google Drive 拒绝了请求：${detail}`, res.status)
    throw new DriveError(`Google Drive 出错（${res.status}）：${detail}`, res.status)
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    return (await this.request(url, init)).json() as Promise<T>
  }

  private async query(q: string, opts: { pageSize?: number; orderBy?: string } = {}) {
    const u = new URL(`${API}/files`)
    u.search = new URLSearchParams({
      q,
      fields: `files(${FIELDS})`,
      pageSize: String(opts.pageSize ?? 100),
      ...(opts.orderBy ? { orderBy: opts.orderBy } : {}),
      spaces: 'drive',
    }).toString()
    return (await this.json<{ files: RawFile[] }>(u.toString())).files
  }

  async get(id: string): Promise<RawFile> {
    return this.json<RawFile>(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}`)
  }

  /** Finds or creates a folder by name. Folders the user moved into the trash are not reused. */
  private async folder(name: string, parent: string): Promise<string> {
    const [found] = await this.query(`name = ${lit(name)} and mimeType = '${FOLDER}' and ${lit(parent)} in parents and trashed = false`, { pageSize: 1 })
    if (found) return found.id
    const created = await this.json<RawFile>(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
    })
    return created.id
  }

  /** Finds or creates GenseBot/{资料,Artifacts}. */
  async ensureFolders(): Promise<Folders> {
    const root = await this.folder(ROOT_NAME, 'root')
    const [sources, artifacts] = await Promise.all([this.folder(SOURCES_NAME, root), this.folder(ARTIFACTS_NAME, root)])
    return { root, sources, artifacts }
  }

  /** Finds or creates GenseBot/Skills; each skill is a folder in it holding a SKILL.md. */
  skillsFolder(folders: Folders): Promise<string> {
    return this.folder(SKILLS_NAME, folders.root)
  }

  /** Folders directly inside one folder, by name. */
  async folders(parentId: string): Promise<{ id: string; name: string }[]> {
    const found = await this.query(`${lit(parentId)} in parents and mimeType = '${FOLDER}' and trashed = false`, { orderBy: 'name', pageSize: 200 })
    return found.map(({ id, name }) => ({ id, name }))
  }

  /** Files named `name` directly inside any of `parentIds`. */
  async named(name: string, parentIds: string[]): Promise<(DriveFile & { parent: string })[]> {
    if (!parentIds.length) return []
    const parents = parentIds.map((p) => `${lit(p)} in parents`).join(' or ')
    const found = await this.query(`name = ${lit(name)} and (${parents}) and trashed = false`, { pageSize: 200 })
    return found.map((f) => ({ ...toFile(f, 'drive'), parent: f.parents?.find((p) => parentIds.includes(p)) ?? '' }))
  }

  /** Files (not folders) directly inside one folder, newest first. */
  async list(folderId: string, kind: DriveFile['kind']): Promise<DriveFile[]> {
    const files = await this.query(`${lit(folderId)} in parents and mimeType != '${FOLDER}' and trashed = false`, { orderBy: 'modifiedTime desc', pageSize: 200 })
    return files.map((f) => toFile(f, kind))
  }

  /** Name and full-text search across the whole Drive. */
  /** Name and full-text search; `within` limits it to files directly in those folders. */
  async search(text: string, folders: Folders | null, limit = 20, within: string[] = []): Promise<DriveFile[]> {
    const scope = within.length ? ` and (${within.map((id) => `${lit(id)} in parents`).join(' or ')})` : ''
    const files = await this.query(`(name contains ${lit(text)} or fullText contains ${lit(text)}) and mimeType != '${FOLDER}' and trashed = false${scope}`, { pageSize: limit })
    return files.map((f) => toFile(f, kindOf(f, folders)))
  }

  /**
   * Text of a file: Workspace documents are exported, plain text downloaded as-is, and Office,
   * ODF, RTF and PDF files converted through a temporary copy in GenseBot/.cache (PDFs with OCR).
   * The original is never modified.
   */
  async readText(id: string, folders: Folders | null, cache?: TextCache): Promise<{ file: DriveFile; text: string }> {
    const meta = await this.get(id)
    const file = toFile(meta, kindOf(meta, folders))
    const size = Number(meta.size ?? 0)
    const exportAs = EXPORTS[meta.mimeType]
    if (exportAs) return { file, text: await this.export(id, exportAs) }
    if (isText(meta.mimeType, meta.name)) {
      if (size > MAX_TEXT_BYTES) throw new DriveError(`「${meta.name}」超过 2 MB，暂不读取。`, 413)
      return { file, text: await (await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media`)).text() }
    }
    if (isImage(meta.mimeType)) throw new DriveError(`「${meta.name}」是图片，不能读成文字。`, 415)
    const target = CONVERTS[meta.mimeType]
    if (!target) throw new DriveError(`暂不支持读取这种文件（${meta.mimeType}）。支持文本、PDF、Word、Excel、PowerPoint、OpenDocument 和图片。`, 415)
    if (!folders) throw new DriveError('读取这种文件需要先连接 Google Drive', 401)
    if (size > MAX_UPLOAD_BYTES) throw new DriveError(`「${meta.name}」超过 20 MB，暂不读取。`, 413)
    const key = `${id}:${meta.modifiedTime ?? ''}`
    const cached = await cache?.get(key)
    if (cached != null) return { file, text: cached }
    const text = await this.convert(meta, target, folders)
    await cache?.put(key, text)
    return { file, text }
  }

  private async export(id: string, mimeType: string) {
    return (await this.request(`${API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mimeType)}`)).text()
  }

  /** Copies `meta` into GenseBot/.cache as a Workspace file, exports its text and deletes the copy. */
  private async convert(meta: RawFile, target: string, folders: Folders): Promise<string> {
    const cacheFolder = await this.folder(CACHE_NAME, folders.root)
    const u = new URL(`${API}/files/${encodeURIComponent(meta.id)}/copy`)
    u.search = new URLSearchParams({ fields: 'id', ...(meta.mimeType === 'application/pdf' ? { ocrLanguage: 'zh' } : {}) }).toString()
    const copy = await this.json<RawFile>(u.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${meta.name} (转换副本)`, parents: [cacheFolder], mimeType: target }),
    })
    try {
      const text = await this.export(copy.id, EXPORTS[target])
      return target === SHEET ? `（表格只导出了第一个工作表）\n\n${text}` : text
    } finally {
      // Only the copy made above, which lies in GenseBot/.cache.
      await this.request(`${API}/files/${encodeURIComponent(copy.id)}`, { method: 'DELETE' }).catch((e: unknown) => console.warn('deleting converted copy failed', e))
    }
  }

  /** An image as base64, at most IMAGE_SIDE pixels on its longest side when Drive has a thumbnail. */
  async image(id: string): Promise<{ file: RawFile; mediaType: string; data: string }> {
    const meta = await this.json<RawFile>(`${API}/files/${encodeURIComponent(id)}?fields=${FIELDS},thumbnailLink`)
    if (!isImage(meta.mimeType)) throw new DriveError(`「${meta.name}」不是图片`, 415)
    if (meta.thumbnailLink) {
      const res = await this.request(meta.thumbnailLink.replace(/=s\d+$/, '') + `=s${IMAGE_SIDE}`).catch(() => null)
      if (res) return { file: meta, mediaType: res.headers.get('content-type')?.split(';')[0] || 'image/jpeg', data: base64(await res.arrayBuffer()) }
    }
    if (Number(meta.size ?? 0) > MAX_IMAGE_BYTES) throw new DriveError(`「${meta.name}」太大，Drive 也没有生成缩略图，暂时无法查看。`, 413)
    const res = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media`)
    return { file: meta, mediaType: meta.mimeType, data: base64(await res.arrayBuffer()) }
  }

  /** True when `id` is `rootId` or lies somewhere below it. */
  async isWithin(id: string, rootId: string): Promise<boolean> {
    let current: string | undefined = id
    for (let depth = 0; current && depth < 32; depth++) {
      if (current === rootId) return true
      current = (await this.get(current)).parents?.[0]
    }
    return false
  }

  /** The only write path: a new text file inside GenseBot/ (Spec S5). Never overwrites. */
  async create(folders: Folders, parent: string, name: string, text: string, appProperties: Record<string, string> = {}): Promise<DriveFile> {
    if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) throw new DriveError(`「${name}」超过 2 MB 上限，未保存。`, 413)
    // The folder ids come from our own state, but the user may have moved a folder out of GenseBot/ since.
    if (!(await this.isWithin(parent, folders.root))) throw new DriveError('目标文件夹不在 GenseBot/ 内，拒绝写入', 403)
    const mimeType = mimeFor(name)
    const boundary = `gense-${crypto.randomUUID()}`
    const body =
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent], mimeType, appProperties })}\r\n` +
      `--${boundary}\r\ncontent-type: ${mimeType}; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`
    const created = await this.json<RawFile>(`${UPLOAD}&fields=${FIELDS}`, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body })
    return toFile(created, parent === folders.artifacts ? 'artifact' : 'source')
  }

  /** Uploads any file, unchanged, into a folder inside GenseBot/ (roadmap-2 R7). Never overwrites. */
  async upload(folders: Folders, parent: string, name: string, mimeType: string, bytes: ArrayBuffer): Promise<DriveFile> {
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new DriveError(`「${name}」超过 20 MB 上限，未上传。`, 413)
    if (!(await this.isWithin(parent, folders.root))) throw new DriveError('目标文件夹不在 GenseBot/ 内，拒绝写入', 403)
    // Resumable, because multipart uploads are limited to 5 MB.
    const type = mimeType || 'application/octet-stream'
    const start = await this.request(`${RESUMABLE}&fields=${FIELDS}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': type, 'x-upload-content-length': String(bytes.byteLength) },
      body: JSON.stringify({ name, parents: [parent] }),
    })
    const session = start.headers.get('location')
    if (!session) throw new DriveError('Google Drive 没有返回上传地址', 502)
    const created = await this.json<RawFile>(session, { method: 'PUT', headers: { 'content-type': type }, body: bytes })
    return toFile(created, parent === folders.artifacts ? 'artifact' : 'source')
  }

  /** A file earlier created with `appProperties.idempotencyKey = key`, if any. */
  async findByKey(parent: string, key: string): Promise<RawFile | undefined> {
    const [found] = await this.query(`${lit(parent)} in parents and appProperties has { key='idempotencyKey' and value=${lit(key)} } and trashed = false`, { pageSize: 1 })
    return found
  }

  /** Name not yet used in the folder: `a.md`, `a (2).md`, … */
  async freeName(parent: string, name: string): Promise<string> {
    const dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    const taken = new Set((await this.query(`${lit(parent)} in parents and name contains ${lit(stem)} and trashed = false`)).map((f) => f.name))
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? name : `${stem} (${i})${ext}`
      if (!taken.has(candidate)) return candidate
    }
  }
}

function kindOf(f: RawFile, folders: Folders | null): DriveFile['kind'] {
  if (folders && f.parents?.includes(folders.artifacts)) return 'artifact'
  if (folders && f.parents?.includes(folders.sources)) return 'source'
  return 'drive'
}

export function toFile(f: RawFile, kind: DriveFile['kind']): DriveFile {
  return { id: f.id, name: f.name, kind, mimeType: f.mimeType, size: f.size ? Number(f.size) : null, modifiedTime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0 }
}

function mimeFor(name: string) {
  if (/\.(md|markdown)$/i.test(name)) return 'text/markdown'
  if (/\.csv$/i.test(name)) return 'text/csv'
  if (/\.json$/i.test(name)) return 'application/json'
  if (/\.html?$/i.test(name)) return 'text/html'
  return 'text/plain'
}

function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
