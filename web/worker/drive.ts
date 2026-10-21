import type { DriveFile } from '../src/types'

// Minimal Drive v3 client (architecture "Drive 存储"). Reads anywhere in the user's Drive;
// every write goes through `create`, which only accepts a parent inside GenseBot/.

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
const FOLDER = 'application/vnd.google-apps.folder'
const FIELDS = 'id,name,mimeType,size,modifiedTime,parents'

export const ROOT_NAME = 'GenseBot'
export const SOURCES_NAME = '资料'
export const ARTIFACTS_NAME = 'Artifacts'
/** Spec "兜底限制": uploads and reads are text, at most 2 MB. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

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
}

/** Google Workspace types and the text format each is exported as. */
const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/markdown',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
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

  /** Finds or creates GenseBot/{资料,Artifacts}. Folders the user moved into the trash are not reused. */
  async ensureFolders(): Promise<Folders> {
    const folder = async (name: string, parent: string) => {
      const [found] = await this.query(`name = ${lit(name)} and mimeType = '${FOLDER}' and ${lit(parent)} in parents and trashed = false`, { pageSize: 1 })
      if (found) return found.id
      const created = await this.json<RawFile>(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
      })
      return created.id
    }
    const root = await folder(ROOT_NAME, 'root')
    const [sources, artifacts] = await Promise.all([folder(SOURCES_NAME, root), folder(ARTIFACTS_NAME, root)])
    return { root, sources, artifacts }
  }

  /** Files (not folders) directly inside one folder, newest first. */
  async list(folderId: string, kind: DriveFile['kind']): Promise<DriveFile[]> {
    const files = await this.query(`${lit(folderId)} in parents and mimeType != '${FOLDER}' and trashed = false`, { orderBy: 'modifiedTime desc', pageSize: 200 })
    return files.map((f) => toFile(f, kind))
  }

  /** Name and full-text search across the whole Drive. */
  async search(text: string, folders: Folders | null, limit = 20): Promise<DriveFile[]> {
    const files = await this.query(`(name contains ${lit(text)} or fullText contains ${lit(text)}) and mimeType != '${FOLDER}' and trashed = false`, { pageSize: limit })
    return files.map((f) => toFile(f, kindOf(f, folders)))
  }

  /** Text of a file: Workspace documents are exported, other text files downloaded as-is. */
  async readText(id: string, folders: Folders | null): Promise<{ file: DriveFile; text: string }> {
    const meta = await this.get(id)
    const file = toFile(meta, kindOf(meta, folders))
    if (!isText(meta.mimeType, meta.name)) throw new DriveError(`暂不支持读取这种文件（${meta.mimeType}）。首版只读取文本文件和 Google 文档、表格、幻灯片。`, 415)
    if (Number(meta.size ?? 0) > MAX_TEXT_BYTES) throw new DriveError(`「${meta.name}」超过 2 MB，暂不读取。`, 413)
    const exportAs = EXPORTS[meta.mimeType]
    const url = exportAs
      ? `${API}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportAs)}`
      : `${API}/files/${encodeURIComponent(id)}?alt=media`
    const text = await (await this.request(url)).text()
    return { file, text }
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
