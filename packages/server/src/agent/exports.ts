// Export allowlisted account data, never the database or provider/plugin credential stores.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { parseNote, projectDir, type ExportInfo, type Preferences } from '@gense/protocol'
import { Zip, ZipPassThrough, strToU8 } from 'fflate'
import { historyEntries } from './history.ts'
import { DATA_DIR, safeName, treeDir } from './workspace.ts'
import type { TreeRow } from './shared.ts'
import type { UserSpace } from './space.ts'

const EXPORT_DIR = `${DATA_DIR}/exports`
const zipPath = (id: string) => `${EXPORT_DIR}/${id}.zip`
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: Error }): T => { if (!result.ok) throw result.error; return result.value }
type Row = { id: string; status: ExportInfo['status']; size: number | null; error: string | null; createdAt: number; finishedAt: number | null }
const info = (row: Row): ExportInfo => ({ id: row.id, status: row.status, createdAt: row.createdAt, ...(row.size !== null && { size: row.size }), ...(row.error !== null && { error: row.error }), ...(row.finishedAt !== null && { finishedAt: row.finishedAt }) })
const json = (value: unknown) => strToU8(JSON.stringify(value, null, 2) + '\n')
const component = (name: string) => safeName(name).replace(/[\\:*?"<>|]/g, '_')
const relative = (root: string, path: string) => path.slice(root.length + 1).split('/').map(name => name.replace(/[%\\:\u0000-\u001f]/g, c => encodeURIComponent(c))).join('/')

function markdown(title: string, entries: EntryRecord[]) {
  const lines = [`# ${title}`, '']
  for (const entry of entries) {
    const message = entry.model?.[0]
    if (entry.kind === 'pi.user' && message?.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : message.content.flatMap(b => b.type === 'text' && !parseNote(b.text) ? [b.text] : []).join('\n')
      lines.push('## 用户', '', text, '')
    } else if (entry.kind === 'pi.assistant' && message?.role === 'assistant' && !['aborted', 'error'].includes(message.stopReason)) {
      const parts = message.content.flatMap(b => b.type === 'text' ? [b.text] : b.type === 'toolCall' ? [`工具：${b.name}`] : [])
      if (parts.length) lines.push('## 助手', '', parts.join('\n\n'), '')
    }
  }
  return strToU8(lines.join('\n'))
}

/** Bounded file reads and output writes; a large workspace never becomes one in-memory zip. */
class Archive {
  readonly #env: ExecutionEnv
  readonly #zip: Zip
  #pending: Promise<void> = Promise.resolve()
  #failure: unknown
  #size = 0
  #entries = 0
  constructor(env: ExecutionEnv, path: string) {
    this.#env = env
    this.#zip = new Zip((error, bytes) => {
      if (error) { this.#failure = error; return }
      this.#size += bytes.length
      if (this.#size >= 0xffff_ffff) { this.#failure = new Error('导出超过 ZIP 的 4 GiB 上限，请减少文件后重试'); return }
      this.#pending = this.#pending.then(async () => { unwrap(await env.appendFile(path, bytes, ctx)) })
      // Keep callback failures handled until the producer reaches drain().
      void this.#pending.catch(() => {})
    })
  }
  async #drain() { await this.#pending; if (this.#failure) throw this.#failure }
  #entry(name: string) {
    if (++this.#entries > 65535) throw new Error('导出超过 ZIP 的 65535 个文件上限，请减少文件后重试')
    const file = new ZipPassThrough(name)
    this.#zip.add(file)
    return file
  }
  async bytes(name: string, bytes: Uint8Array) {
    const file = this.#entry(name)
    file.push(bytes, true)
    await this.#drain()
  }
  async file(name: string, path: string, signal: AbortSignal) {
    const reader = unwrap(await this.#env.openBinaryReader(path, { noFollow: true }, ctx))
    try {
      const size = unwrap(await reader.info(ctx)).size
      if (size >= 0xffff_ffff) throw new Error('导出超过 ZIP 的 4 GiB 上限，请减少文件后重试')
      const file = this.#entry(name)
      let at = 0
      while (at < size) {
        signal.throwIfAborted()
        const bytes = unwrap(await reader.read(at, Math.min(512 * 1024, size - at), ctx))
        if (!bytes.length) throw new Error('导出时文件发生变化，请重试')
        at += bytes.length; file.push(bytes, at === size)
        await this.#drain()
      }
      if (!size) { file.push(new Uint8Array(), true); await this.#drain() }
    } finally { await reader.close(ctx) }
  }
  async end() { this.#zip.end(); await this.#drain() }
  stop() { this.#zip.terminate() }
}

export class ExportStore {
  readonly #space: UserSpace
  readonly #listeners = new Set<(exports: ExportInfo[]) => void>()
  readonly #jobs = new Map<string, { abort: AbortController; done: Promise<void> }>()
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false
  constructor(space: UserSpace) { this.#space = space }
  subscribe(fn: (exports: ExportInfo[]) => void) { this.#listeners.add(fn); return () => { this.#listeners.delete(fn) } }
  async list() { return (await this.#space.db.all<Row>('SELECT * FROM exports ORDER BY createdAt DESC, rowid DESC')).map(info) }
  #serial<T>(fn: () => Promise<T>) { const operation = this.#queue.then(fn); this.#queue = operation.catch(() => {}); return operation }
  async #publish() { const exports = await this.list(); for (const listener of this.#listeners) listener(exports) }
  async initialize() {
    await this.#space.db.run("UPDATE exports SET status = 'failed', error = '导出因服务器重启中断，请重试', finishedAt = ? WHERE status = 'running'", this.#space.now())
    const env = await this.#space.workspace.env(DATA_DIR)
    unwrap(await env.createDir(EXPORT_DIR, { recursive: true }, ctx))
    const files = unwrap(await env.listDir(EXPORT_DIR, ctx)), keep = new Set((await this.list()).filter(e => e.status === 'ready').map(e => e.id + '.zip'))
    for (const file of files) if (file.kind === 'file' && !keep.has(file.name)) unwrap(await env.remove(file.path, { force: true }, ctx))
    await this.#prune(env)
  }
  create(): Promise<ExportInfo> {
    return this.#serial(async () => {
      if (this.#closed) throw new Error('用户空间已关闭')
      if (await this.#space.db.get("SELECT id FROM exports WHERE status = 'running'")) throw new Error('已有一个导出在进行')
      const value: ExportInfo = { id: crypto.randomUUID(), status: 'running', createdAt: this.#space.now() }
      await this.#space.db.run('INSERT INTO exports (id, status, createdAt) VALUES (?, ?, ?)', value.id, value.status, value.createdAt)
      const abort = new AbortController()
      const done = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.#build(value.id, abort.signal)).finally(() => this.#jobs.delete(value.id))
      this.#jobs.set(value.id, { abort, done })
      await this.#prune(await this.#space.workspace.env(DATA_DIR)); await this.#publish()
      return value
    })
  }

  async #prune(env: ExecutionEnv) {
    for (const old of (await this.list()).slice(3)) {
      if (old.status === 'running') continue
      unwrap(await env.remove(zipPath(old.id), { force: true }, ctx))
      await this.#space.db.run('DELETE FROM exports WHERE id = ?', old.id)
    }
  }

  async #build(id: string, signal: AbortSignal) {
    const { db, library } = this.#space, env = await this.#space.workspace.env(DATA_DIR), path = zipPath(id), temporary = path + '.tmp'
    let archive: Archive | undefined
    try {
      unwrap(await env.writeFile(temporary, new Uint8Array(), ctx))
      archive = new Archive(env, temporary)
      const trees = await db.all<TreeRow>('SELECT * FROM trees WHERE expiresAt IS NULL ORDER BY createdAt, id')
      const projects = await this.#space.projects.list(), names = new Set<string>()
      const unique = (prefix: string, name: string) => { let path = prefix + name, n = 2; while (names.has(path)) path = prefix + name + ` (${n++})`; names.add(path); return path }
      for (const tree of trees) {
        signal.throwIfAborted()
        if (!await db.get('SELECT id FROM trees WHERE id = ? AND expiresAt IS NULL', tree.id)) throw new Error('导出时对话发生变化，请重试')
        const folder = unique('conversations/', `${new Date(tree.createdAt).toISOString().slice(0, 10)}-${component(tree.title)}`)
        const branch = await this.#space.mainBranch(tree.id), entries = await historyEntries(await this.#space.open(branch, ctx), ctx)
        await archive.bytes(folder + '/conversation.md', markdown(tree.title, entries))
        for (const file of await library.files({ path: treeDir(tree.id), treeId: tree.id })) await archive.file(folder + '/files/' + relative(treeDir(tree.id), file.path), file.path, signal)
      }
      for (const project of projects) {
        signal.throwIfAborted()
        const folder = unique('projects/', component(project.name))
        await archive.bytes(folder + '/project.json', json(project))
        for (const file of await library.files({ path: projectDir(project.id), projectId: project.id })) await archive.file(folder + '/files/' + relative(projectDir(project.id), file.path), file.path, signal)
      }
      await archive.bytes('memories.json', json(await this.#space.memories.list()))
      const prefs = this.#space.preferences.get(), allowed: (keyof Preferences)[] = ['name', 'instructions', 'timeZone', 'useMemory', 'memoryWrites', 'suggestions', 'deepseekSafety']
      await archive.bytes('preferences.json', json(Object.fromEntries(allowed.filter(key => prefs[key] !== undefined).map(key => [key, prefs[key]]))))
      signal.throwIfAborted()
      await archive.end()
      unwrap(await env.renameFile(temporary, path, ctx))
      const size = unwrap(await env.fileInfo(path, ctx)).size
      // Validate and publish in one database transaction: deletion cannot slip between the last check and ready.
      await db.transaction(async tx => {
        for (const tree of trees) if (!await tx.get('SELECT id FROM trees WHERE id = ? AND expiresAt IS NULL', tree.id)) throw new Error('导出时对话发生变化，请重试')
        for (const project of projects) if (!await tx.get('SELECT id FROM projects WHERE id = ?', project.id)) throw new Error('导出时项目发生变化，请重试')
        signal.throwIfAborted()
        await tx.run("UPDATE exports SET status = 'ready', size = ?, finishedAt = ? WHERE id = ?", size, this.#space.now(), id)
      })
    } catch (error) {
      archive?.stop()
      await env.remove(temporary, { force: true }, ctx); await env.remove(path, { force: true }, ctx)
      await db.run("UPDATE exports SET status = 'failed', error = ?, finishedAt = ? WHERE id = ?", signal.aborted ? '导出已取消' : error instanceof Error ? error.message : '导出失败', this.#space.now(), id)
    }
    await this.#prune(env); await this.#publish()
  }

  remove(id: string) {
    return this.#serial(async () => {
      if (!await this.#space.db.get('SELECT id FROM exports WHERE id = ?', id)) throw new Error('导出不存在')
      const job = this.#jobs.get(id)
      if (job) { job.abort.abort(); await job.done }
      const env = await this.#space.workspace.env(DATA_DIR)
      unwrap(await env.remove(zipPath(id), { force: true }, ctx))
      await this.#space.db.run('DELETE FROM exports WHERE id = ?', id)
      await this.#publish()
    })
  }

  async download(id: string): Promise<Response> {
    const row = await this.#space.db.get<Row>("SELECT * FROM exports WHERE id = ? AND status = 'ready'", id)
    if (!row) return new Response(null, { status: 404 })
    const env = await this.#space.workspace.env(DATA_DIR), opened = await env.openBinaryReader(zipPath(id), { noFollow: true }, ctx)
    if (!opened.ok) return new Response(null, { status: 404 })
    const reader = opened.value
    let offset = 0, closed = false
    const close = async () => { if (!closed) { closed = true; await reader.close(ctx) } }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const bytes = unwrap(await reader.read(offset, 512 * 1024, ctx))
          if (!bytes.length) { await close(); controller.close() }
          else { offset += bytes.length; controller.enqueue(bytes) }
        } catch (error) { await close(); controller.error(error) }
      },
      cancel: close,
    })
    return new Response(stream, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="gense-export-${new Date(row.createdAt).toISOString().slice(0, 10)}.zip"`, 'cache-control': 'no-store' } })
  }

  async close() {
    this.#closed = true
    await this.#queue
    for (const job of this.#jobs.values()) job.abort.abort()
    await Promise.all([...this.#jobs.values()].map(job => job.done))
    this.#listeners.clear()
  }
}
