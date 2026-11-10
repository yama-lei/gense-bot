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
    if (options.key) {
      const found = await this.db.get<{ data: string }>('SELECT data FROM events WHERE idempotencyKey = ?', options.key)
      if (found) return JSON.parse(found.data) as EventData
    }
    let wake = draft.wake
    let body = draft.body
    if (wake) {
      const recent = await this.db.get<{ n: number }>('SELECT count(*) AS n FROM events WHERE branchId = ? AND wake = 1 AND createdAt > ?', branch.id, this.now() - 60_000)
      if (recent!.n >= WAKES_PER_MINUTE) {
        wake = false
        body += '\n\n（一分钟内的通知太多，这条没有立即处理，下次对话时再看。）'
      }
    }
    const event: EventData = { ...draft, body, wake, id: crypto.randomUUID(), createdAt: this.now() }
    const row: EventRow = { id: event.id, treeId, branchId: branch.id, data: JSON.stringify(event), wake: wake ? 1 : 0 }
    await this.db.run(
      'INSERT INTO events (id, treeId, branchId, data, wake, idempotencyKey, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      row.id,
      treeId,
      branch.id,
      row.data,
      row.wake,
      options.key ?? null,
      event.createdAt,
    )
    await this.deliver(row, ctx)
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
    await this.db.run('UPDATE events SET deliveredAt = ? WHERE id = ?', this.now(), event.id)
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