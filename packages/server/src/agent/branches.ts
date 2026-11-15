import type { SubmissionId } from '@earendil-works/pi-durable'
// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// A tree is a main conversation and the branches forked from it, all ownerless; tree and branch ids are ours,
// conversation ids are pi-durable's. Each tree has one workspace directory, every branch's cwd (D6).
import { BACKGROUND_CONTEXT,type Context } from '@earendil-works/chord/context'

import {
LiveDoc,
UserEntry,
type Conversation,
type ConversationId,
type EntryId,
type EntryRecord,
type Submission
} from '@earendil-works/pi-durable'

import type { ImageContent,TextContent } from '@earendil-works/pi-ai'

import {
RUN_ERROR_KIND,
type BranchesState,
type BranchMeta,
type Effort,
type ModelInfo,
type RunErrorData
} from '@gense/protocol'

import { toBase64,treeDir } from './workspace.ts'

import { attachmentsText,commandText,mentionsText,parseNote,type CommandNote,type Mention } from '@gense/protocol'

import { BRANCH_COLUMNS,type BranchRow,DEFAULT_TITLE,entryText,MENTIONED_CHAT_CHARS,PREVIEW_CHARS,PREVIEW_ENTRIES,titleOf,type TreeRow } from './shared.ts'

import type { UserSpace } from './space.ts'
import { parsedAttachments } from './attachments.ts'
import { historyEntries } from './history.ts'
export async function branches(this: UserSpace, treeId: string, ctx: Context = BACKGROUND_CONTEXT): Promise<BranchesState> {
    const tree = await this.row(treeId)
    const rows = await this.db.all<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE treeId = ? ORDER BY createdAt, rowid`, treeId)
    const branches = await Promise.all(rows.map((r) => this.branchMeta(r, ctx)))
    return { branches, activeBranchId: rows.some((r) => r.id === tree.activeBranchId) ? tree.activeBranchId : rows[0]!.id, versions: await this.versions(rows, ctx) }
  }

export async function branchMeta(this: UserSpace, row: BranchRow, ctx: Context): Promise<BranchMeta> {
    const conv = await this.harness.conversation(row.conversationId as ConversationId, ctx)
    const live = await this.harness.snapshot(LiveDoc, row.conversationId as ConversationId, ctx)
    const { items } = conv ? await conv.entries({}, PREVIEW_ENTRIES, undefined, ctx) : { items: [] }
    const answer = items.find((e) => e.kind === 'pi.assistant' && entryText(e))
    const { treeId: _, mode: __, ...meta } = row
    return {
      ...meta,
      status: live?.run ? 'running' : row.status,
      lastEntryId: items[0]?.id ?? row.forkEntryId,
      preview: answer ? entryText(answer).replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS) : '',
    }
  }

export async function versions(this: UserSpace, rows: BranchRow[], ctx: Context): Promise<Record<string, string[]>> {
    const groups = new Map<string, BranchRow[]>()
    for (const r of rows) if (r.role === 'user' && r.title) groups.set(String(r.forkEntryId ?? 'start'), [...(groups.get(String(r.forkEntryId ?? 'start')) ?? []), r])
    const out: Record<string, string[]> = {}
    for (const [key, forks] of groups) {
      const owner = key === 'start' ? rows.find((r) => r.role === 'main' && r.title) : await this.continuing(rows, forks[0]!, ctx)
      const ids = [...(owner && !forks.includes(owner) ? [owner] : []), ...forks].map((r) => r.id)
      if (ids.length > 1) out[key] = ids
    }
    return out
  }

export async function continuing(this: UserSpace, rows: BranchRow[], fork: BranchRow, ctx: Context): Promise<BranchRow | undefined> {
    const at = fork.forkEntryId!
    const conv = await this.harness.conversation(fork.conversationId as ConversationId, ctx)
    const entry = conv && (await conv.entries({ minEntryId: at as EntryId, maxEntryId: at as EntryId }, 1, undefined, ctx)).items[0]
    const owner = entry && rows.find((r) => r.conversationId === entry.conversationId)
    if (!owner) return undefined
    const next = (await (await this.open(owner, ctx)).entries({ minEntryId: (at + 1) as EntryId, order: 'ascending' }, 1, undefined, ctx)).items[0]
    return next?.kind === UserEntry.kind ? owner : undefined
  }

export async function addBranch(this: UserSpace, tree: TreeRow, from: BranchRow, at: number | null, ctx: Context): Promise<{ branch: BranchRow; conv: Conversation; }> {
    const parent = await this.open(from, ctx)
    const conv = at === null ? await this.emptyLike(tree.id, parent, ctx) : await parent.fork(at as EntryId, { ownership: { kind: 'ownerless' } }, ctx)
    const branch: BranchRow = {
      id: crypto.randomUUID(),
      treeId: tree.id,
      conversationId: conv.id,
      parentId: from.id,
      forkEntryId: at,
      role: 'user',
      mode: at === null ? 'new' : 'fork',
      title: '',
      status: 'idle',
      createdAt: this.now(),
    }
    await this.insertBranch(branch)
    await this.db.run('UPDATE trees SET activeBranchId = ? WHERE id = ?', branch.id, tree.id)
    return { branch, conv }
  }

export async function emptyLike(this: UserSpace, treeId: string, like: Conversation, ctx: Context): Promise<Conversation> {
    const agent = await like.agent(ctx)
    return this.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { cwd: treeDir(treeId), ...(agent.model && { model: agent.model }), ...(agent.thinkingLevel && { thinkingLevel: agent.thinkingLevel }) },
      },
      ctx,
    )
  }

export async function fork(this: UserSpace, treeId: string, branchId: string, at: number, ctx: Context = BACKGROUND_CONTEXT): Promise<BranchMeta> {
    const { tree, branch: from } = await this.branchRow(treeId, branchId)
    const { branch } = await this.addBranch(tree, from, at, ctx)
    this.branchesChanged(treeId)
    return this.branchMeta(branch, ctx)
  }

export async function userEntry(this: UserSpace, conv: Conversation, entryId: number, ctx: Context): Promise<{ entry: EntryRecord; before: EntryId | null; }> {
    const entries = await historyEntries(conv, ctx)
    const i = entries.findIndex((e) => e.id === entryId)
    if (i < 0 || entries[i]!.kind !== UserEntry.kind) throw new Error('这条消息不存在')
    return { entry: entries[i]!, before: i > 0 ? entries[i - 1]!.id : null }
  }

export async function regenerate(this: UserSpace, 
    treeId: string,
    branchId: string,
    entryId: number,
    input: { requestId: string; model?: ModelInfo; effort?: Effort },
    ctx: Context = BACKGROUND_CONTEXT,): Promise<BranchMeta> {
    const { tree, branch: from } = await this.branchRow(treeId, branchId)
    await this.checkModel(input.model)
    const { entry, before } = await this.userEntry(await this.open(from, ctx), entryId, ctx)
    const message = entry.model?.[0]
    const content: (TextContent | ImageContent)[] =
      message?.role !== 'user' ? [] : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [...message.content]
    const { branch, conv } = await this.addBranch(tree, from, before, ctx)
    const first = content[0]?.type === 'text' ? content[0].text : ''
    await this.submit(tree, branch, conv, content, input, parseNote(first) ? '' : first, ctx)
    return this.branchMeta({ ...branch, title: branch.title || titleOf(first) }, ctx)
  }

export async function checkModel(this: UserSpace, model: ModelInfo | undefined): Promise<void> {
    if (model && !(await this.accounts.list()).some((m) => m.provider === model.provider && m.id === model.id)) throw new Error('这个模型不可用，请重新选择')
  }

export async function send(this: UserSpace, 
    treeId: string,
    input: {
      text: string
      requestId: string
      branchId?: string
      replace?: number
      model?: ModelInfo
      effort?: Effort
      attachments?: string[]
      command?: CommandNote
      mentions?: Mention[]
    },
    ctx: Context = BACKGROUND_CONTEXT,): Promise<{ branchId: string; submissionId: SubmissionId; }> {
    const text = input.text.trim()
    if (!text && !input.attachments?.length && !input.command) throw new Error('消息不能为空')
    const found = await this.branchRow(treeId, input.branchId)
    const { tree } = found
    let { branch } = found
    let conv = await this.open(branch, ctx)
    await this.checkModel(input.model)
    if (input.replace !== undefined) {
      const { before } = await this.userEntry(conv, input.replace, ctx)
      ;({ branch, conv } = await this.addBranch(tree, branch, before, ctx))
    }

    const trigger = await this.triggers.get(input.requestId)
    if (trigger?.source === 'web') {
      const payload = JSON.parse(trigger.payload)
      payload.webInput = { ...input, branchId: branch.id }; delete payload.webInput.replace
      await this.db.run('UPDATE triggers SET payload = ? WHERE id = ?', JSON.stringify(payload), input.requestId)
    }
    const attached = input.attachments?.length ? await this.workspace.attach(treeId, input.attachments, ctx) : []
    const reference = attached.length ? (input.model ? { provider: input.model.provider, modelId: input.model.id } : (await conv.agent(ctx)).model) : undefined
    const selected = reference ? this.accounts.models.getModel(reference.provider, reference.modelId) : undefined
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text }]
    if (input.command) content.push({ type: 'text', text: commandText(input.command) })
    if (input.mentions?.length) content.push({ type: 'text', text: mentionsText(await this.mentioned(treeId, input.mentions, ctx)) })
    if (attached.length) content.push({ type: 'text', text: attachmentsText(await parsedAttachments(this, treeId, attached, selected, ctx)) })
    for (const a of attached) if (a.mimeType.startsWith('image/') && (!selected || selected.input.includes('image'))) content.push({ type: 'image', data: toBase64(a.bytes), mimeType: a.mimeType })
    const named = text || input.command?.label || attached.map((a) => a.path.slice(a.path.lastIndexOf('/') + 1)).join('、')
    const submissionId = await this.submit(tree, branch, conv, content, input, named, ctx)
    return { branchId: branch.id, submissionId }
  }

export async function submit(this: UserSpace, 
    tree: TreeRow,
    branch: BranchRow,
    conv: Conversation,
    content: (TextContent | ImageContent)[],
    input: { requestId: string; model?: ModelInfo; effort?: Effort },
    named: string,
    ctx: Context,): Promise<SubmissionId> {
    const agent = await conv.agent(ctx)
    const model = input.model && (agent.model?.provider !== input.model.provider || agent.model?.modelId !== input.model.id)
      ? { provider: input.model.provider, modelId: input.model.id }
      : undefined
    const thinkingLevel = input.effort && agent.thinkingLevel !== input.effort ? input.effort : undefined
    if (model || thinkingLevel) await conv.configure({ ...(model && { model }), ...(thinkingLevel && { thinkingLevel }) }, ctx)
    const submission = await conv.submit({ type: 'input', content, requestId: input.requestId }, ctx)
    await this.answered(tree, branch, conv, submission, named, ctx)
    return submission.id
  }

export async function answered(this: UserSpace, tree: TreeRow, branch: BranchRow, conv: Conversation, submission: Submission, named: string, ctx: Context): Promise<void> {
    if (!branch.title && named) await this.db.run('UPDATE branches SET title = ? WHERE id = ?', titleOf(named), branch.id)
    const title = branch.role === 'main' && tree.title === DEFAULT_TITLE && named ? titleOf(named) : tree.title
    await this.db.run('UPDATE trees SET title = ?, updatedAt = ? WHERE id = ?', title, this.now(), tree.id)
    await this.changed()
    this.branchesChanged(tree.id)

    void submission.wait(ctx).then(
      async (settled) => {
        if (settled.status !== 'unanswered' || this.closed) return
        const data: RunErrorData = { reason: settled.reason, ...(settled.detail !== undefined && { detail: JSON.stringify(settled.detail) }) }
        await conv.submit({ type: 'write', entry: { kind: RUN_ERROR_KIND, data: { ...data } } }, ctx)
      },
      () => {},
    ).catch(() => {})
  }

export async function mentioned(this: UserSpace, treeId: string, mentions: Mention[], ctx: Context): Promise<{ detail: string; kind: "plugin" | "workspace" | "chat"; id: string; label: string; }[]> {
    const active = this.plugins.active()
    return Promise.all(
      mentions.map(async (m) => {
        let detail: string
        if (m.kind === 'plugin') detail = active.includes(m.id) ? '本轮优先使用这个插件的工具。' : '这个插件现在没有开启；如果需要它，请用户先在“定制”页开启。'
        else if (m.kind === 'workspace')
          detail = await this.workspace.mentioned(treeId, m.id, ctx).then(
            (path) => `用 read 读取 ${path}。`,
            (e: unknown) => `无法读取这个文件：${e instanceof Error ? e.message : String(e)}`,
          )
        else detail = await this.transcript(m.id, ctx).then(
          (t) => `用户提到的另一个会话，内容如下，作为本轮的上下文：\n${t}`,
          () => '这个会话已经不存在。',
        )
        return { ...m, detail }
      }),
    )
  }

export async function transcript(this: UserSpace, treeId: string, ctx: Context): Promise<string> {
    const { messages } = await (await this.open((await this.branchRow(treeId)).branch, ctx)).context(ctx)
    const lines: string[] = []
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue
      const blocks = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content
      const text = blocks
        .flatMap((b) => (b.type === 'text' && !parseNote(b.text) ? [b.text] : []))
        .join('\n')
        .trim()
      if (text) lines.push(`${m.role === 'user' ? '用户' : '助手'}：${text}`)
    }
    const all = lines.join('\n\n')
    return all.length > MENTIONED_CHAT_CHARS ? `…\n${all.slice(-MENTIONED_CHAT_CHARS)}` : all || '（空会话）'
  }
