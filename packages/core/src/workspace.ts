// One user's files as the agent and the file panel see them (roadmap-3 D6). Hosts supply an ExecutionEnv for a virtual
// working directory; Node maps `/data` onto a directory, Cloudflare keeps the files in the UserHub's SQLite.
//
//   /data/sessions/<treeId>/   a tree's workspace, the agent's cwd
//   /data/skills/              shared Skills, read-only to the agent
//   /data/uploads/             files the user uploaded, copied into a tree when attached to a message
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import type { ExecutionEnv, FileInfo } from '@earendil-works/pi-durable/env'
import { basename, isUnder, resolvePath } from './fs/paths.ts'
import type { FileEntry, FilePreview, UploadedFile } from './protocol.ts'

export const DATA_DIR = '/data'
export const SKILLS_DIR = '/data/skills'
export const UPLOADS_DIR = '/data/uploads'
export const treeDir = (treeId: string) => `/data/sessions/${treeId}`

/** Builds an environment whose working directory is the virtual path `cwd`. */
export type EnvFactory = (cwd: string) => ExecutionEnv | Promise<ExecutionEnv>

export const MAX_UPLOAD = 20 * 1024 * 1024
const PREVIEW_BYTES = 64 * 1024
const MAX_LISTED = 2000

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}
export const mimeOf = (path: string) => MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'

export function toBase64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
export const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** A file name safe to put in a path: no separators, no leading dots. */
export const safeName = (name: string) => basename(name.replace(/\\/g, '/')).replace(/^\.+/, '').replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'file'

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }) => {
  if (!r.ok) throw r.error
  return r.value
}

export class Workspace {
  readonly #env: EnvFactory

  constructor(env: EnvFactory) {
    this.#env = env
  }

  env(cwd: string) {
    return this.#env(cwd)
  }

  /** Throws unless the panel may touch `path` for this tree: its own workspace, or the read-only Skills. */
  #check(treeId: string, path: string, write: boolean) {
    const abs = resolvePath(treeDir(treeId), path)
    if (isUnder(abs, treeDir(treeId)) && abs !== treeDir(treeId)) return abs
    if (!write && isUnder(abs, SKILLS_DIR)) return abs
    throw new Error(write ? '只能修改本会话工作区里的文件' : '只能查看本会话工作区和 Skills 里的文件')
  }

  async createTree(treeId: string, ctx: Context = BACKGROUND_CONTEXT) {
    const env = await this.#env(DATA_DIR)
    unwrap(await env.createDir(treeDir(treeId), { recursive: true }, ctx))
  }

  async deleteTree(treeId: string, ctx: Context = BACKGROUND_CONTEXT) {
    const env = await this.#env(DATA_DIR)
    unwrap(await env.remove(treeDir(treeId), { recursive: true, force: true }, ctx))
  }

  /** Files under the tree's workspace and the Skills, depth first, without directories. */
  async list(treeId: string, ctx: Context = BACKGROUND_CONTEXT): Promise<FileEntry[]> {
    const env = await this.#env(treeDir(treeId))
    const out: FileEntry[] = []
    const walk = async (dir: string, readOnly: boolean): Promise<void> => {
      const listed = await env.listDir(dir, ctx)
      if (!listed.ok) return
      const infos = listed.value.sort((a: FileInfo, b: FileInfo) => a.name.localeCompare(b.name))
      for (const info of infos) {
        if (out.length >= MAX_LISTED) return
        if (info.kind === 'directory') await walk(info.path, readOnly)
        else if (info.kind === 'file') out.push({ path: info.path, size: info.size, mtime: info.mtimeMs, readOnly })
      }
    }
    await walk(treeDir(treeId), false)
    await walk(SKILLS_DIR, true)
    return out
  }

  async preview(treeId: string, path: string, ctx: Context = BACKGROUND_CONTEXT): Promise<FilePreview> {
    const env = await this.#env(treeDir(treeId))
    const reader = unwrap(await env.openBinaryReader(this.#check(treeId, path, false), undefined, ctx))
    try {
      const { size } = unwrap(await reader.info(ctx))
      const bytes = unwrap(await reader.read(0, Math.min(size, PREVIEW_BYTES), ctx))
      try {
        // A cut can split a multibyte character; `stream` keeps the incomplete tail out instead of failing.
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes, { stream: size > PREVIEW_BYTES })
        return { text, size, truncated: size > PREVIEW_BYTES, binary: false }
      } catch {
        return { text: '', size, truncated: false, binary: true }
      }
    } finally {
      await reader.close(ctx)
    }
  }

  /** The whole file, for download. */
  async read(treeId: string, path: string, ctx: Context = BACKGROUND_CONTEXT) {
    const env = await this.#env(treeDir(treeId))
    const abs = this.#check(treeId, path, false)
    const bytes = unwrap(await env.readBinaryFile(abs, ctx))
    return { name: basename(abs), mimeType: mimeOf(abs), base64: toBase64(bytes) }
  }

  async delete(treeId: string, path: string, ctx: Context = BACKGROUND_CONTEXT) {
    const env = await this.#env(treeDir(treeId))
    unwrap(await env.remove(this.#check(treeId, path, true), { recursive: true }, ctx))
  }

  /** Stores an upload under /data/uploads; it reaches a tree when attached to a message. */
  async upload(name: string, bytes: Uint8Array, ctx: Context = BACKGROUND_CONTEXT): Promise<UploadedFile> {
    if (bytes.length > MAX_UPLOAD) throw new Error('文件超过 20 MB')
    const env = await this.#env(UPLOADS_DIR)
    const path = `${UPLOADS_DIR}/${crypto.randomUUID().slice(0, 8)}-${safeName(name)}`
    unwrap(await env.writeFile(path, bytes, ctx))
    return { id: path, name: safeName(name), mimeType: mimeOf(path), size: bytes.length, modifiedTime: Date.now() }
  }

  /** Copies uploads into the tree's `attachments/`; resolves to their workspace paths and, for images, their bytes. */
  async attach(treeId: string, ids: string[], ctx: Context = BACKGROUND_CONTEXT) {
    const env = await this.#env(treeDir(treeId))
    const out: { path: string; mimeType: string; bytes: Uint8Array }[] = []
    for (const id of ids) {
      const source = resolvePath(UPLOADS_DIR, id)
      if (!isUnder(source, UPLOADS_DIR) || source === UPLOADS_DIR) throw new Error('附件不存在')
      const bytes = unwrap(await env.readBinaryFile(source, ctx))
      const path = `${treeDir(treeId)}/attachments/${basename(source).replace(/^[0-9a-f]{8}-/, '')}`
      unwrap(await env.writeFile(path, bytes, ctx))
      out.push({ path, mimeType: mimeOf(path), bytes })
    }
    return out
  }

  async uploads(ctx: Context = BACKGROUND_CONTEXT): Promise<UploadedFile[]> {
    const env = await this.#env(UPLOADS_DIR)
    const listed = await env.listDir(UPLOADS_DIR, ctx)
    if (!listed.ok) return []
    return listed.value
      .filter((i) => i.kind === 'file')
      .map((i) => ({ id: i.path, name: i.name.replace(/^[0-9a-f]{8}-/, ''), mimeType: mimeOf(i.path), size: i.size, modifiedTime: i.mtimeMs }))
      .sort((a, b) => b.modifiedTime - a.modifiedTime)
  }
}
