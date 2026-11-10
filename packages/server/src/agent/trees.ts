import { pluginCatalog } from '../plugins/catalog.ts'
import type { ConversationWatch } from '@earendil-works/pi-durable'
// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// A tree is a main conversation and the branches forked from it, all ownerless; tree and branch ids are ours,
// conversation ids are pi-durable's. Each tree has one workspace directory, every branch's cwd (D6).
import { BACKGROUND_CONTEXT,type Context } from '@earendil-works/chord/context'

import {
type Conversation,
type ConversationId
} from '@earendil-works/pi-durable'



import {
type ToolCallResult,
type TreeMeta
} from '@gense/protocol'

import { treeDir,Workspace } from './workspace.ts'




import { BRANCH_COLUMNS,type BranchRow,COLUMNS,DEFAULT_TITLE,SCHEDULE_COLUMNS,type ScheduleRow,toMeta,type TreeRow } from './shared.ts'

import type { UserSpace } from './space.ts'
export function now(this: UserSpace): number {
    return (this.options.now ?? Date.now)()
  }

export async function trees(this: UserSpace): Promise<TreeMeta[]> {
    const rows = await this.db.all<TreeRow>(`SELECT ${COLUMNS} FROM trees ORDER BY pinned DESC, updatedAt DESC`)
    return rows.map(toMeta)
  }

export function subscribeTrees(this: UserSpace, listener: (trees: TreeMeta[]) => void): () => undefined {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

export function subscribeBranches(this: UserSpace, listener: (treeId: string) => void): () => undefined {
    this.branchListeners.add(listener)
    return () => void this.branchListeners.delete(listener)
  }

export async function changed(this: UserSpace): Promise<void> {
    const trees = await this.trees()
    for (const l of this.listeners) l(trees)
  }

export function branchesChanged(this: UserSpace, treeId: string): void {
    for (const l of this.branchListeners) l(treeId)
  }

export async function conversationChanged(this: UserSpace, conversationId: number): Promise<void> {
    const row = await this.db.get<{ treeId: string }>('SELECT treeId FROM branches WHERE conversationId = ?', conversationId)
    if (row && !this.closed) this.branchesChanged(row.treeId)
  }

export async function createTree(this: UserSpace, ctx: Context = BACKGROUND_CONTEXT): Promise<TreeMeta> {
    const model = await this.accounts.defaultModel()
    const id = crypto.randomUUID()
    await this.workspace.createTree(id, ctx)
    const conv = await this.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { cwd: treeDir(id), ...(model && { model: { provider: model.provider, modelId: model.id } }) },
      },
      ctx,
    )
    const now = this.now()
    const meta: TreeMeta = { id, title: DEFAULT_TITLE, pinned: false, createdAt: now, updatedAt: now }
    const main: BranchRow = { id: crypto.randomUUID(), treeId: id, conversationId: conv.id, parentId: null, forkEntryId: null, role: 'main', mode: 'new', title: '', status: 'idle', createdAt: now }
    await this.insertBranch(main)
    await this.db.run(`INSERT INTO trees (${COLUMNS}) VALUES (?, ?, ?, 0, ?, ?, ?)`, meta.id, conv.id, meta.title, now, now, main.id)
    await this.changed()
    return meta
  }

export function insertBranch(this: UserSpace, b: BranchRow): Promise<void> {
    return this.db.run(
      `INSERT INTO branches (${BRANCH_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.id,
      b.treeId,
      b.conversationId,
      b.parentId,
      b.forkEntryId,
      b.role,
      b.mode,
      b.title,
      b.status,
      b.createdAt,
    )
  }

export async function updateTree(this: UserSpace, treeId: string, patch: { title?: string; pinned?: boolean }): Promise<void> {
    await this.row(treeId)
    if (patch.title !== undefined) await this.db.run('UPDATE trees SET title = ? WHERE id = ?', patch.title.trim() || DEFAULT_TITLE, treeId)
    if (patch.pinned !== undefined) await this.db.run('UPDATE trees SET pinned = ? WHERE id = ?', patch.pinned ? 1 : 0, treeId)
    await this.changed()
  }

export async function deleteTree(this: UserSpace, treeId: string, ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    const branches = await this.db.all<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE treeId = ?`, treeId)
    for (const s of await this.db.all<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE treeId = ?`, treeId)) await this.stopSchedule(s, ctx)
    await this.db.run('DELETE FROM schedules WHERE treeId = ?', treeId)
    await this.db.run('DELETE FROM webhooks WHERE treeId = ?', treeId)
    await this.db.run('DELETE FROM events WHERE treeId = ?', treeId)
    this.automationsChanged()
    // The main branch first, with its background work: a subagent's anchor then does not report into a removed tree.
    for (const b of branches.sort((a, b) => Number(b.role === 'main') - Number(a.role === 'main')))
      await (await this.harness.conversation(b.conversationId as ConversationId, ctx))?.abort(ctx, { background: b.role === 'main' })
    await this.db.run('DELETE FROM branches WHERE treeId = ?', treeId)
    await this.db.run('DELETE FROM trees WHERE id = ?', treeId)
    await this.workspace.deleteTree(treeId, ctx)
    await this.changed()
  }

export async function row(this: UserSpace, treeId: string): Promise<TreeRow> {
    const row = await this.db.get<TreeRow>(`SELECT ${COLUMNS} FROM trees WHERE id = ?`, treeId)
    if (!row) throw new Error('会话不存在')
    return row
  }

export async function branchRow(this: UserSpace, treeId: string, branchId?: string): Promise<{ tree: TreeRow; branch: BranchRow; }> {
    const tree = await this.row(treeId)
    const select = `SELECT ${BRANCH_COLUMNS} FROM branches WHERE treeId = ? AND `
    const branch =
      (await this.db.get<BranchRow>(`${select}id = ?`, treeId, branchId ?? tree.activeBranchId)) ??
      (branchId === undefined ? await this.db.get<BranchRow>(`${select}role = 'main'`, treeId) : undefined)
    if (!branch) throw new Error('这个分叉不存在')
    return { tree, branch }
  }

export async function open(this: UserSpace, branch: BranchRow, ctx: Context): Promise<Conversation> {
    const conv = await this.harness.conversation(branch.conversationId as ConversationId, ctx)
    if (!conv) throw new Error('会话不存在')
    return conv
  }

export async function files(this: UserSpace, treeId: string): Promise<Workspace> {
    await this.row(treeId)
    return this.workspace
  }

export async function callTool(this: UserSpace, treeId: string, pluginId: string, name: string, args: unknown, ctx: Context = BACKGROUND_CONTEXT): Promise<ToolCallResult> {
  await this.row(treeId)
  const plugin = pluginCatalog.find(p => p.id === pluginId)
  if (!plugin) throw new Error('未知插件')
  if (!this.plugins.active().includes(pluginId)) throw new Error('插件已关闭或不可用')
  if (!this.plugins.toolEnabled(pluginId, name)) throw new Error('工具已关闭')
  const tool = plugin.viewTools?.[name]
  if (!tool) throw new Error('界面不能调用该插件的这个工具')
  return tool.call(args, await this.workspace.env(treeDir(treeId)), ctx)
}

export async function abort(this: UserSpace, treeId: string, branchId?: string, ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    const { branch } = await this.branchRow(treeId, branchId)
    await (await this.open(branch, ctx)).abort(ctx)
  }

export async function watch(this: UserSpace, treeId: string, branchId?: string, ctx: Context = BACKGROUND_CONTEXT): Promise<{ branchId: string; watch: ConversationWatch; }> {
    const { tree, branch } = await this.branchRow(treeId, branchId)
    if (tree.activeBranchId !== branch.id) await this.db.run('UPDATE trees SET activeBranchId = ? WHERE id = ?', branch.id, treeId)
    return { branchId: branch.id, watch: await (await this.open(branch, ctx)).watch(ctx) }
  }

export async function close(this: UserSpace, ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    this.closed = true
    this.listeners.clear()
    this.branchListeners.clear()
    this.automationListeners.clear()
    await this.harness.close(ctx)
  }
/** Search every branch through the public transcript API, including inherited fork entries. */
export async function searchTrees(this: UserSpace, query: string, limit = 30): Promise<import('@gense/protocol').TreeHit[]> {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return []
  const hits: import('@gense/protocol').TreeHit[] = []
  for (const tree of await this.trees()) {
    let match = tree.title.toLocaleLowerCase().includes(needle) ? tree.title : ''
    for (const branch of (await this.branches(tree.id)).branches) {
      const conv = await this.harness.conversation(branch.conversationId as ConversationId, BACKGROUND_CONTEXT)
      if (!conv) continue
      const { entries } = await conv.context(BACKGROUND_CONTEXT)
      const text = entries.flatMap(e => (e.model ?? []).flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.flatMap(c => c.type === 'text' ? [c.text] : []))).join('\n')
      const at = text.toLocaleLowerCase().indexOf(needle)
      if (at >= 0) { match = text.slice(Math.max(0, at - 60), at + needle.length + 140); break }
    }
    if (match) hits.push({ treeId: tree.id, title: tree.title, snippet: match, updatedAt: tree.updatedAt })
  }
  return hits.sort((a,b) => b.updatedAt - a.updatedAt).slice(0, Math.min(100, Math.max(1, Number.isFinite(limit) ? limit : 30)))
}
