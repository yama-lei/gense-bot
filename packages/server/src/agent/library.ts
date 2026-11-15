import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import type { ExecutionEnv, FileInfo } from '@earendil-works/pi-durable/env'
import { fileKind, projectDir, type FileKind, type LibraryFile, type LibraryPage } from '@gense/protocol'
import { basename } from '../platform/fs/paths.ts'
import { DATA_DIR, treeDir } from './workspace.ts'
import type { UserSpace } from './space.ts'

export interface FileRoot { path: string; treeId?: string; projectId?: string }
const visible = (name: string) => !name.startsWith('.') && !['node_modules', '__pycache__'].includes(name)
const compare = (a: LibraryFile, b: LibraryFile) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** Reuse workspace listings for two seconds, checking directory mtimes on each request for adds/removes. */
export class Library {
  readonly #space: UserSpace
  readonly #dirs = new Map<string, { mtime: number; entries: FileInfo[] }>()
  readonly #lists = new Map<string, { at: number; files: LibraryFile[] }>()
  #queue: Promise<unknown> = Promise.resolve()
  constructor(space: UserSpace) { this.#space = space }

  async roots(): Promise<FileRoot[]> {
    const trees = await this.#space.db.all<{ id: string }>('SELECT id FROM trees WHERE expiresAt IS NULL')
    const projects = await this.#space.projects.list()
    return [...trees.map(t => ({ path: treeDir(t.id), treeId: t.id })), ...projects.map(p => ({ path: projectDir(p.id), projectId: p.id }))]
  }

  async #walk(env: ExecutionEnv, dir: string, seen: Set<string>, out: FileInfo[]) {
    const stat = await env.fileInfo(dir, ctx)
    if (!stat.ok || stat.value.kind !== 'directory') return
    seen.add(dir)
    let cached = this.#dirs.get(dir), fresh = false
    if (!cached || cached.mtime !== stat.value.mtimeMs) {
      const listed = await env.listDir(dir, ctx)
      if (!listed.ok) { if (listed.error.code === 'not_found') return; throw listed.error }
      cached = { mtime: stat.value.mtimeMs, entries: listed.value.filter(i => visible(i.name)) }
      this.#dirs.set(dir, cached)
      fresh = true
    }
    for (const previous of cached.entries) {
      const result = fresh ? { ok: true as const, value: previous } : await env.fileInfo(previous.path, ctx)
      if (!result.ok) continue
      const info = result.value
      if (info.kind === 'directory') await this.#walk(env, info.path, seen, out)
      else if (info.kind === 'file') out.push(info)
    }
  }

  /** Also used by exports, so both surfaces have the same root and hidden/dependency-file policy. */
  files(root: FileRoot): Promise<LibraryFile[]> {
    const operation = this.#queue.then(async () => {
      const env = await this.#space.workspace.env(DATA_DIR), files: FileInfo[] = [], seen = new Set<string>()
      const previous = this.#lists.get(root.path)
      if (previous && Date.now() - previous.at < 2000) {
        let valid = true
        const dirs = [...this.#dirs].filter(([path]) => path === root.path || path.startsWith(root.path + '/'))
        for (const [path, cached] of dirs) {
          const stat = await env.fileInfo(path, ctx)
          if (!stat.ok || stat.value.kind !== 'directory' || stat.value.mtimeMs !== cached.mtime) { valid = false; break }
        }
        if (dirs.length && valid) return previous.files
      }
      await this.#walk(env, root.path, seen, files)
      for (const path of this.#dirs.keys()) if ((path === root.path || path.startsWith(root.path + '/')) && !seen.has(path)) this.#dirs.delete(path)
      const result = files.map(f => ({ path: f.path, size: f.size, mtime: f.mtimeMs, kind: fileKind(f.path), ...(root.treeId ? { treeId: root.treeId } : { projectId: root.projectId! }) }))
      this.#lists.set(root.path, { at: Date.now(), files: result })
      return result
    })
    this.#queue = operation.catch(() => {})
    return operation
  }

  async list(input: { query?: string; kind?: FileKind; cursor?: string; limit?: number } = {}): Promise<LibraryPage> {
    if ((input.query !== undefined && typeof input.query !== 'string') || (input.kind !== undefined && !['doc', 'image', 'data', 'code', 'other'].includes(input.kind)) || (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isFinite(input.limit)))) throw new Error('资料库筛选无效')
    let after: { mtime: number; path: string } | undefined
    if (input.cursor !== undefined) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 4000) throw new Error()
        const [mtime, path] = JSON.parse(Buffer.from(input.cursor, 'base64url').toString())
        if (typeof mtime !== 'number' || !Number.isFinite(mtime) || typeof path !== 'string') throw new Error()
        after = { mtime, path }
      } catch { throw new Error('资料库游标无效') }
    }
    const roots = await this.roots(), all = (await Promise.all(roots.map(root => this.files(root)))).flat()
    const current = new Set((await this.roots()).map(root => root.path))
    for (const path of this.#dirs.keys()) if (![...current].some(root => path === root || path.startsWith(root + '/'))) this.#dirs.delete(path)
    for (const path of this.#lists.keys()) if (!current.has(path)) this.#lists.delete(path)
    const query = (input.query ?? '').toLocaleLowerCase()
    const files = all.filter(f => current.has(f.treeId ? treeDir(f.treeId) : projectDir(f.projectId!)) && (!input.kind || input.kind === f.kind) && basename(f.path).toLocaleLowerCase().includes(query) && (!after || f.mtime < after.mtime || (f.mtime === after.mtime && f.path > after.path))).sort(compare)
    const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50))), items = files.slice(0, limit), last = items.at(-1)
    return { items, ...(files.length > limit && last && { next: Buffer.from(JSON.stringify([last.mtime, last.path])).toString('base64url') }) }
  }
}
