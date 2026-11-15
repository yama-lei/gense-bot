// Roadmap-7 A7–A11: project metadata and read-only reference files, all in one UserSpace.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { defineExtension, section } from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { PROJECT_LIMITS, projectDir, type FileEntry, type Project } from '@gense/protocol'
import { basename, isUnder, resolvePath } from '../platform/fs/paths.ts'
import { memoryContext } from './memory.ts'
import { projectSection } from './memory-prompt.ts'
import type { UserSpace } from './space.ts'
import { DATA_DIR, MAX_UPLOAD, UPLOADS_DIR, mimeOf, safeName, toBase64 } from './workspace.ts'

const columns = 'id, name, color, instructions, createdAt, updatedAt'
type ProjectInput = Pick<Project, 'name'> & Partial<Pick<Project, 'color' | 'instructions'>>
type ProjectPatch = Partial<ProjectInput>
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }) => { if (!r.ok) throw r.error; return r.value }

function validated(input: ProjectInput): ProjectInput & { color: number; instructions: string } {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > PROJECT_LIMITS.name) throw new Error(`项目名称须为 1–${PROJECT_LIMITS.name} 个字符`)
  const color = input.color === undefined ? 0 : input.color, instructions = input.instructions === undefined ? '' : input.instructions
  if (!Number.isSafeInteger(color) || color < 0) throw new Error('项目颜色无效')
  if (typeof instructions !== 'string' || instructions.length > PROJECT_LIMITS.instructions) throw new Error('项目指令过长或无效')
  return { name: input.name.trim(), color, instructions }
}

async function checkedPath(env: ExecutionEnv, root: string, path: string) {
  if (typeof path !== 'string') throw new Error('文件路径无效')
  const abs = resolvePath(root, path)
  if (abs === root || !isUnder(abs, root)) throw new Error('只能访问指定目录里的文件')
  const real = unwrap(await env.canonicalPath(abs, ctx))
  if (!isUnder(real, root) || real === root) throw new Error('只能访问指定目录里的文件')
  return abs
}

/** Complete listing for quota accounting as well as the UI; errors other than a missing directory fail closed. */
async function listFiles(env: ExecutionEnv, dir: string): Promise<FileEntry[]> {
  const listed = await env.listDir(dir, ctx)
  if (!listed.ok) { if (listed.error.code === 'not_found') return []; throw listed.error }
  const out: FileEntry[] = []
  for (const info of listed.value.sort((a, b) => a.name.localeCompare(b.name))) {
    if (info.kind === 'directory') out.push(...await listFiles(env, info.path))
    else if (info.kind === 'file') out.push({ path: info.path, size: info.size, mtime: info.mtimeMs, readOnly: true })
  }
  return out
}

export class ProjectStore {
  readonly #space: UserSpace
  readonly #listeners = new Set<(projects: Project[]) => void>()
  #queue: Promise<unknown> = Promise.resolve()
  constructor(space: UserSpace) { this.#space = space }

  // Creation, moving trees and deletion share this queue, so a tree cannot land in a project being deleted.
  serial<T>(change: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(change)
    this.#queue = result.catch(() => {})
    return result
  }

  list() { return this.#space.db.all<Project>(`SELECT ${columns} FROM projects ORDER BY updatedAt DESC, rowid DESC`) }
  async get(id: string): Promise<Project> {
    if (typeof id !== 'string') throw new Error('项目不存在')
    const project = await this.#space.db.get<Project>(`SELECT ${columns} FROM projects WHERE id = ?`, id)
    if (!project) throw new Error('项目不存在')
    return project
  }
  subscribe(listener: (projects: Project[]) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  async #changed() { const projects = await this.list(); for (const listener of this.#listeners) listener(projects) }

  create(input: ProjectInput): Promise<Project> {
    return this.serial(async () => {
      const fields = validated(input), now = this.#space.now()
      const project: Project = { ...fields, id: crypto.randomUUID(), createdAt: now, updatedAt: now }
      const env = await this.#space.workspace.env(DATA_DIR)
      unwrap(await env.createDir(projectDir(project.id), { recursive: true }, ctx))
      await this.#space.db.run(`INSERT INTO projects (${columns}) VALUES (?, ?, ?, ?, ?, ?)`, project.id, project.name, project.color, project.instructions, now, now)
      await this.#changed()
      return project
    })
  }

  update(id: string, patch: ProjectPatch): Promise<Project> {
    return this.serial(async () => {
      const previous = await this.get(id)
      const fields = validated({ name: patch.name === undefined ? previous.name : patch.name, color: patch.color === undefined ? previous.color : patch.color, instructions: patch.instructions === undefined ? previous.instructions : patch.instructions })
      const project = { ...previous, ...fields, updatedAt: this.#space.now() }
      await this.#space.db.run('UPDATE projects SET name = ?, color = ?, instructions = ?, updatedAt = ? WHERE id = ?', project.name, project.color, project.instructions, project.updatedAt, id)
      await this.#changed()
      return project
    })
  }

  delete(id: string, deleteChats: boolean): Promise<void> {
    return this.serial(async () => {
      await this.get(id)
      if (typeof deleteChats !== 'boolean') throw new Error('请选择删除还是移出项目对话')
      const space = this.#space
      if (deleteChats) {
        for (const tree of await space.db.all<{ id: string }>('SELECT id FROM trees WHERE projectId = ?', id)) await space.deleteTree(tree.id)
      } else {
        await space.db.run('UPDATE trees SET projectId = NULL, updatedAt = ? WHERE projectId = ?', space.now(), id)
      }
      const env = await space.workspace.env(DATA_DIR)
      unwrap(await env.remove(projectDir(id), { recursive: true, force: true }, ctx))
      // Reject any later scoped memory writes before the memory queue removes all already admitted writes.
      await space.db.run('DELETE FROM projects WHERE id = ?', id)
      await space.memories.removeProject(id)
      await space.changed()
      await this.#changed()
    })
  }

  async listFiles(id: string) {
    await this.get(id)
    return listFiles(await this.#space.workspace.env(DATA_DIR), projectDir(id))
  }

  addFiles(id: string, uploads: string[]): Promise<FileEntry[]> {
    return this.serial(async () => {
      await this.get(id)
      if (!Array.isArray(uploads) || uploads.some(path => typeof path !== 'string') || new Set(uploads).size !== uploads.length) throw new Error('上传文件列表无效或重复')
      const env = await this.#space.workspace.env(DATA_DIR), existing = await this.listFiles(id)
      const names = new Set(existing.map(file => file.path))
      const moves: { source: string; target: string }[] = []
      let size = existing.reduce((sum, file) => sum + file.size, 0)
      for (const upload of uploads) {
        const source = await checkedPath(env, UPLOADS_DIR, upload)
        const info = unwrap(await env.fileInfo(source, ctx))
        if (info.kind !== 'file') throw new Error('上传文件不存在')
        if (info.size > MAX_UPLOAD) throw new Error('文件超过 20 MB')
        size += info.size
        if (size > PROJECT_LIMITS.files) throw new Error('项目文件超过总量上限（200 MB）')
        const name = safeName(basename(source).replace(/^[0-9a-f]{8}-/, ''))
        let target = `${projectDir(id)}/${name}`, n = 1
        while (names.has(target)) target = `${projectDir(id)}/${++n}-${name}`
        names.add(target); moves.push({ source, target })
      }
      const moved: typeof moves = []
      try {
        for (const move of moves) { unwrap(await env.renameFile(move.source, move.target, ctx)); moved.push(move) }
      } catch (error) {
        for (const move of moved.reverse()) unwrap(await env.renameFile(move.target, move.source, ctx))
        throw error
      }
      await this.#changed()
      return this.listFiles(id)
    })
  }

  deleteFile(id: string, path: string): Promise<void> {
    return this.serial(async () => {
      await this.get(id)
      const env = await this.#space.workspace.env(DATA_DIR), abs = await checkedPath(env, projectDir(id), path)
      const info = unwrap(await env.fileInfo(abs, ctx))
      if (info.kind !== 'file') throw new Error('只能删除项目文件')
      unwrap(await env.remove(abs, undefined, ctx))
      await this.#changed()
    })
  }

  async readFile(id: string, path: string) {
    await this.get(id)
    const env = await this.#space.workspace.env(DATA_DIR), abs = await checkedPath(env, projectDir(id), path)
    return { name: basename(abs), mimeType: mimeOf(abs), base64: toBase64(unwrap(await env.readBinaryFile(abs, ctx))) }
  }
}

export function projectExtension(getSpace: () => UserSpace) {
  return defineExtension({ name: 'project', sections: [section('project', async ({ conversationId }) => {
    const space = getSpace(), context = await memoryContext(space, conversationId)
    if (!context?.projectId) return undefined
    const project = await space.projects.get(context.projectId)
    return projectSection(project, await space.projects.listFiles(project.id))
  })] })
}
