// Shows a host directory at a fixed virtual path, so the agent sees the same `/data/...` paths on every host and inside
// the sandbox container (roadmap-3 D6). Paths outside the mount pass through unchanged; R45's limits come on top.
import type { Context } from '@earendil-works/chord'
import {
  err,
  FileError,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileInfo,
  type FileWatcher,
  type Result,
  type ShellExecOptions,
  type WatchChange,
  type WatchTarget,
} from '@earendil-works/pi-durable/env'
import { isUnder, resolvePath } from './paths.ts'

export interface MountOptions {
  /** Virtual path the agent sees, e.g. `/data`. */
  mount: string
  /** Absolute path of the same directory in `inner`. */
  target: string
  /** Virtual working directory. */
  cwd: string
}



export class MountedEnv implements ExecutionEnv {
  readonly id: string
  cwd: string
  readonly #inner: ExecutionEnv
  readonly #mount: string
  readonly #target: string

  constructor(inner: ExecutionEnv, options: MountOptions) {
    this.#inner = inner
    this.#mount = options.mount
    this.#target = options.target
    this.cwd = options.cwd
    this.id = `${inner.id}:${options.mount}`
  }

  /** The inner path of a virtual one. */
  toInner(path: string) {
    const abs = resolvePath(this.cwd, path)
    return isUnder(abs, this.#mount) ? this.#target + abs.slice(this.#mount.length) : abs
  }

  /** The virtual path of an inner one. */
  toOuter(path: string) {
    return isUnder(path, this.#target) ? this.#mount + path.slice(this.#target.length) : path
  }

  #info = (info: FileInfo): FileInfo => ({ ...info, path: this.toOuter(info.path) })

  #error(error: FileError) {
    if (!error.path) return error
    const mapped = new FileError(error.code, error.message.split(this.#target).join(this.#mount), this.toOuter(error.path), error)
    return mapped
  }

  #map<T, E>(result: Result<T, E>, value: (v: T) => T = (v) => v): Result<T, E> {
    if (result.ok) return { ok: true, value: value(result.value) }
    return result.error instanceof FileError ? (err(this.#error(result.error) as E) as Result<T, E>) : result
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return { ok: true, value: resolvePath(this.cwd, path) }
  }

  async joinPath(parts: string[], context: Context) {
    return this.#inner.joinPath(parts, context)
  }

  async readTextFile(path: string, context: Context) {
    return this.#map(await this.#inner.readTextFile(this.toInner(path), context))
  }

  async openTextLineReader(path: string, context: Context) {
    return this.#map(await this.#inner.openTextLineReader(this.toInner(path), context))
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
    return this.#map(await this.#inner.readTextLines(this.toInner(path), options, context))
  }

  async readBinaryFile(path: string, context: Context) {
    return this.#map(await this.#inner.readBinaryFile(this.toInner(path), context))
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
    return this.#map(await this.#inner.openBinaryReader(this.toInner(path), options, context), (reader) => ({
      info: async (ctx) => this.#map(await reader.info(ctx), this.#info),
      read: async (offset, length, ctx) => this.#map(await reader.read(offset, length, ctx)),
      scanLines: async (o, ctx) => this.#map(await reader.scanLines(o, ctx)),
      close: (ctx) => reader.close(ctx),
    }))
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context) {
    return this.#map(await this.#inner.writeFile(this.toInner(path), content, context))
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context) {
    return this.#map(await this.#inner.appendFile(this.toInner(path), content, context))
  }

  async truncateFile(path: string, size: number, context: Context) {
    return this.#map(await this.#inner.truncateFile(this.toInner(path), size, context))
  }

  async flushFile(path: string, context: Context) {
    return this.#map(await this.#inner.flushFile(this.toInner(path), context))
  }

  async renameFile(source: string, destination: string, context: Context) {
    return this.#map(await this.#inner.renameFile(this.toInner(source), this.toInner(destination), context))
  }

  async fileInfo(path: string, context: Context) {
    return this.#map(await this.#inner.fileInfo(this.toInner(path), context), this.#info)
  }

  async listDir(path: string, context: Context) {
    return this.#map(await this.#inner.listDir(this.toInner(path), context), (infos) => infos.map(this.#info))
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    return this.#map(await this.#inner.openDirReader(this.toInner(path), context), (reader) => ({
      next: async (max, ctx) => this.#map(await reader.next(max, ctx), (page) => ({ ...page, entries: page.entries.map(this.#info) })),
      close: (ctx) => reader.close(ctx),
    }))
  }

  async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
    const inner = targets.map((t) => ({ ...t, path: this.toInner(t.path) }))
    const result = await this.#inner.watch(
      inner,
      (change) => onChange('paths' in change ? { paths: change.paths.map((p) => this.toOuter(p)) } : change),
      context,
    )
    return this.#map(result)
  }

  async canonicalPath(path: string, context: Context) {
    return this.#map(await this.#inner.canonicalPath(this.toInner(path), context), (p) => this.toOuter(p))
  }

  async exists(path: string, context: Context) {
    return this.#map(await this.#inner.exists(this.toInner(path), context))
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.#map(await this.#inner.createDir(this.toInner(path), options, context))
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
    return this.#map(await this.#inner.remove(this.toInner(path), options, context))
  }

  async createTempDir(prefix: string | undefined, context: Context) {
    return this.#map(await this.#inner.createTempDir(prefix, context), (p) => this.toOuter(p))
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) {
    return this.#map(await this.#inner.createTempFile(options, context), (p) => this.toOuter(p))
  }

  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) {
    return this.#inner.exec(command, { ...options, cwd: this.toInner(options?.cwd ?? this.cwd) }, context)
  }

  async cleanup(context: Context) {
    await this.#inner.cleanup(context)
  }
}
