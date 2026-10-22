import { Workspace, type EagerMount } from '@cloudflare/computer'
import type { WorkspaceFile } from '../src/types'
import { parseSkill, type SkillDoc } from '../src/skills'

// Per-chat workspace (roadmap-2 "L0-6 会话工作区"): Think's Workspace in the chat's own SQLite.
// /workspace is the chat's read-write home; /skills is a read-only mount of the user's shared
// skills; /workspace/skills/<name>/SKILL.md are skills that only this chat sees and may edit.

export const HOME = '/workspace'
export const SKILLS_ROOT = '/skills'
export const LOCAL_SKILLS = `${HOME}/skills`
/** Think's file tools, offered in every turn of a model that can call tools. */
export const WORKSPACE_TOOLS = ['read', 'ls', 'find', 'grep', 'write', 'edit', 'delete']

/** Files listed in the file panel. */
const MAX_LISTED = 500
/** Bytes of a file shown in the preview. */
const PREVIEW_BYTES = 200_000
/** Largest file served for download. */
const MAX_DOWNLOAD = 20 * 1024 * 1024
/** Bytes of workspace files copied into a fork or side thread. */
const MAX_COPY = 16 * 1024 * 1024
const MAX_LOCAL_SKILLS = 30

/** One file of the /skills mount, relative to it. */
export interface BundleFile {
  path: string
  text: string
}

type Fs = Workspace['fs']

/**
 * The /skills mount. It is filled once per `version`; `files` failing must not fail every
 * file operation, so the mount then holds a README with the error and `onError` runs.
 */
export function openWorkspace(storage: DurableObjectStorage, version: string, files: () => Promise<BundleFile[]>, onError: () => void) {
  const mount: EagerMount = {
    kind: 'gense-skills',
    mode: 'read-only',
    strategy: 'eager',
    version,
    async materialize(api) {
      let list: BundleFile[]
      try {
        list = await files()
      } catch (e) {
        onError()
        list = [{ path: 'README.md', text: `Skills 暂时没有加载：${e instanceof Error ? e.message : String(e)}\n` }]
      }
      for (const f of list) await api.writeFile(`${api.root}/${f.path}`, new Blob([f.text]).stream())
    },
  }
  return new Workspace({ storage, mounts: { [SKILLS_ROOT]: mount } })
}

/** Absolute, normalized path; `..` cannot climb above the root. */
export function normalize(path: string) {
  const parts: string[] = []
  for (const p of path.split('/')) {
    if (!p || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return '/' + parts.join('/')
}

const under = (path: string, root: string) => path === root || path.startsWith(root + '/')
export const isReadOnly = (path: string) => under(path, SKILLS_ROOT)
const isListed = (path: string) => under(path, HOME) || isReadOnly(path)

/** Files under /workspace and /skills, breadth first, at most MAX_LISTED. */
export async function listFiles(fs: Fs): Promise<WorkspaceFile[]> {
  const out: WorkspaceFile[] = []
  const queue = [HOME, SKILLS_ROOT]
  while (queue.length && out.length < MAX_LISTED) {
    const dir = queue.shift()!
    const entries = await fs.readdir(dir).catch(() => [])
    for (const e of entries) {
      const path = `${dir}/${e.name}`
      if (e.isDirectory) queue.push(path)
      else if (e.isFile && out.length < MAX_LISTED) out.push({ path, size: e.size, mtime: e.mtime, readOnly: isReadOnly(path) })
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** The start of a file for the preview; `binary` when it is not UTF-8 text. */
export async function previewFile(fs: Fs, path: string): Promise<{ text: string; size: number; truncated: boolean; binary: boolean }> {
  const p = normalize(path)
  if (!isListed(p)) throw new Error('只能查看工作区里的文件')
  const stat = await fs.stat(p)
  if (!stat.isFile) throw new Error('不是文件')
  const head = await fs.readFile(p, { byteLength: PREVIEW_BYTES })
  const bytes = new Uint8Array(await new Response(head).arrayBuffer())
  try {
    // A multi-byte character cut at the end is not a sign of binary content.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes, { stream: stat.size > PREVIEW_BYTES })
    if (text.includes('\0')) throw new Error('binary')
    return { text, size: stat.size, truncated: stat.size > PREVIEW_BYTES, binary: false }
  } catch {
    return { text: '', size: stat.size, truncated: false, binary: true }
  }
}

export async function fileBytes(fs: Fs, path: string): Promise<{ name: string; bytes: ArrayBuffer } | null> {
  const p = normalize(path)
  if (!isListed(p)) return null
  const stat = await fs.stat(p).catch(() => null)
  if (!stat?.isFile) return null
  if (stat.size > MAX_DOWNLOAD) throw new Error('文件超过 20 MB，不能下载')
  return { name: p.slice(p.lastIndexOf('/') + 1), bytes: await new Response(await fs.readFile(p)).arrayBuffer() }
}

export async function deleteFile(fs: Fs, path: string) {
  const p = normalize(path)
  if (!under(p, HOME) || p === HOME) throw new Error('只能删除 /workspace 里的文件')
  await fs.rm(p, { recursive: true, force: true })
}

/** /workspace files for a fork; files past MAX_COPY bytes are left out and named in `skipped`. */
export async function exportFiles(fs: Fs): Promise<{ files: { path: string; bytes: ArrayBuffer }[]; skipped: string[] }> {
  const files: { path: string; bytes: ArrayBuffer }[] = []
  const skipped: string[] = []
  let total = 0
  for (const f of await listFiles(fs)) {
    if (f.readOnly) continue
    if (total + f.size > MAX_COPY) {
      skipped.push(f.path)
      continue
    }
    total += f.size
    files.push({ path: f.path, bytes: await new Response(await fs.readFile(f.path)).arrayBuffer() })
  }
  return { files, skipped }
}

export async function importFiles(fs: Fs, files: { path: string; bytes: ArrayBuffer }[]) {
  for (const f of files) {
    const p = normalize(f.path)
    if (!under(p, HOME)) continue
    await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true })
    await fs.writeFile(p, new Uint8Array(f.bytes))
  }
}

/** Skills of this chat: /workspace/skills/<folder>/SKILL.md with valid front matter. */
export async function localSkills(fs: Fs): Promise<(SkillDoc & { path: string })[]> {
  const dirs = (await fs.readdir(LOCAL_SKILLS).catch(() => [])).filter((e) => e.isDirectory).slice(0, MAX_LOCAL_SKILLS)
  const found = await Promise.all(
    dirs.map(async (d) => {
      const path = `${LOCAL_SKILLS}/${d.name}/SKILL.md`
      const doc = parseSkill(await fs.readFile(path, 'utf8').catch(() => ''))
      return doc && { ...doc, path }
    }),
  )
  return found.filter((s) => !!s)
}
