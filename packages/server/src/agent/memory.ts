// Roadmap-7 A1–A6: one user's durable memories, shared by all channels and connections.
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import { MEMORY_LIMITS, type Memory, type MemorySource, type MemoryToolDetails } from '@gense/protocol'
import { Type } from 'typebox'
import { MEMORY_AUTO, MEMORY_EXPLICIT_ONLY, MEMORY_TOOL, memorySection } from './memory-prompt.ts'
import type { UserSpace } from './space.ts'

type MemoryRow = Omit<Memory, 'enabled'> & { enabled: number }
type AddMemory = { text: string; source?: MemorySource; treeId?: string | null; projectId?: string | null; enabled?: boolean }
type MemoryPatch = Pick<Partial<Memory>, 'text' | 'enabled' | 'projectId'>
const columns = 'id, text, source, treeId, projectId, enabled, createdAt, updatedAt'
const fromRow = (row: MemoryRow): Memory => ({ ...row, enabled: row.enabled === 1 })

function memoryText(text: string) {
  if (typeof text !== 'string' || !text.trim() || text.length > MEMORY_LIMITS.text) throw new Error(`记忆须为 1–${MEMORY_LIMITS.text} 个字符`)
  // Deliberately conservative and local: never send suspected secrets to another service for classification.
  if (/\b(?:sk|rk|pk)[-_][a-z0-9_-]{12,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[a-z0-9]{20,}|-----BEGIN [\w ]*PRIVATE KEY-----|\d{11,}|(?:密码|口令)\s*(?:是|为|[:：=])|\b(?:password|api[ _-]?key|secret[ _-]?key)\s*(?:is\b|[:=])/i.test(text))
    throw new Error('不能保存密码、密钥、证件号或卡号等敏感内容')
  return text.trim()
}

export class MemoryStore {
  readonly #db: SqliteDatabase
  readonly #now: () => number
  readonly #listeners = new Set<(entries: Memory[]) => void>()
  #queue: Promise<unknown> = Promise.resolve()
  constructor(db: SqliteDatabase, now: () => number) { this.#db = db; this.#now = now }

  async list(): Promise<Memory[]> {
    return (await this.#db.all<MemoryRow>(`SELECT ${columns} FROM memories ORDER BY updatedAt DESC, rowid DESC`)).map(fromRow)
  }

  async get(id: string): Promise<Memory> {
    const row = await this.#db.get<MemoryRow>(`SELECT ${columns} FROM memories WHERE id = ?`, id)
    if (!row) throw new Error('记忆不存在')
    return fromRow(row)
  }

  subscribe(listener: (entries: Memory[]) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }

  // A model round may call memory in parallel, and several devices may write at once. Count and insert share this queue.
  #mutate<T>(change: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => {
      const value = await change()
      const entries = await this.list()
      for (const listener of this.#listeners) listener(entries)
      return value
    })
    this.#queue = result.catch(() => {})
    return result
  }

  async #references(treeId: string | null, projectId: string | null, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('记忆开关无效')
    if (treeId !== null) {
      const tree = typeof treeId === 'string' && await this.#db.get<{ expiresAt: number | null }>('SELECT expiresAt FROM trees WHERE id = ?', treeId)
      if (!tree) throw new Error('会话不存在')
      if (tree.expiresAt !== null) throw new Error('临时对话不能写入记忆')
    }
    if (projectId !== null && (typeof projectId !== 'string' || !await this.#db.get('SELECT id FROM projects WHERE id = ?', projectId))) throw new Error('项目不存在')
  }

  add(input: AddMemory): Promise<Memory> {
    return this.#mutate(async () => {
      const text = memoryText(input.text), source = input.source === undefined ? 'manual' : input.source, treeId = input.treeId ?? null, projectId = input.projectId ?? null, enabled = input.enabled === undefined ? true : input.enabled
      if (!['manual', 'saved', 'model'].includes(source)) throw new Error('记忆来源无效')
      await this.#references(treeId, projectId, enabled)
      const count = (await this.#db.get<{ n: number }>('SELECT count(*) AS n FROM memories'))!.n
      if (count >= MEMORY_LIMITS.entries) throw new Error(`记忆已满（${MEMORY_LIMITS.entries} 条），请先删除一些`)
      const now = this.#now()
      const memory: Memory = { id: crypto.randomUUID(), text, source, treeId, projectId, enabled, createdAt: now, updatedAt: now }
      await this.#db.run(`INSERT INTO memories (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, memory.id, text, source, treeId, projectId, enabled ? 1 : 0, now, now)
      return memory
    })
  }

  update(id: string, patch: MemoryPatch): Promise<Memory> {
    return this.change(id, patch).then(result => result.memory)
  }

  /** Keep the undo value in the same mutation as the write, including when several tools run in parallel. */
  change(id: string, patch: MemoryPatch, projectId?: string | null): Promise<{ memory: Memory; previous: Memory }> {
    return this.#mutate(async () => {
      const previous = await this.get(id)
      this.#allow(previous, projectId)
      const next = { ...previous, updatedAt: this.#now() }
      if (patch.text !== undefined) next.text = memoryText(patch.text)
      if (patch.enabled !== undefined) next.enabled = patch.enabled
      if (patch.projectId !== undefined) next.projectId = patch.projectId
      await this.#references(null, next.projectId, next.enabled)
      await this.#db.run('UPDATE memories SET text = ?, enabled = ?, projectId = ?, updatedAt = ? WHERE id = ?', next.text, next.enabled ? 1 : 0, next.projectId, next.updatedAt, id)
      return { memory: next, previous }
    })
  }

  #allow(memory: Memory, projectId?: string | null) {
    if (projectId !== undefined && memory.projectId !== null && memory.projectId !== projectId) throw new Error('不能修改其他项目的记忆')
  }

  remove(id: string, projectId?: string | null): Promise<Memory> {
    return this.#mutate(async () => {
      const previous = await this.get(id)
      this.#allow(previous, projectId)
      await this.#db.run('DELETE FROM memories WHERE id = ?', id)
      return previous
    })
  }

  removeProject(projectId: string): Promise<void> {
    return this.#mutate(() => this.#db.run('DELETE FROM memories WHERE projectId = ?', projectId))
  }
}

/** Central conversation lookup for memory and project sections. Temporary trees never expose either. */
export async function memoryContext(space: UserSpace, conversationId: number) {
  const branch = await space.db.get<{ treeId: string }>('SELECT treeId FROM branches WHERE conversationId = ?', conversationId)
  if (!branch) return undefined
  const tree = await space.row(branch.treeId)
  if (tree.expiresAt !== null) return undefined
  return { treeId: tree.id, projectId: tree.projectId }
}

export function memoryExtension(getSpace: () => UserSpace, writes: 'auto' | 'explicit' = 'auto') {
  const tool = defineTool({
    name: MEMORY_TOOL.name,
    description: `${MEMORY_TOOL.description}\n\n${writes === 'explicit' ? MEMORY_EXPLICIT_ONLY : MEMORY_AUTO}`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal('add'), Type.Literal('update'), Type.Literal('remove')], { description: MEMORY_TOOL.parameters.action }),
      text: Type.Optional(Type.String({ maxLength: MEMORY_LIMITS.text, description: MEMORY_TOOL.parameters.text })),
      id: Type.Optional(Type.String({ description: MEMORY_TOOL.parameters.id })),
      scope: Type.Optional(Type.Union([Type.Literal('project'), Type.Literal('global')], { description: MEMORY_TOOL.parameters.scope })),
    }),
    async execute(args, api) {
      const space = getSpace(), context = await memoryContext(space, api.conversationId)
      if (space.preferences.get().useMemory === false || !context) throw new Error('这个会话未启用记忆')
      if (args.action !== 'remove' && args.text === undefined) throw new Error('请提供记忆内容')
      let details: MemoryToolDetails
      if (args.action === 'add') {
        const memory = await space.memories.add({ text: args.text!, source: 'model', treeId: context.treeId, projectId: args.scope === 'global' ? null : context.projectId })
        details = { action: 'add', memory }
      } else {
        if (!args.id) throw new Error('请提供记忆 id')
        if (args.action === 'remove') {
          const memory = await space.memories.remove(args.id, context.projectId)
          details = { action: 'remove', memory, previous: memory }
        } else {
          const { memory, previous } = await space.memories.change(args.id, { text: args.text!, ...(args.scope !== undefined && { projectId: args.scope === 'project' ? context.projectId : null }) }, context.projectId)
          details = { action: 'update', memory, previous }
        }
      }
      return { output: [{ type: 'text', text: `Memory ${args.action === 'add' ? 'saved' : args.action === 'update' ? 'updated' : 'removed'} (${details.memory.id}).` }], details: { action: details.action, memory: { ...details.memory }, ...(details.previous && { previous: { ...details.previous } }) } }
    },
  })
  return defineExtension({
    name: writes === 'explicit' ? 'memory-explicit' : 'memory',
    tools: [tool],
    sections: [section('memory', async ({ conversationId }) => {
      const space = getSpace()
      if (space.preferences.get().useMemory === false) return undefined
      const context = await memoryContext(space, conversationId)
      return context ? memorySection(await space.memories.list(), context.projectId) : undefined
    })],
  })
}
