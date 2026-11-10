// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// A tree is a main conversation and the branches forked from it, all ownerless; tree and branch ids are ours,
// conversation ids are pi-durable's. Each tree has one workspace directory, every branch's cwd (D6).
import { BACKGROUND_CONTEXT,type Context } from '@earendil-works/chord/context'

import {
EVENT_KIND,
type EventData
} from '@gense/protocol'

import {
eventText,
type EventDraft
} from '../events/tasks.ts'

import { BRANCH_COLUMNS,type BranchRow,type EventRow,WAKES_PER_MINUTE } from './shared.ts'

import type { UserSpace } from './space.ts'
export async function mainBranch(this: UserSpace, treeId: string): Promise<BranchRow> {
    const branch = await this.db.get<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE treeId = ? AND role = 'main'`, treeId)
    if (!branch) throw new Error('会话不存在')
    return branch
  }

export async function emit(this: UserSpace, treeId: string, draft: EventDraft, options: { branchId?: string; key?: string } = {}, ctx: Context = BACKGROUND_CONTEXT): Promise<EventData> {
  const { branch } = options.branchId ? await this.branchRow(treeId, options.branchId) : { branch: await this.mainBranch(treeId) }
  const id = options.key ?? crypto.randomUUID()
  const existing = await this.triggers.get(id)
  if (existing) return JSON.parse(existing.payload).event as EventData
  let wake = draft.wake, body = draft.body
  if (wake) {
    const recent = await this.db.get<{ n: number }>("SELECT count(*) AS n FROM triggers WHERE tree_id = ? AND decision = 'accepted' AND json_extract(payload, '$.branchId') = ? AND json_extract(payload, '$.event.wake') = 1 AND created_at > ?", treeId, branch.id, this.now() - 60_000)
    if (recent!.n >= WAKES_PER_MINUTE) { wake = false; body += '\n\n（一分钟内的通知太多，这条没有立即处理，下次对话时再看。）' }
  }
  const event: EventData = { ...draft, body, wake, id, createdAt: this.now() }
  const admitted = await this.triggers.admit({ id, source: draft.source.kind, thread: { key: treeId, label: draft.source.label, group: false }, actor: { id: 'owner', name: '所有者自动任务' }, text: body, treeId, createdAt: event.createdAt }, this.channels.isAllowed(draft.source.kind, 'owner'), { event, branchId: branch.id })
  if (admitted.duplicate) return JSON.parse(admitted.row.payload).event as EventData
  if (admitted.row.decision === 'rejected') return event
  await this.deliver({ id, treeId, branchId: branch.id, data: JSON.stringify(event), wake: wake ? 1 : 0 }, ctx)
  return event
}

export async function deliver(this: UserSpace, row: EventRow, ctx: Context): Promise<void> {
    const event = JSON.parse(row.data) as EventData
    const { tree, branch } = await this.branchRow(row.treeId, row.branchId)
    const conv = await this.open(branch, ctx)
    const text = eventText(event)
    const data = { ...event, source: { ...event.source } }
    if (row.wake) {
      const submission = await conv.submit({ type: 'input', content: [{ type: 'text', text }], requestId: `event:${event.id}`, entry: { kind: EVENT_KIND, data } }, ctx)
      await this.answered(tree, branch, conv, submission, '', ctx)
    } else {
      await conv.submit(
        { type: 'write', requestId: `event:${event.id}`, entry: { kind: EVENT_KIND, data, model: [{ role: 'user', content: [{ type: 'text', text }], timestamp: event.createdAt }] } },
        ctx,
      )
      await this.db.run('UPDATE trees SET updatedAt = ? WHERE id = ?', this.now(), tree.id)
      await this.changed()
    }
    await this.triggers.delivered(event.id)
  }

export async function report(this: UserSpace, conversationId: number, report: { title: string; body: string }, ctx: Context): Promise<"已交给主线；用户回到主线时能看到，主线下一轮对话会读到它。" | "已汇报给主线，你的任务完成了；简短收尾即可，不要再做别的。"> {
    const branch = await this.db.get<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE conversationId = ?`, conversationId)
    if (!branch) throw new Error('这个会话不在任何会话树里')
    if (branch.role === 'main') throw new Error('你已经在主线上，直接回答用户即可，不需要 report')
    // A subagent's report wakes the main line (R52); a user branch's waits for its next turn (R40).
    const agent = branch.role === 'agent'
    await this.emit(
      branch.treeId,
      { source: { kind: agent ? 'agent' : 'branch', id: branch.id, label: branch.title || '分叉' }, type: 'report', title: report.title, body: report.body, wake: agent },
      { key: `report:${conversationId}:${report.title}:${report.body.length}` },
      ctx,
    )
    if (!agent) return '已交给主线；用户回到主线时能看到，主线下一轮对话会读到它。'
    await this.db.run("UPDATE branches SET status = 'done' WHERE id = ?", branch.id)
    this.branchesChanged(branch.treeId)
    return '已汇报给主线，你的任务完成了；简短收尾即可，不要再做别的。'
  }