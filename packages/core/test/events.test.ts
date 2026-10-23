import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { BRIEF_KIND, EVENT_KIND, fauxModels, hmac, nextRun, SqliteFiles, UserSpace, type EventData } from '../src/index.ts'

/** A space on a clock the test moves; sleeping tasks run when it calls `harness.resume()`. */
async function open() {
  const clock = { now: Date.UTC(2026, 9, 23, 0, 0) }
  const now = () => clock.now
  const db = await openNodeSqliteDatabase(':memory:')
  const files = await SqliteFiles.open(db, { id: 'x' })
  const space = await UserSpace.open(db, {
    models: fauxModels(),
    env: (cwd) => files.env({ cwd }),
    secretKey: 'test key',
    hooksPath: () => '/hooks/u1',
    now,
    harness: { now, onWake: () => {} },
  })
  return { space, clock }
}

type Entry = { kind: string; data?: unknown; model?: { content: string | { type: string; text?: string }[] }[] }

async function entries(space: UserSpace, treeId: string, branchId?: string) {
  const { watch } = await space.watch(treeId, branchId)
  await watch.stop()
  return (watch.value as unknown as { entries: Entry[] }).entries
}

const text = (e: Entry) =>
  (e.model ?? []).map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? '').join(''))).join('')

async function until<T>(check: () => Promise<T | undefined | false>, what: string) {
  for (let i = 0; i < 200; i++) {
    const value = await check()
    if (value) return value
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('R49: schedule rules give their next run in the time zone', () => {
  const at = (iso: string) => Date.parse(iso)
  // 08:00 in Shanghai is 00:00 UTC.
  assert.equal(nextRun({ kind: 'daily', time: '08:00' }, 'Asia/Shanghai', at('2026-10-23T00:00:00Z')), at('2026-10-24T00:00:00Z'))
  assert.equal(nextRun({ kind: 'daily', time: '08:00' }, 'Asia/Shanghai', at('2026-10-22T23:59:00Z')), at('2026-10-23T00:00:00Z'))
  // 2026-10-23 is a Friday; the next Monday or Wednesday at 09:30 New York (EDT until 1 November, EST after).
  assert.equal(nextRun({ kind: 'weekly', days: [1, 3], time: '09:30' }, 'America/New_York', at('2026-10-23T12:00:00Z')), at('2026-10-26T13:30:00Z'))
  assert.equal(nextRun({ kind: 'weekly', days: [1], time: '09:30' }, 'America/New_York', at('2026-10-27T12:00:00Z')), at('2026-11-02T14:30:00Z'))
  assert.equal(nextRun({ kind: 'interval', minutes: 30 }, 'UTC', 1000), 1000 + 30 * 60_000)
  assert.equal(nextRun({ kind: 'once', at: 5000 }, 'UTC', 1000), 5000)
  assert.equal(nextRun({ kind: 'once', at: 5000 }, 'UTC', 5000), null)
})

test('R46–R48: an Event that does not wake waits for the next turn; one that wakes starts a run; a key delivers once', async () => {
  const { space } = await open()
  const t = await space.createTree()
  await space.send(t.id, { text: '你好', requestId: 'a' })
  await space.harness.waitForIdle(ctx)

  const quiet = await space.emit(t.id, { source: { kind: 'system', id: 's', label: '系统' }, type: 'notice', title: '安静', body: '不用回答', wake: false })
  await space.harness.waitForIdle(ctx)
  let all = await entries(space, t.id)
  assert.equal(all.at(-1)!.kind, EVENT_KIND)
  assert.equal((all.at(-1)!.data as EventData).id, quiet.id)
  assert.equal(all.filter((e) => e.kind === 'pi.assistant').length, 1, 'no run')

  const loud = { source: { kind: 'webhook' as const, id: 'w', label: 'CI' }, type: 'webhook' as const, title: '构建失败', body: 'main 分支', wake: true }
  const first = await space.emit(t.id, loud, { key: 'k1' })
  const again = await space.emit(t.id, loud, { key: 'k1' })
  assert.equal(again.id, first.id)
  await space.harness.waitForIdle(ctx)
  all = await entries(space, t.id)
  assert.equal(all.filter((e) => e.kind === EVENT_KIND).length, 2)
  const answer = all.at(-1)!
  assert.equal(answer.kind, 'pi.assistant')
  assert.match(text(answer), /^收到：<event source="webhook" from="CI" type="webhook">\n构建失败/)

  // Past six wakes a minute, an Event only lands in the transcript.
  for (let i = 0; i < 6; i++) await space.emit(t.id, { ...loud, title: `第 ${i} 次` })
  const muted = await space.emit(t.id, { ...loud, title: '太多了' })
  assert.equal(muted.wake, false)
  await space.harness.waitForIdle(ctx)
})

test('R40: a branch summarizes itself to the main line; report is refused on the main line', async () => {
  const { space } = await open()
  const t = await space.createTree()
  const { branchId: main } = await space.send(t.id, { text: '开始', requestId: 'a' })
  await space.harness.waitForIdle(ctx)
  const b = (await space.fork(t.id, main, (await space.branches(t.id)).branches[0]!.lastEntryId!)).id
  await space.send(t.id, { text: '查一下资料', requestId: 'b', branchId: b })
  await space.harness.waitForIdle(ctx)

  await assert.rejects(space.summarize(t.id, main, 'm'), /只有分叉/)
  await space.summarize(t.id, b, 's')
  await space.harness.waitForIdle(ctx)
  const branch = await entries(space, t.id, b)
  assert.ok(branch.some((e) => e.kind === BRIEF_KIND))
  assert.match(text(branch.at(-1)!), /已交给主线/)
  const report = (await entries(space, t.id, main)).at(-1)!
  assert.equal(report.kind, EVENT_KIND)
  const data = report.data as EventData
  assert.deepEqual([data.type, data.source.kind, data.title, data.wake], ['report', 'branch', '分叉总结', false])
  assert.match(data.body, /查一下资料/)

  await space.send(t.id, { text: '[工具 report] {"title":"x","body":"y"}', requestId: 'c', branchId: main })
  await space.harness.waitForIdle(ctx)
  assert.match(text((await entries(space, t.id, main)).at(-1)!), /已经在主线上/)
})

test('R49: a schedule fires on its clock, pauses, resumes and is removed with its tree', async () => {
  const { space, clock } = await open()
  const t = await space.createTree()
  const s = await space.createSchedule(t.id, { name: '巡检', prompt: '看看服务器', rule: { kind: 'interval', minutes: 30 }, tz: 'Asia/Shanghai' })
  assert.equal(s.nextRunAt, clock.now + 30 * 60_000)
  space.harness.resume()
  await sleep(50)
  assert.equal((await space.schedules())[0]!.lastRunAt, null, 'not before its time')

  clock.now += 30 * 60_000
  space.harness.resume()
  const fired = await until(async () => (await space.schedules())[0]!.lastRunAt !== null && (await space.schedules())[0], 'first run')
  assert.equal(fired.lastResult, '已发送')
  assert.equal(fired.nextRunAt, clock.now + 30 * 60_000)
  await space.harness.waitForIdle(ctx)
  const tick = (await entries(space, t.id)).find((e) => e.kind === EVENT_KIND)!
  assert.deepEqual([(tick.data as EventData).type, (tick.data as EventData).body], ['tick', '看看服务器'])
  await until(async () => (await entries(space, t.id)).at(-1)!.kind === 'pi.assistant', 'answer')

  await space.updateSchedule(s.id, false)
  assert.equal((await space.schedules())[0]!.nextRunAt, null)
  clock.now += 60 * 60_000
  space.harness.resume()
  await sleep(50)
  assert.equal((await entries(space, t.id)).filter((e) => e.kind === EVENT_KIND).length, 1, 'paused')

  await space.updateSchedule(s.id, true)
  assert.equal((await space.schedules())[0]!.nextRunAt, clock.now + 30 * 60_000)
  await space.deleteTree(t.id)
  assert.deepEqual(await space.schedules(), [])
  await assert.rejects(space.createSchedule(t.id, { name: 'x', prompt: 'y', rule: { kind: 'daily', time: '08:00' }, tz: 'UTC' }), /会话不存在/)
})

test('R50: a webhook call needs a fresh signature, and its idempotency key delivers once', async () => {
  const { space, clock } = await open()
  const t = await space.createTree()
  const { webhook, secret } = await space.createWebhook(t.id)
  assert.equal(webhook.path, `/hooks/u1/${webhook.id}`)
  assert.ok(!JSON.stringify(await space.webhooks()).includes(secret), 'the secret is not listed')

  const call = async (body: string, options: { secret?: string; ts?: number; key?: string } = {}) => {
    const ts = String(Math.floor((options.ts ?? clock.now) / 1000))
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-gense-timestamp': ts,
      'x-gense-signature': `sha256=${await hmac(options.secret ?? secret, `${ts}.${body}`)}`,
      ...(options.key && { 'idempotency-key': options.key }),
    }
    return space.handleWebhook(webhook.id, new Request(`http://x${webhook.path}`, { method: 'POST', headers, body }))
  }
  const body = JSON.stringify({ title: '部署完成', text: 'v1.2 已上线' })
  assert.equal((await call(body, { secret: 'whsec_wrong' })).status, 401)
  assert.equal((await call(body, { ts: clock.now - 10 * 60_000 })).status, 401)
  assert.equal((await space.handleWebhook(webhook.id, new Request('http://x', { method: 'POST', body }))).status, 401)
  assert.equal((await space.handleWebhook('nope', new Request('http://x', { method: 'POST', body }))).status, 404)

  const ok = await call(body, { key: 'deploy-1' })
  assert.equal(ok.status, 202)
  const { eventId } = (await ok.json()) as { eventId: string }
  assert.equal(((await (await call(body, { key: 'deploy-1' })).json()) as { eventId: string }).eventId, eventId)
  await space.harness.waitForIdle(ctx)
  const events = (await entries(space, t.id)).filter((e) => e.kind === EVENT_KIND)
  assert.equal(events.length, 1)
  assert.deepEqual([(events[0]!.data as EventData).title, (events[0]!.data as EventData).body], ['部署完成', 'v1.2 已上线'])
  assert.notEqual((await space.webhooks())[0]!.lastUsedAt, null)

  // A new webhook replaces the old one; the old secret and path stop working.
  const { webhook: next } = await space.createWebhook(t.id)
  assert.notEqual(next.id, webhook.id)
  assert.equal((await call(body, { key: 'deploy-2' })).status, 404)
  await space.deleteWebhook(next.id)
  assert.deepEqual(await space.webhooks(), [])
})
