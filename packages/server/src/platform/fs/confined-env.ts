// Linux file-descriptor paths keep a tenant's file operations inside its mount while bash changes directories.
import { FileError, err, type ExecutionEnv, type FileInfo } from '@earendil-works/pi-durable/env'
import { constants } from 'node:fs'
import { open, readdir, rmdir, unlink, mkdir, type FileHandle } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const FILE = constants.O_NOFOLLOW | constants.O_NONBLOCK
const fdPath = (file: FileHandle) => `/proc/self/fd/${file.fd}`
const denied = () => new FileError('permission_denied', '文件或符号链接超出文件隔离边界')
function parts(root: string, path: string) {
  root = resolve(root); path = resolve(path)
  if (path !== root && !path.startsWith(root + sep)) throw denied()
  return relative(root, path).split(sep).filter(Boolean)
}
async function directory(parent: FileHandle, name: string, create: boolean) {
  const path = `${fdPath(parent)}/${name}`
  if (create) await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error })
  return open(path, DIRECTORY)
}
/** The callback uses a pinned parent and a single final name. rename/unlink never follow that final name. */
export async function withConfinedParent<T>(root: string, path: string, create: boolean, fn: (path: string) => Promise<T>): Promise<T> {
  const names = parts(root, path), leaf = names.pop()
  if (!leaf) throw denied()
  let parent = await open(root, DIRECTORY)
  try {
    for (const name of names) {
      const next = await directory(parent, name, create)
      await parent.close(); parent = next
    }
    return await fn(`${fdPath(parent)}/${leaf}`)
  } finally { await parent.close() }
}
async function pin(root: string, path: string, flags: number, createParents: boolean) {
  const names = parts(root, path)
  if (!names.length) return open(root, DIRECTORY)
  return withConfinedParent(root, path, createParents, p => open(p, flags | FILE))
}
/** Also used before container mounts. No path component may be a symlink, including a dangling one. */
export async function assertConfined(root: string, path: string): Promise<void> {
  const names = parts(root, path)
  let parent = await open(root, DIRECTORY)
  try {
    for (const name of names) {
      let next: FileHandle
      try { next = await directory(parent, name, false) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw denied() }
      await parent.close(); parent = next
    }
  } finally { await parent.close() }
}
const pathMethods = new Set(['readTextFile', 'openTextLineReader', 'readTextLines', 'readBinaryFile', 'openBinaryReader', 'writeFile', 'appendFile', 'truncateFile', 'flushFile', 'renameFile', 'fileInfo', 'listDir', 'openDirReader', 'canonicalPath', 'exists', 'createDir', 'remove'])
const writes = new Set(['writeFile', 'appendFile', 'truncateFile', 'flushFile'])
const readers = new Set(['openTextLineReader', 'openBinaryReader', 'openDirReader'])
const errorOf = (error: unknown, path: string) => {
  if (error instanceof FileError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ELOOP' || code === 'ENOTDIR') return denied()
  return new FileError(code === 'ENOENT' ? 'not_found' : code === 'EISDIR' ? 'is_directory' : 'permission_denied', code === 'ENOENT' ? '文件不存在' : '文件操作失败', path)
}
// Recursion opens each directory with NOFOLLOW. Even a rename while we walk cannot redirect deletion to a link.
async function removeAt(path: string, recursive: boolean, force: boolean): Promise<void> {
  let file: FileHandle
  try { file = await open(path, DIRECTORY) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && force) return
    if (code !== 'ENOTDIR' && code !== 'ELOOP') throw error
    await unlink(path).catch(error => { if (error.code !== 'ENOENT' || !force) throw error }); return
  }
  try {
    if (recursive) for (const name of await readdir(fdPath(file))) await removeAt(`${fdPath(file)}/${name}`, true, true)
    await rmdir(path)
  } finally { await file.close() }
}
/** Below MountedEnv: virtual paths are already translated; only exec remains on the trusted host adapter. */
export function confinedEnv(inner: ExecutionEnv, root: string): ExecutionEnv {
  root = resolve(root)
  return new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (typeof property !== 'string' || !pathMethods.has(property)) return value.bind(target)
      return async (...args: any[]) => {
        const path = resolve(String(args[0]))
        try {
          parts(root, path)
          if (property === 'renameFile') {
            const result = await withConfinedParent(root, path, false, source => withConfinedParent(root, String(args[1]), false, destination => value.call(target, source, destination, args[2])))
            return result
          }
          if (property === 'remove') {
            await withConfinedParent(root, path, false, p => removeAt(p, args[1]?.recursive ?? false, args[1]?.force ?? false))
            return { ok: true, value: undefined }
          }
          if (property === 'createDir') {
            if (path === root) { const file = await open(root, DIRECTORY); await file.close(); return { ok: true, value: undefined } }
            const recursive = args[1]?.recursive ?? true
            await withConfinedParent(root, path, recursive, async p => {
              await mkdir(p).catch(error => { if (error.code !== 'EEXIST' || !recursive) throw error })
              const directory = await open(p, DIRECTORY); await directory.close()
            })
            return { ok: true, value: undefined }
          }
          // lstat does not follow the last component; pinning the parent is sufficient for metadata.
          if (property === 'fileInfo' || property === 'exists') {
            if (path === root) return value.call(target, path, ...args.slice(1))
            return await withConfinedParent(root, path, false, async p => {
              const result = await value.call(target, p, ...args.slice(1))
              return result.ok && property === 'fileInfo' ? { ok: true, value: { ...result.value, path, name: basename(path) } } : result
            })
          }
          const isDir = property === 'listDir' || property === 'openDirReader'
          const create = property === 'writeFile' || property === 'appendFile'
          const file = await pin(root, path, isDir ? DIRECTORY : writes.has(property) ? constants.O_RDWR | (create ? constants.O_CREAT : 0) : constants.O_RDONLY, create)
          let retained = false
          try {
            const info = await file.stat()
            if (!isDir && !info.isFile() && !(property === 'canonicalPath' && info.isDirectory())) throw denied()
            if (property === 'canonicalPath') return { ok: true, value: path }
            const pinned = fdPath(file)
            // The final file is already open with NOFOLLOW; the proc fd link itself is safe to follow.
            const rest = args.slice(1)
            if (property === 'openBinaryReader') rest[0] = { ...rest[0], noFollow: false }
            const result = await value.call(target, pinned, ...rest)
            const mapInfo = (info: FileInfo) => ({ ...info, path: info.path.replace(pinned, path), name: info.path === pinned ? basename(path) : info.name })
            if (!result.ok) return { ok: false, error: new FileError(result.error.code, result.error.message.replaceAll(pinned, path), path) }
            if (property === 'listDir') return { ok: true, value: result.value.map(mapInfo) }
            if (readers.has(property)) {
              const reader = result.value
              // Directory readers stat children lazily by path, so hold the pinned directory until close.
              retained = true
              return { ok: true, value: new Proxy(reader, { get(reader, key) {
                const method = Reflect.get(reader, key, reader)
                if (key === 'close') return async (...args: any[]) => { try { return await method.apply(reader, args) } finally { await file.close() } }
                if (key === 'info') return async (...args: any[]) => { const r = await method.apply(reader, args); return r.ok ? { ok: true, value: mapInfo(r.value) } : r }
                if (key === 'next') return async (...args: any[]) => { const r = await method.apply(reader, args); return r.ok ? { ok: true, value: { ...r.value, entries: r.value.entries.map(mapInfo) } } : r }
                return typeof method === 'function' ? method.bind(reader) : method
              } }) }
            }
            return result
          } finally { if (!retained) await file.close() }
        } catch (error) {
          if (property === 'exists' && (error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: false }
          if (property === 'remove' && args[1]?.force && (error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: undefined }
          return err(errorOf(error, path))
        }
      }
    },
  })
}
