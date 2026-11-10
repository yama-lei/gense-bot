// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// A tree is a main conversation and the branches forked from it, all ownerless; tree and branch ids are ours,
// conversation ids are pi-durable's. Each tree has one workspace directory, every branch's cwd (D6).
import { BACKGROUND_CONTEXT,type Context } from '@earendil-works/chord/context'

import {
type ScheduleInfo,
type ScheduleRule
} from '@gense/protocol'

import {
checkRule,
checkTimeZone,
nextRun
} from '../events/tasks.ts'

import { SCHEDULE_COLUMNS,type ScheduleRow,toSchedule } from './shared.ts'

import type { UserSpace } from './space.ts'
export function subscribeAutomations(this: UserSpace, listener: () => void): () => undefined {
    this.automationListeners.add(listener)
    return () => void this.automationListeners.delete(listener)
  }

export function automationsChanged(this: UserSpace): void {
    if (!this.closed) for (const l of this.automationListeners) l()
  }

export async function schedules(this: UserSpace): Promise<ScheduleInfo[]> {
    return (await this.db.all<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules ORDER BY createdAt`)).map(toSchedule)
  }

export async function scheduleRow(this: UserSpace, id: string): Promise<ScheduleRow> {
    const row = await this.db.get<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?`, id)
    if (!row) throw new Error('定时任务不存在')
    return row
  }

export async function createSchedule(this: UserSpace, treeId: string, input: { name: string; prompt: string; rule: ScheduleRule; tz: string }, ctx: Context = BACKGROUND_CONTEXT): Promise<ScheduleInfo> {
    await this.row(treeId)
    const name = input.name.trim()
    const prompt = input.prompt.trim()
    if (!name || !prompt) throw new Error('名称和内容不能为空')
    checkRule(input.rule)
    checkTimeZone(input.tz)
    const row: ScheduleRow = {
      id: crypto.randomUUID(),
      treeId,
      name,
      prompt,
      rule: JSON.stringify(input.rule),
      tz: input.tz,
      enabled: 1,
      taskId: null,
      nextRunAt: null,
      lastRunAt: null,
      lastResult: '',
      createdAt: this.now(),
    }
    await this.db.run(
      `INSERT INTO schedules (${SCHEDULE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '', ?)`,
      row.id,
      treeId,
      name,
      prompt,
      row.rule,
      row.tz,
      row.enabled,
      row.createdAt,
    )
    try {
      await this.startSchedule(row, ctx)
    } catch (e) {
      await this.db.run('DELETE FROM schedules WHERE id = ?', row.id)
      throw e
    }
    this.automationsChanged()
    return toSchedule(await this.scheduleRow(row.id))
  }

export async function startSchedule(this: UserSpace, row: ScheduleRow, ctx: Context): Promise<void> {
    const at = nextRun(JSON.parse(row.rule) as ScheduleRule, row.tz, this.now())
    if (at === null) throw new Error('执行时间已经过了')
    const conv = await this.open(await this.mainBranch(row.treeId), ctx)
    const taskId = await conv.commit(
      (tx) => tx.createTask(this.schedule, { scheduleId: row.id, at }, { ownership: { kind: 'conversation' }, background: true }),
      ctx,
    )
    await this.db.run('UPDATE schedules SET enabled = 1, taskId = ?, nextRunAt = ? WHERE id = ?', taskId, at, row.id)
  }

export async function stopSchedule(this: UserSpace, row: ScheduleRow, ctx: Context): Promise<void> {
    if (row.taskId !== null) await this.harness.abortTask(row.taskId as never, ctx).catch(() => {})
    await this.db.run('UPDATE schedules SET enabled = 0, taskId = NULL, nextRunAt = NULL WHERE id = ?', row.id)
  }

export async function updateSchedule(this: UserSpace, id: string, enabled: boolean, ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    const row = await this.scheduleRow(id)
    if (enabled && row.enabled !== 1) await this.startSchedule(row, ctx)
    if (!enabled && row.enabled === 1) await this.stopSchedule(row, ctx)
    this.automationsChanged()
  }

export async function deleteSchedule(this: UserSpace, id: string, ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.stopSchedule(await this.scheduleRow(id), ctx)
    await this.db.run('DELETE FROM schedules WHERE id = ?', id)
    this.automationsChanged()
  }

export async function fireSchedule(this: UserSpace, id: string, at: number, ctx: Context): Promise<number | null> {
    const row = await this.db.get<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?`, id)
    if (!row || row.enabled !== 1) return null
    let result = '已发送'
    try {
      await this.emit(row.treeId, { source: { kind: 'schedule', id, label: row.name }, type: 'tick', title: row.name, body: row.prompt, wake: true }, { key: `schedule:${id}:${at}` }, ctx)
    } catch (e) {
      result = `失败：${e instanceof Error ? e.message : String(e)}`
    }
    // Runs missed while the host was down are skipped, not made up.
    const next = nextRun(JSON.parse(row.rule) as ScheduleRule, row.tz, Math.max(at, this.now()))
    await this.db.run(
      'UPDATE schedules SET lastRunAt = ?, lastResult = ?, nextRunAt = ?, enabled = ?, taskId = ? WHERE id = ?',
      at,
      result,
      next,
      next === null ? 0 : 1,
      next === null ? null : row.taskId,
      id,
    )
    this.automationsChanged()
    return next
  }