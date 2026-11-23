// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// A tree is a main conversation and the branches forked from it, all ownerless; tree and branch ids are ours,
// conversation ids are pi-durable's. Each tree has one workspace directory, every branch's cwd (D6).
import type { Context } from '@earendil-works/chord/context'

import {
type ConversationId,
type EntryId,
type ToolExecutionApi
} from '@earendil-works/pi-durable'

import {
BRIEF_KIND,
RUN_ERROR_KIND,
type RunErrorData
} from '@gense/protocol'

import {
agentBrief,
MAX_AGENTS,
type AgentEnd,
type AgentInput
} from '../events/tasks.ts'

import { BRANCH_COLUMNS,type BranchRow,entryText,PREVIEW_ENTRIES,titleOf } from './shared.ts'

import type { UserSpace } from './space.ts'
export function spawn(this: UserSpace, api: ToolExecutionApi, args: { task: string; title: string; mode: 'fork' | 'new' }, ctx: Context): Promise<string> {
    const run = this.spawning.then(() => this.spawnAgent(api, args, ctx))
    this.spawning = run.catch(() => {})
    return run
  }

export async function spawnAgent(this: UserSpace, api: ToolExecutionApi, { task, title, mode }: { task: string; title: string; mode: 'fork' | 'new' }, ctx: Context): Promise<string> {
    const from = await this.db.get<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE conversationId = ?`, api.conversationId)
    if (!from) throw new Error('这个会话不在任何会话树里')
    // Refused rather than hidden, so every branch keeps the same tool list and prompt prefix (R54, D3).
    if (from.role === 'agent') throw new Error('子 agent 不能再派生子 agent；请自己完成任务，最后的回答会汇报给主线')
    if (from.role !== 'main') throw new Error('只有主线可以派出子 agent')
    if (!task.trim()) throw new Error('任务说明不能为空')
    const running = await this.db.get<{ n: number }>("SELECT count(*) AS n FROM branches WHERE treeId = ? AND role = 'agent' AND status = 'running'", from.treeId)
    if (running!.n >= MAX_AGENTS) throw new Error(`已有 ${MAX_AGENTS} 个子 agent 在运行（上限），等其中一个汇报后再派出`)

    const parent = await this.open(from, ctx)
    // A fork continues from the entry before this turn's answer: the conversation up to the request, without the
    // assistant message whose tool calls are still unanswered.
    const { items } = await parent.entries({}, PREVIEW_ENTRIES, undefined, ctx)
    const answer = items.findIndex((e) => e.kind === 'pi.assistant')
    const at = answer < 0 ? null : (items[answer + 1]?.id ?? null)
    const conv = mode === 'fork' && at !== null ? await parent.fork(at as EntryId, { ownership: { kind: 'ownerless' } }, ctx) : await this.emptyLike(from.treeId, parent, ctx)
    const branch: BranchRow = {
      id: crypto.randomUUID(),
      treeId: from.treeId,
      conversationId: conv.id,
      parentId: from.id,
      forkEntryId: at,
      role: 'agent',
      mode,
      title: titleOf(title.trim() || task.trim()),
      status: 'running',
      createdAt: this.now(),
    }
    await this.insertBranch(branch)
    const input: AgentInput = { treeId: from.treeId, branchId: branch.id, conversationId: conv.id, title: branch.title, task }
    // Background: the main line's Esc and idle waits do not reach the subagent (R51).
    await api.createTask(this.agentTask, input, { ownership: { kind: 'conversation' }, background: true }, ctx)
    this.branchesChanged(from.treeId)
    return `已派出子 agent「${branch.title}」。它完成后，最后的回答会汇报给你，汇报到达时会唤醒你。现在告诉用户你派出了什么，不要等待结果。`
  }

export async function runAgent(this: UserSpace, input: AgentInput, ctx: Context): Promise<AgentEnd> {
    const conv = await this.harness.conversation(input.conversationId as ConversationId, ctx)
    if (!conv) return { status: 'unanswered', reason: 'gone' }
    const submission = await conv.submit(
      {
        type: 'input',
        content: [{ type: 'text', text: agentBrief(input.title, input.task) }],
        requestId: `agent:${input.branchId}`,
        entry: { kind: BRIEF_KIND, data: { label: `子 agent 任务：${input.task}` } },
      },
      ctx,
    )
    this.branchesChanged(input.treeId)
    const settled = await submission.wait(ctx)
    if (settled.status === 'done') return { status: 'done' }
    if (settled.reason !== 'aborted') {
      const data: RunErrorData = { reason: settled.reason, ...(settled.detail !== undefined && { detail: JSON.stringify(settled.detail) }) }
      await conv.submit({ type: 'write', requestId: `agent-error:${input.branchId}`, entry: { kind: RUN_ERROR_KIND, data: { ...data } } }, ctx)
    }
    return { status: 'unanswered', reason: settled.reason }
  }

export async function finishAgent(this: UserSpace, input: AgentInput, end: AgentEnd, ctx: Context): Promise<void> {
    const branch = await this.db.get<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE id = ?`, input.branchId)
    // Reported already, or its tree is gone.
    if (!branch || branch.status !== 'running') return
    const aborted = end.status === 'unanswered' && end.reason === 'aborted'
    await this.db.run('UPDATE branches SET status = ? WHERE id = ?', aborted ? 'aborted' : 'failed', branch.id)
    const conv = await this.harness.conversation(input.conversationId as ConversationId, ctx)
    const { items } = conv ? await conv.entries({}, PREVIEW_ENTRIES, undefined, ctx) : { items: [] }
    const last = items.find((e) => e.kind === 'pi.assistant' && entryText(e))
    // Its final answer is its report (R52): it wakes the main line.
    if (end.status === 'done') {
      await this.db.run("UPDATE branches SET status = 'done' WHERE id = ?", branch.id)
      await this.emit(
        input.treeId,
        { source: { kind: 'agent', id: branch.id, label: branch.title }, type: 'report', title: branch.title, body: last ? entryText(last) : '（没有回答）', wake: true },
        { key: `agent-end:${branch.id}` },
        ctx,
      )
      this.branchesChanged(input.treeId)
      return
    }
    const why = aborted ? '它被中止了' : `它运行出错了（${end.reason}）`
    await this.emit(
      input.treeId,
      {
        source: { kind: 'system', id: branch.id, label: '系统' },
        type: 'notice',
        title: `子 agent「${branch.title}」未完成`,
        body: `${why}。\n\n它的最后一条回答：\n\n${last ? entryText(last) : '（没有回答）'}`,
        wake: true,
      },
      { key: `agent-end:${branch.id}` },
      ctx,
    )
    this.branchesChanged(input.treeId)
  }
