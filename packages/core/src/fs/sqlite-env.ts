// An ExecutionEnv whose files live in SQLite, for hosts without a disk (Cloudflare Durable Objects). No shell, no watch.
import type { Context } from '@earendil-works/chord/context'
import { applySqliteMigrations, type SqliteDatabase, type SqliteExecutor } from '@earendil-works/chord/sqlite'
import {
  err,
  ExecutionError,
  FileError,
  LineScanner,
  ok,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileInfo,
  type FileKind,
  type FileWatcher,
  type LineScan,
  type Result,
  type ShellExecResult,
  type TextLine,
  type TextLineReader,
} from '@earendil-works/pi-durable/env'
import { basename, dirname, isUnder, joinPaths, resolvePath } from './paths.ts'

// `parent` lets a directory list its entries through an index; `/` has parent ''. A file's bytes are in `fs_chunks`
// under the entry's rowid, which a rename keeps: Durable Object SQLite caps one BLOB at 2 MB.
const migrations = [
  {
    version: 1,
    statements: [
      'CREATE TABLE fs_entries (path TEXT PRIMARY KEY, parent TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, mtimeMs INTEGER NOT NULL)',
      'CREATE INDEX fs_entries_parent ON fs_entries (parent, path)',
      'CREATE TABLE fs_chunks (file INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (file, idx))',
      'CREATE TRIGGER fs_entries_delete AFTER DELETE ON fs_entries BEGIN DELETE FROM fs_chunks WHERE file = old.rowid; END',
    ],
  },
]

const CHUNK = 1024 * 1024

const META = 'path, kind, size, mtimeMs'

interface Row {
  path: string
  kind: 'file' | 'directory'
  size: number | bigint
  mtimeMs: number | bigint
}

interface DataRow extends Row {
  id: number | bigint
}

const DATA_ROW = `SELECT rowid AS id, ${META} FROM fs_entries WHERE path = ?`

const encoder = new TextEncoder()
const parentOf = (path: string) => (path === '/' ? '' : dirname(path))
const bytesOf = (content: string | Uint8Array) => (typeof content === 'string' ? encoder.encode(content) : content)
// node:sqlite returns Uint8Array, D1/DO storage ArrayBuffer; an empty blob may come back as NULL.
const toBytes = (data: Uint8Array | ArrayBuffer | null) => (data === null ? new Uint8Array(0) : data instanceof Uint8Array ? data : new Uint8Array(data))

async function readData(ex: SqliteExecutor, row: DataRow) {
  const chunks = await ex.all<{ data: Uint8Array | ArrayBuffer | null }>('SELECT data FROM fs_chunks WHERE file = ? ORDER BY idx', row.id)
  const out = new Uint8Array(Number(row.size))
  let at = 0
  for (const c of chunks) {
    const bytes = toBytes(c.data)
    out.set(bytes, at)
    at += bytes.length
  }
  return out
}
/** SQLite `substr` counts characters, JS `length` UTF-16 units. */
const charCount = (s: string) => [...s].length

const info = (row: Row): FileInfo => ({ name: basename(row.path), path: row.path, kind: row.kind as FileKind, size: Number(row.size), mtimeMs: Number(row.mtimeMs) })

/** Bounds of the rows strictly below directory `path` (not `/`): `'/'` sorts right before `'0'`. */
const below = (path: string): [string, string] => [`${path}/`, `${path}0`]

function aborted(context: Context, path?: string) {
  return context.abortSignal?.aborted ? new FileError('aborted', 'aborted', path) : undefined
}

function toFileError(error: unknown, path?: string) {
  if (error instanceof FileError) return error
  const cause = error instanceof Error ? error : new Error(String(error))
  return new FileError('unknown', cause.message, path, cause)
}

/** Runs `fn`, turning a thrown `FileError` (or anything else, as `unknown`) into a failed result. */
async function attempt<T>(path: string | undefined, context: Context, fn: () => Promise<T>): Promise<Result<T, FileError>> {
  const stop = aborted(context, path)
  if (stop) return err(stop)
  if (path?.includes('\0')) return err(new FileError('invalid', 'Path contains a NUL byte', path))
  try {
    return ok(await fn())
  } catch (error) {
    return err(toFileError(error, path))
  }
}

const notFound = (path: string) => new FileError('not_found', `No such file or directory: ${path}`, path)
const notDirectory = (path: string) => new FileError('not_directory', `Not a directory: ${path}`, path)
const isDirectory = (path: string) => new FileError('is_directory', `Is a directory: ${path}`, path)
const closed = (what: string, path: string) => err<never, FileError>(new FileError('invalid', `${what} is closed`, path))

const entry = (ex: SqliteExecutor, path: string) => ex.get<Row>(`SELECT ${META} FROM fs_entries WHERE path = ?`, path)

/** The error for a path that has no row: `not_directory` when an ancestor is a file, as POSIX reports it. */
async function missing(ex: SqliteExecutor, path: string) {
  for (let dir = parentOf(path); dir; dir = parentOf(dir)) {
    const row = await entry(ex, dir)
    if (row) return row.kind === 'file' ? notDirectory(path) : notFound(path)
  }
  return notFound(path)
}

async function existing(ex: SqliteExecutor, path: string) {
  const row = await entry(ex, path)
  if (!row) throw await missing(ex, path)
  return row
}

/** Creates the missing ancestors of `path` as directories. */
async function ensureParents(ex: SqliteExecutor, path: string, now: number) {
  const parent = parentOf(path)
  if (!parent) return
  const row = await entry(ex, parent)
  if (row?.kind === 'directory') return
  if (row) throw notDirectory(path)
  await ensureParents(ex, parent, now)
  await ex.run('INSERT INTO fs_entries (path, parent, kind, size, mtimeMs) VALUES (?, ?, ?, 0, ?)', parent, parentOf(parent), 'directory', now)
}

async function putFile(ex: SqliteExecutor, path: string, data: Uint8Array, now: number) {
  await ex.run(
    'INSERT INTO fs_entries (path, parent, kind, size, mtimeMs) VALUES (?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET size = excluded.size, mtimeMs = excluded.mtimeMs',
    path,
    parentOf(path),
    'file',
    data.length,
    now,
  )
  const { id } = (await ex.get<{ id: number | bigint }>('SELECT rowid AS id FROM fs_entries WHERE path = ?', path))!
  await ex.run('DELETE FROM fs_chunks WHERE file = ?', id)
  for (let i = 0; i * CHUNK < data.length; i++) await ex.run('INSERT INTO fs_chunks (file, idx, data) VALUES (?, ?, ?)', id, i, data.subarray(i * CHUNK, (i + 1) * CHUNK))
}

export interface SqliteFilesOptions {
  /** Namespace id of every env over this database; see `FileSystem.id`. */
  id: string
  now?: () => number
}

/** One file tree in a SQLite database. Make a cheap `env` per call, each with its own `cwd`. */
export class SqliteFiles {
  readonly db: SqliteDatabase
  readonly id: string
  readonly now: () => number

  private constructor(db: SqliteDatabase, options: SqliteFilesOptions) {
    this.db = db
    this.id = options.id
    this.now = options.now ?? Date.now
  }

  static async open(db: SqliteDatabase, options: SqliteFilesOptions) {
    await applySqliteMigrations(db, migrations, { table: 'fs_migrations' })
    const files = new SqliteFiles(db, options)
    await db.run(`INSERT OR IGNORE INTO fs_entries (path, parent, kind, size, mtimeMs) VALUES ('/', '', 'directory', 0, ?)`, files.now())
    return files
  }

  /** An environment over these files; `cwd` is not created. */
  env(options: { cwd: string }) {
    return new SqliteExecutionEnv(this, options.cwd)
  }
}

export class SqliteExecutionEnv implements ExecutionEnv {
  readonly id: string
  cwd: string
  #files: SqliteFiles

  constructor(files: SqliteFiles, cwd: string) {
    this.#files = files
    this.id = files.id
    this.cwd = resolvePath('/', cwd)
  }

  get #db() {
    return this.#files.db
  }

  #resolve(path: string) {
    return resolvePath(this.cwd, path)
  }

  async #readFile(path: string) {
    const row = await this.#db.get<DataRow>(DATA_ROW, path)
    if (!row) throw await missing(this.#db, path)
    if (row.kind === 'directory') throw isDirectory(path)
    return row
  }

  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return ok(this.#resolve(path))
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return ok(joinPaths(parts))
  }

  async readTextFile(path: string, context: Context) {
    const resolved = this.#resolve(path)
    // Like Node's readFile(..., 'utf8'), which keeps a byte-order mark.
    return attempt(resolved, context, async () => new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(await readData(this.#db, await this.#readFile(resolved))))
  }

  async readBinaryFile(path: string, context: Context) {
    const resolved = this.#resolve(path)
    return attempt(resolved, context, async () => await readData(this.#db, await this.#readFile(resolved)))
  }

  async openTextLineReader(path: string, context: Context) {
    const resolved = this.#resolve(path)
    return attempt<TextLineReader>(resolved, context, async () => new SqliteTextLineReader(resolved, await readData(this.#db, await this.#readFile(resolved))))
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([])
    const opened = await this.openTextLineReader(path, context)
    if (!opened.ok) return opened
    const lines: string[] = []
    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context)
        if (!line.ok) return line
        if (line.value === undefined) break
        lines.push(line.value.text)
      }
      return ok(lines)
    } finally {
      await opened.value.close(context)
    }
  }

  async openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context) {
    const resolved = this.#resolve(path)
    // There are no symbolic links, so `noFollow` changes nothing.
    return attempt<BinaryReader>(resolved, context, async () => {
      const row = await this.#readFile(resolved)
      return new SqliteBinaryReader({ ...info(row), path: resolved }, await readData(this.#db, row))
    })
  }

  async writeFile(path: string, content: string | Uint8Array, context: Context) {
    const resolved = this.#resolve(path)
    return attempt(resolved, context, () =>
      this.#db.transaction(async (tx) => {
        if ((await entry(tx, resolved))?.kind === 'directory') throw isDirectory(resolved)
        const now = this.#files.now()
        await ensureParents(tx, resolved, now)
        await putFile(tx, resolved, bytesOf(content), now)
      }),
    )
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context) {
    const resolved = this.#resolve(path)
    return attempt(resolved, context, () =>
      this.#db.transaction(async (tx) => {
        const row = await tx.get<DataRow>(DATA_ROW, resolved)
        if (row?.kind === 'directory') throw isDirectory(resolved)
        const now = this.#files.now()
        if (!row) await ensureParents(tx, resolved, now)
        const before = row ? await readData(tx, row) : new Uint8Array(0)
        const added = bytesOf(content)
        const data = new Uint8Array(before.length + added.length)
        data.set(before)
        data.set(added, before.length)
        await putFile(tx, resolved, data, now)
      }),
    )
  }

  async truncateFile(path: string, size: number, context: Context) {
    const resolved = this.#resolve(path)
    if (!Number.isSafeInteger(size) || size < 0) return err<void, FileError>(new FileError('invalid', 'File size must be a non-negative safe integer', resolved))
    return attempt(resolved, context, () =>
      this.#db.transaction(async (tx) => {
        const row = await tx.get<DataRow>(DATA_ROW, resolved)
        if (!row) throw await missing(tx, resolved)
        if (row.kind === 'directory') throw isDirectory(resolved)
        const data = new Uint8Array(size)
        const before = await readData(tx, row)
        data.set(before.length > size ? before.subarray(0, size) : before)
        await putFile(tx, resolved, data, this.#files.now())
      }),
    )
  }

  async flushFile(path: string, context: Context) {
    const resolved = this.#resolve(path)
    // Every write is committed before it returns.
    return attempt(resolved, context, async () => {
      if ((await existing(this.#db, resolved)).kind === 'directory') throw isDirectory(resolved)
    })
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context) {
    const source = this.#resolve(sourcePath)
    const destination = this.#resolve(destinationPath)
    if (destination.includes('\0')) return err<void, FileError>(new FileError('invalid', 'Path contains a NUL byte', destination))
    return attempt(source, context, () =>
      this.#db.transaction(async (tx) => {
        const from = await existing(tx, source)
        if (source === destination) return
        if (source === '/' || destination === '/') throw new FileError('invalid', 'Cannot rename the root directory', source)
        if (isUnder(destination, source)) throw new FileError('invalid', `Cannot move ${source} into itself`, destination)
        const parent = await entry(tx, dirname(destination))
        if (!parent) throw await missing(tx, dirname(destination))
        if (parent.kind !== 'directory') throw notDirectory(destination)
        const to = await entry(tx, destination)
        if (to) {
          if (from.kind === 'file' && to.kind === 'directory') throw isDirectory(destination)
          if (from.kind === 'directory' && to.kind === 'file') throw notDirectory(destination)
          if (to.kind === 'directory' && (await tx.get('SELECT 1 FROM fs_entries WHERE parent = ? LIMIT 1', destination))) {
            throw new FileError('invalid', `Directory not empty: ${destination}`, destination)
          }
          await tx.run('DELETE FROM fs_entries WHERE path = ?', destination)
        }
        await tx.run('UPDATE fs_entries SET path = ?, parent = ? WHERE path = ?', destination, dirname(destination), source)
        if (from.kind === 'directory') {
          const tail = charCount(source) + 1
          await tx.run(
            'UPDATE fs_entries SET path = ? || substr(path, ?), parent = ? || substr(parent, ?) WHERE path >= ? AND path < ?',
            destination,
            tail,
            destination,
            tail,
            ...below(source),
          )
        }
      }),
    )
  }

  async fileInfo(path: string, context: Context) {
    const resolved = this.#resolve(path)
    return attempt(resolved, context, async () => info(await existing(this.#db, resolved)))
  }

  async listDir(path: string, context: Context) {
    const resolved = this.#resolve(path)
    return attempt(resolved, context, async () => {
      if ((await existing(this.#db, resolved)).kind !== 'directory') throw notDirectory(resolved)
      return (await this.#db.all<Row>(`SELECT ${META} FROM fs_entries WHERE parent = ? ORDER BY path`, resolved)).map(info)
    })
  }

  async openDirReader(path: string, context: Context) {
    const resolved = this.#resolve(path)
    return attempt<DirReader>(resolved, context, async () => {
      if ((await existing(this.#db, resolved)).kind !== 'directory') throw notDirectory(resolved)
      return new SqliteDirReader(this.#db, resolved)
    })
  }

  async watch(): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError('not_supported', 'This environment cannot watch files'))
  }

  async canonicalPath(path: string, context: Context) {
    const resolved = this.#resolve(path)
    return attempt(resolved, context, async () => (await existing(this.#db, resolved)).path)
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path, context)
    if (result.ok) return ok(true)
    return result.error.code === 'not_found' ? ok(false) : err(result.error)
  }

  async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    const resolved = this.#resolve(path)
    const recursive = options?.recursive ?? true
    return attempt(resolved, context, () =>
      this.#db.transaction(async (tx) => {
        const row = await entry(tx, resolved)
        if (row?.kind === 'directory' && recursive) return
        if (row) throw new FileError('invalid', `File exists: ${resolved}`, resolved)
        const now = this.#files.now()
        if (recursive) await ensureParents(tx, resolved, now)
        else if ((await existing(tx, dirname(resolved))).kind !== 'directory') throw notDirectory(resolved)
        await tx.run('INSERT INTO fs_entries (path, parent, kind, size, mtimeMs) VALUES (?, ?, ?, 0, ?)', resolved, dirname(resolved), 'directory', now)
      }),
    )
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
    const resolved = this.#resolve(path)
    return attempt(resolved, context, () =>
      this.#db.transaction(async (tx) => {
        const row = await entry(tx, resolved)
        if (!row) {
          if (options?.force) return
          throw await missing(tx, resolved)
        }
        if (resolved === '/') throw new FileError('invalid', 'Cannot remove the root directory', resolved)
        if (row.kind === 'directory') {
          if (!options?.recursive) throw isDirectory(resolved)
          await tx.run('DELETE FROM fs_entries WHERE path >= ? AND path < ?', ...below(resolved))
        }
        await tx.run('DELETE FROM fs_entries WHERE path = ?', resolved)
      }),
    )
  }

  async createTempDir(prefix: string | undefined, context: Context) {
    return attempt(undefined, context, () =>
      this.#db.transaction(async (tx) => {
        const now = this.#files.now()
        // Like mkdtemp: six random characters after the prefix.
        const path = resolvePath('/tmp', `${prefix ?? 'tmp-'}${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`)
        if (await entry(tx, path)) throw new FileError('invalid', `File exists: ${path}`, path)
        await ensureParents(tx, path, now)
        await tx.run('INSERT INTO fs_entries (path, parent, kind, size, mtimeMs) VALUES (?, ?, ?, 0, ?)', path, dirname(path), 'directory', now)
        return path
      }),
    )
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir('tmp-', context)
    if (!dir.ok) return dir
    const path = `${dir.value}/${options?.prefix ?? ''}${crypto.randomUUID()}${options?.suffix ?? ''}`
    const written = await this.writeFile(path, new Uint8Array(0), context)
    return written.ok ? ok(path) : written
  }

  async exec(_command: string | readonly string[], _options: unknown, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError('aborted', 'aborted'))
    return err(new ExecutionError('shell_unavailable', 'This environment has no shell'))
  }

  async cleanup(_context: Context) {}
}

/** Lines of the file as it was when opened. */
class SqliteTextLineReader implements TextLineReader {
  #path: string
  #text: string | undefined
  #position = 0

  constructor(path: string, bytes: Uint8Array) {
    this.#path = path
    // What decoding the file chunk by chunk with a byte-order-mark-dropping decoder yields.
    this.#text = new TextDecoder().decode(bytes)
  }

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    const stop = aborted(context, this.#path)
    if (stop) return err(stop)
    const text = this.#text
    if (text === undefined) return closed('Text line reader', this.#path)
    if (this.#position >= text.length) return ok(undefined)
    const newline = text.indexOf('\n', this.#position)
    const end = newline === -1 ? text.length : newline
    const line = { text: text.slice(this.#position, end), terminated: newline !== -1 }
    this.#position = end + 1
    return ok(line)
  }

  async close(_context: Context) {
    this.#text = undefined
  }
}

/** Reads the bytes the file had when opened, whatever happens to its path afterwards. */
class SqliteBinaryReader implements BinaryReader {
  #info: FileInfo
  #bytes: Uint8Array | undefined

  constructor(info: FileInfo, bytes: Uint8Array) {
    this.#info = info
    this.#bytes = bytes
  }

  #check(context: Context) {
    const stop = aborted(context, this.#info.path)
    if (stop) return err<never, FileError>(stop)
    return this.#bytes ? undefined : closed('Binary reader', this.#info.path)
  }

  async info(context: Context): Promise<Result<FileInfo, FileError>> {
    return this.#check(context) ?? ok({ ...this.#info })
  }

  async read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    const failed = this.#check(context)
    if (failed) return failed
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      return err(new FileError('invalid', 'Offset and length must be non-negative safe integers', this.#info.path))
    }
    return ok(this.#bytes!.slice(offset, offset + length))
  }

  async scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>> {
    const failed = this.#check(context)
    if (failed) return failed
    let scanner: LineScanner
    try {
      scanner = new LineScanner(options.startLine, options.endLine)
    } catch {
      return err(new FileError('invalid', 'Invalid line range', this.#info.path))
    }
    scanner.push(this.#bytes!)
    return ok(scanner.finish())
  }

  async close(_context: Context) {
    this.#bytes = undefined
  }
}

/** Pages a directory's entries in path order, so entries removed after opening are skipped. */
class SqliteDirReader implements DirReader {
  #db: SqliteDatabase
  #path: string
  #after = ''
  #done = false
  #closed = false

  constructor(db: SqliteDatabase, path: string) {
    this.#db = db
    this.#path = path
  }

  async next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const stop = aborted(context, this.#path)
    if (stop) return err(stop)
    if (this.#closed) return closed('Directory reader', this.#path)
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      return err(new FileError('invalid', 'maxEntries must be a positive safe integer', this.#path))
    }
    if (this.#done) return ok({ entries: [], done: true })
    return attempt(this.#path, context, async () => {
      const sql = `SELECT ${META} FROM fs_entries WHERE parent = ? AND path > ? ORDER BY path LIMIT ?`
      const rows = await this.#db.all<Row>(sql, this.#path, this.#after, maxEntries + 1)
      const page = rows.slice(0, maxEntries)
      this.#done = rows.length <= maxEntries
      if (page.length > 0) this.#after = page.at(-1)!.path
      return { entries: page.map(info), done: this.#done }
    })
  }

  async close(_context: Context) {
    this.#closed = true
  }
}
