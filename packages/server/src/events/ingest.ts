import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import type { ConversationWatch, SubmissionId } from '@earendil-works/pi-durable'
import type { InboundTrigger, OutboxItem } from '../channels/channel.ts'
import type { UserSpace } from '../agent/space.ts'
import type { send as sendInput } from '../agent/branches.ts'
import { entryText } from '../agent/shared.ts'
import type { StoredTrigger } from './store.ts'

type SendInput = Parameters<typeof sendInput>[1]
type SendResult = Awaited<ReturnType<typeof sendInput>>
export function serial<T>(space: UserSpace, key: string, work: () => Promise<T>): Promise<T> {
  const prior = space.ingestQueues.get(key) ?? Promise.resolve()
  const operation = prior.catch(() => {}).then(work)
  space.ingestQueues.set(key, operation)
  void operation.finally(() => { if (space.ingestQueues.get(key) === operation) space.ingestQueues.delete(key) }).catch(() => {})
  return operation
}
export function webSend(this: UserSpace, treeId: string, input: SendInput, ctx: Context = BACKGROUND_CONTEXT): Promise<SendResult> {
  return serial(this, 'web:' + input.requestId, async () => {
    if (!input.requestId || input.requestId.length > 512) throw new Error('requestId 无效')
    await this.row(treeId)
    await this.checkModel(input.model)
    const admitted = await this.triggers.admit({ id: input.requestId, source: 'web', thread: { key: treeId, label: '网页', group: false }, actor: { id: 'owner', name: '所有者' }, text: input.text, treeId }, this.channels.isAllowed('web', 'owner'), { webInput: input })
    if (admitted.row.source !== 'web' || admitted.row.tree_id !== treeId) throw new Error('requestId 已被其他来源或会话使用')
    if (admitted.row.result) return JSON.parse(admitted.row.result) as SendResult
    if (admitted.row.decision === 'rejected') throw new Error('准入拒绝')
    const payload = JSON.parse(admitted.row.payload) as { webInput: SendInput }
    const result = await this.sendInput(treeId, payload.webInput, ctx)
    await this.triggers.delivered(input.requestId, result)
    return result
  })
}

export function ingestChannel(this: UserSpace, trigger: InboundTrigger): Promise<unknown> {
  return serial(this, trigger.source + ':' + trigger.thread.key, async () => {
    const admitted = await this.triggers.admit(trigger, this.channels.isAllowed(trigger.source, trigger.actor.id))
    if (admitted.duplicate) return { decision: 'duplicate', treeId: admitted.row.tree_id }
    if (admitted.row.decision === 'rejected') return { decision: 'rejected' }
    return this.processChannel(admitted.row)
  })
}

export async function processChannel(this: UserSpace, row: StoredTrigger) {
  const trigger = JSON.parse(row.payload) as InboundTrigger
  let treeId = row.tree_id ?? await this.triggers.thread(row.source, row.thread_key)
  if (!treeId || !(await this.db.get('SELECT id FROM trees WHERE id = ?', treeId))) {
    treeId = (await this.createTree()).id
    await this.db.run('UPDATE trees SET source = ? WHERE id = ?', JSON.stringify({ kind: row.source, label: trigger.thread.label }), treeId)
    await this.triggers.setThread(row.source, row.thread_key, treeId)
    const { branch } = await this.branchRow(treeId)
    const persona = this.channels.resolved(row.source).persona
    if (typeof persona === 'string' && persona.trim()) await (await this.open(branch, BACKGROUND_CONTEXT)).configure({ instructions: persona }, BACKGROUND_CONTEXT)
    await this.changed()
  }
  await this.triggers.bind(row.id, treeId)
  let result = row.result ? JSON.parse(row.result) as SendResult & { final?: boolean } : undefined
  if (result?.final) return { decision: 'accepted', treeId }
  if (!result) {
    const branch = await this.mainBranch(treeId)
    const text = trigger.text + (trigger.context ? `\n\n<event source="channel-context">\n${trigger.context}\n</event>` : '')
    result = await this.sendInput(treeId, { text, requestId: row.id, branchId: branch.id, attachments: trigger.attachments })
    await this.triggers.delivered(row.id, result)
  }
  this.monitorChannel(row.id, treeId, result)
  return { decision: 'accepted', treeId, ...result }
}

export function monitorChannel(this: UserSpace, triggerId: string, treeId: string, result: SendResult) {
  if (this.channelRuns.has(triggerId)) return
  const job = async () => {
    const ctx = BACKGROUND_CONTEXT
    const submission = await this.harness.submission(result.submissionId as SubmissionId, ctx)
    if (!submission) throw new Error('Channel submission missing')
    let watch: ConversationWatch | undefined
    try {
      watch = (await this.watch(treeId, result.branchId)).watch
      this.channelWatches.add(watch)
      const render = (value: unknown) => {
        const entries = (value as { entries?: Parameters<typeof entryText>[0][] })?.entries ?? []
        const user = entries.findLast(e => e.kind === 'pi.user')
        const last = entries.findLast(e => e.kind === 'pi.assistant' && (!user || e.id > user.id))
        const text = last ? entryText(last) : ''
        if (text) void this.triggers.get(triggerId).then(row => row && this.channels.render(row.source, triggerId, treeId, text)).catch(() => {})
      }
      render(watch.value)
      watch.start(async value => { render(value) })
      const settled = await submission.wait(ctx)
      if (this.closed) return
      const row = await this.triggers.get(triggerId)
      if (!row) return
      const trigger = JSON.parse(row.payload) as InboundTrigger
      const { branch } = await this.branchRow(treeId, result.branchId), conv = await this.open(branch, ctx)
      const { entries } = await conv.context(ctx)
      const answerId = settled.status === 'done' && settled.type === 'input' ? settled.answer : undefined
      const answer = entries.find(e => e.id === answerId)
      const text = answer ? entryText(answer) : settled.status === 'unanswered' ? `本次回答已停止或失败（${settled.reason}）。` : '本次回答已结束。'
      const runEntries = entries.filter(e => e.kind !== 'pi.user' && settled.entry !== undefined && e.id >= settled.entry && (answerId === undefined || e.id <= answerId)).map(e => ({ id: e.id, kind: e.kind, model: e.model }))
      const items: OutboxItem[] = [{ id: triggerId + ':final', channelId: row.source, triggerId, treeId, kind: 'message', payload: { ...trigger.destination, text, treeId, entries: runEntries } }]
      const workspace = await this.workspace.list(treeId)
      for (const file of workspace.filter(f => !f.readOnly && f.size <= 50 * 1024 * 1024)) {
        const relative = file.path.slice(`/data/sessions/${treeId}/`.length)
        if (text.includes(file.path) || text.includes('](' + relative + ')') || text.includes('`' + relative + '`')) items.push({ id: triggerId + ':file:' + relative, channelId: row.source, triggerId, treeId, kind: 'file', payload: { ...trigger.destination, path: file.path } })
      }
      await this.triggers.complete(triggerId, { ...result, final: true }, items)
      void this.outbox.drain()
    } finally { if (watch) { this.channelWatches.delete(watch); await watch.stop().catch(() => {}) } }
  }
  const operation = job().catch(() => {}).finally(() => { this.channelRuns.delete(triggerId) })
  this.channelRuns.set(triggerId, operation)
}

export async function recoverTriggers(this: UserSpace) {
  const rows = await this.db.all<StoredTrigger>("SELECT * FROM triggers WHERE decision = 'accepted' ORDER BY created_at, rowid")
  for (const row of rows) {
    const payload = JSON.parse(row.payload)
    if (payload.event) {
      if (!row.delivered_at) await this.deliver({ id: row.id, treeId: row.tree_id!, branchId: payload.branchId, data: JSON.stringify(payload.event), wake: payload.event.wake ? 1 : 0 }, BACKGROUND_CONTEXT)
    } else if (row.source === 'web') {
      if (!row.delivered_at && row.tree_id) await this.send(row.tree_id, payload.webInput)
    } else if (!payload.command && !(row.result && JSON.parse(row.result).final)) await this.processChannel(row)
  }
}
