import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { BRIEF_KIND, EVENT_KIND, fauxModels, SqliteFiles, UserSpace, type EventData } from '../src/index.ts'

async function open(path = ':memory:') {
  const db = await openNodeSqliteDatabase(path)
  const files = await SqliteFiles.open(db, { id: 'x' })
  return UserSpace.open(db, { models: fauxModels(), env: (cwd) => files.env({ cwd }) })
}

type Entry = { kind: string; data?: unknown; model?: { role: string; content: string | { type: string; text?: string }[] }[] }

async function entries(space: UserSpace, treeId: string, branchId?: string) {
  const { watch } = await space.watch(treeId, branchId)
  await watch.stop()
  return (watch.value as unknown as { entries: Entry[] }).entries
}

const text = (e: Entry) =>
  (e.model ?? []).map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? '').join(''))).join('')

async function until<T>(check: () => Promise<T | undefined | false>, what: string, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    const value = await check()
    if (value) return value
  }
  throw new Error(`timed out waiting for ${what}`)
}

const agents = async (space: UserSpace, treeId: string) => (await space.branches(treeId)).branches.filter((b) => b.role === 'agent')
/** The Events of the main line; reading a branch makes it the active one, so this names the main one. */
const events = async (space: UserSpace, treeId: string) =>
  (await entries(space, treeId, (await space.branches(treeId)).branches.find((b) => b.role === 'main')!.id)).filter((e) => e.kind === EVENT_KIND).map((e) => e.data as EventData)

test('R51, R52, R56: the main line spawns subagents and answers at once; each report wakes it, one run at a time', async () => {
  const space = await open()
  const t = await space.createTree()
  const { branchId: main } = await space.send(t.id, { text: '先说背景：我们在比较三家公司', requestId: 'a' })
  await space.harness.waitForIdle(ctx)
  await space.send(t.id, { text: '[派出] [汇报] 甲公司|[汇报] 乙公司|[汇报] 丙公司', requestId: 'b' })

  // The main line's turn ends with the spawn results, before any report.
  await until(async () => (await entries(space, t.id, main)).some((e) => e.kind === 'pi.assistant' && text(e).startsWith('工具结果：已派出')), 'the spawn answer')

  const reports = await until(async () => {
    const found = await events(space, t.id)
    return found.length === 3 && found
  }, 'three reports')
  assert.deepEqual(reports.map((r) => [r.source.kind, r.type, r.wake]), Array(3).fill(['agent', 'report', true]))
  assert.deepEqual(reports.map((r) => r.title).sort(), ['完成：丙公司', '完成：乙公司', '完成：甲公司'])
  await until(async () => (await agents(space, t.id)).every((b) => b.status === 'done') && (await space.harness.waitForIdle(ctx), true), 'idle')

  // The spawn turn ended before any report; then each report woke the main line in turn, none while another ran.
  const all = await entries(space, t.id, main)
  const after = all.slice(all.findIndex((e) => e.kind === 'pi.assistant' && text(e).startsWith('工具结果：已派出')))
  assert.deepEqual(after.map((e) => e.kind).filter((k) => k === EVENT_KIND || k === 'pi.assistant'), ['pi.assistant', EVENT_KIND, 'pi.assistant', EVENT_KIND, 'pi.assistant', EVENT_KIND, 'pi.assistant'])

  // A fork knows the conversation so far (R56); its brief is the task.
  const [first] = await agents(space, t.id)
  const child = await entries(space, t.id, first!.id)
  assert.ok(child.some((e) => text(e).includes('先说背景')))
  const brief = child.find((e) => e.kind === BRIEF_KIND)!
  assert.match(text(brief), /^你是子 agent「/)
  assert.equal(first!.parentId, main)
  await space.close()
})

test('R56: a `new` subagent sees only its task', async () => {
  const space = await open()
  const t = await space.createTree()
  await space.send(t.id, { text: '秘密背景', requestId: 'a' })
  await space.harness.waitForIdle(ctx)
  await space.send(t.id, { text: '[工具 agent_spawn] {"task":"[汇报] 独立任务","title":"独立","mode":"new"}', requestId: 'b' })
  const [agent] = await until(async () => {
    const found = await agents(space, t.id)
    return found[0]?.status === 'done' && found
  }, 'report')
  const child = await entries(space, t.id, agent!.id)
  assert.ok(!child.some((e) => text(e).includes('秘密背景')))
  await until(async () => (await events(space, t.id)).length === 1, 'the report')
  await space.harness.waitForIdle(ctx)
  await space.close()
})

test('R53, R55: a subagent that ends without reporting, or is stopped, is reported for by the system', async () => {
  const space = await open()
  const t = await space.createTree()
  await space.send(t.id, { text: '[派出] 普通任务|[长回答] 慢任务', requestId: 'a' })
  const notice = await until(async () => (await events(space, t.id)).find((e) => e.title.includes('普通任务')), 'notice')
  assert.deepEqual([notice.source.kind, notice.type, notice.wake], ['system', 'notice', true])
  assert.match(notice.body, /没有调用 report[\s\S]*收到：普通任务/)

  const slow = await until(async () => (await agents(space, t.id)).find((b) => b.title === '慢任务' && b.status === 'running'), 'slow agent')
  await until(async () => (await entries(space, t.id, slow.id)).some((e) => e.kind === BRIEF_KIND), 'slow brief')
  await space.abort(t.id, slow.id)
  const stopped = await until(async () => (await events(space, t.id)).find((e) => e.title.includes('慢任务')), 'stop notice')
  assert.match(stopped.body, /被中止/)
  assert.deepEqual(
    (await agents(space, t.id)).map((b) => [b.title, b.status]),
    [
      ['普通任务', 'failed'],
      ['慢任务', 'aborted'],
    ],
  )
  await space.harness.waitForIdle(ctx)
  await space.close()
})

test('R54: the limit, and spawning from a subagent, are refused with the same tools', async () => {
  const space = await open()
  const t = await space.createTree()
  await space.send(t.id, { text: '[派出] [长回答] 一|[长回答] 二|[长回答] 三|[长回答] 四', requestId: 'a' })
  const answer = await until(async () => (await entries(space, t.id)).find((e) => e.kind === 'pi.assistant' && text(e).startsWith('工具结果')), 'spawn results')
  assert.match(text(answer), /上限/)
  assert.equal((await agents(space, t.id)).length, 3)
  for (const b of await agents(space, t.id)) await space.abort(t.id, b.id)
  await until(async () => (await agents(space, t.id)).every((b) => b.status === 'aborted'), 'stopped')

  await space.send(t.id, { text: '[工具 agent_spawn] {"task":"[工具 agent_spawn] {\\"task\\":\\"x\\",\\"title\\":\\"孙\\"}","title":"子"}', requestId: 'b' })
  const child = await until(async () => (await agents(space, t.id)).find((b) => b.title === '子' && b.status === 'failed'), 'the child ends')
  assert.ok((await entries(space, t.id, child.id)).some((e) => text(e).includes('子 agent 不能再派生')))
  assert.equal((await agents(space, t.id)).length, 4)
  await space.harness.waitForIdle(ctx)
  await space.close()
})

test('V6: a subagent cut off by a restart finishes after it and is reported once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gense-agents-'))
  const path = join(dir, 'space.sqlite')
  let space = await open(path)
  const t = await space.createTree()
  await space.send(t.id, { text: '[派出] [长回答] 长任务', requestId: 'a' })
  const agent = await until(async () => (await agents(space, t.id))[0], 'agent')
  await until(async () => {
    const live = (await space.watch(t.id, agent.id)).watch
    await live.stop()
    const doc = (live.value as unknown as { docs: Record<string, { generation?: { message?: { content?: { text?: string }[] } } }> }).docs['pi.live']
    return (doc?.generation?.message?.content?.[0]?.text?.length ?? 0) > 50
  }, 'a partial answer')
  await space.close()

  space = await open(path)
  const notice = await until(async () => (await events(space, t.id)).find((e) => e.title.includes('长任务')), 'notice after restart', 30_000)
  assert.match(notice.body, /第 300 句/)
  await space.harness.waitForIdle(ctx)
  assert.equal((await events(space, t.id)).length, 1)
  assert.equal((await entries(space, t.id, agent.id)).filter((e) => e.kind === BRIEF_KIND).length, 1)
  await space.close()
  await rm(dir, { recursive: true, force: true })
})
