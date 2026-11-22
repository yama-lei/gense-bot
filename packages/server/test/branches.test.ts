import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fauxModels, UserSpace } from '../src/index.ts'
import { btw } from '../src/agent/btw.ts'
import { diskEnv } from './fixtures.ts'

async function open() {
  const db = await openNodeSqliteDatabase(':memory:')
  return UserSpace.open(db, { models: fauxModels(), env: await diskEnv() })
}

type Entry = { id: number; kind: string; model?: { content: unknown }[] }
const texts = (value: unknown) =>
  (value as { entries: Entry[] }).entries
    .filter((e) => e.kind === 'pi.user' || e.kind === 'pi.assistant')
    .map((e) => JSON.stringify(e.model?.[0]?.content).match(/"text":"([^"]*)"/)?.[1] ?? '')

async function view(space: UserSpace, treeId: string, branchId?: string) {
  const { watch } = await space.watch(treeId, branchId)
  await watch.stop()
  return watch.value as unknown as { entries: Entry[] }
}

test('edits and retries are versions of a message, branches of one tree', async () => {
  const space = await open()
  const changes: string[] = []
  space.subscribeBranches((id) => changes.push(id))
  const t = await space.createTree()
  const { branchId: main } = await space.send(t.id, { text: '一', requestId: 'a' })
  await space.harness.waitForIdle(ctx)
  await space.send(t.id, { text: '二', requestId: 'b' })
  await space.harness.waitForIdle(ctx)
  const entries = (await view(space, t.id)).entries
  const users = entries.filter((e) => e.kind === 'pi.user')
  const firstAnswer = entries.find((e) => e.kind === 'pi.assistant')!

  // An edit of the second message forks before it; the original stays on the main branch.
  const edit = await space.send(t.id, { text: '二改', requestId: 'c', replace: users[1]!.id })
  await space.harness.waitForIdle(ctx)
  assert.notEqual(edit.branchId, main)
  assert.deepEqual(texts(await view(space, t.id, edit.branchId)), ['一', '收到：一', '二改', '收到：二改'])
  assert.deepEqual(texts(await view(space, t.id, main)), ['一', '收到：一', '二', '收到：二'])

  // A retry of the second message asks it again beside the other two.
  const retry = await space.regenerate(t.id, main, users[1]!.id, { requestId: 'r' })
  await space.harness.waitForIdle(ctx)
  assert.equal(retry.forkEntryId, firstAnswer.id)
  assert.deepEqual(texts(await view(space, t.id, retry.id)), ['一', '收到：一', '二', '收到：二'])

  // A retry of the first message has nothing before it: a new conversation beside it.
  const again = await space.regenerate(t.id, main, users[0]!.id, { requestId: 'd' })
  await space.harness.waitForIdle(ctx)
  assert.equal(again.forkEntryId, null)
  assert.deepEqual(texts(await view(space, t.id, again.id)), ['一', '收到：一'])

  const state = await space.branches(t.id)
  assert.equal(state.branches.length, 4)
  assert.equal(state.activeBranchId, again.id, 'the newest version is the active branch')
  const byId = Object.fromEntries(state.branches.map((b) => [b.id, b]))
  assert.equal(byId[main]!.role, 'main')
  assert.equal(byId[edit.branchId]!.role, 'version')
  assert.equal(byId[edit.branchId]!.title, '二改')
  assert.equal(byId[retry.id]!.status, 'idle')
  assert.deepEqual(state.versions[String(firstAnswer.id)], [main, edit.branchId, retry.id])
  assert.deepEqual(state.versions.start, [main, again.id])
  // One tree in the list, titled after the main branch.
  const trees = await space.trees()
  assert.equal(trees.length, 1)
  assert.equal(trees[0]!.title, '一')
  assert.ok(changes.includes(t.id))
  await space.close()
})

test('btw answers from the shown branch without writing to it', async () => {
  const space = await open()
  const t = await space.createTree()
  await space.send(t.id, { text: '我们在讨论数据库索引', requestId: 'a' })
  await space.harness.waitForIdle(ctx)
  const before = await view(space, t.id)
  const updates: string[] = []
  const text = await btw(space, t.id, { question: '顺便问一下，B 树是什么？' }, (s) => updates.push(s), new AbortController().signal)
  // The faux model echoes the side call's user message: the conversation's text, then the question.
  assert.match(text, /^顺便回答：/)
  assert.match(text, /<conversation>[\s\S]*我们在讨论数据库索引[\s\S]*收到：我们在讨论数据库索引[\s\S]*<\/conversation>/)
  assert.match(text, /<question>\n顺便问一下，B 树是什么？\n<\/question>/)
  assert.ok(updates.length > 0 && updates.at(-1) === text, 'the answer streams')
  assert.deepEqual((await view(space, t.id)).entries.map((e) => e.id), before.entries.map((e) => e.id), 'nothing is written to the branch')
  assert.equal((await space.branches(t.id)).branches.length, 1)

  await assert.rejects(btw(space, t.id, { question: '  ' }, () => {}, new AbortController().signal), /不能为空/)
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(btw(space, t.id, { question: '还在吗？' }, () => {}, abort.signal), /已取消/)
  await space.close()
})

test('migration 10: old forks become versions and every tree opens on its main line', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'migration-')), 'space.sqlite')
  let space = await UserSpace.open(await openNodeSqliteDatabase(path), { models: fauxModels(), env: await diskEnv() })
  const t = await space.createTree()
  const { branchId: main } = await space.send(t.id, { text: '一', requestId: 'a' })
  await space.harness.waitForIdle(ctx)
  const first = (await view(space, t.id)).entries.find((e) => e.kind === 'pi.user')!
  const { branchId: edit } = await space.send(t.id, { text: '一改', requestId: 'b', replace: first.id })
  await space.harness.waitForIdle(ctx)
  await space.close()
  // As an older build left it: the edit is a `user` branch, and it is where the tree was last open.
  const db = await openNodeSqliteDatabase(path)
  await db.exec("UPDATE branches SET role = 'user' WHERE role = 'version'")
  await db.exec(`UPDATE trees SET activeBranchId = '${edit}'`)
  await db.exec('UPDATE app_migrations SET version = 9')
  space = await UserSpace.open(db, { models: fauxModels(), env: await diskEnv() })
  const state = await space.branches(t.id)
  assert.equal(state.activeBranchId, main)
  assert.equal(state.branches.find((b) => b.id === edit)!.role, 'version')
  assert.deepEqual(state.versions.start, [main, edit])
  await space.close()
})

test('a running branch reports running until its run ends', async () => {
  const space = await open()
  const t = await space.createTree()
  const seen: string[] = []
  space.subscribeBranches(async (id) => seen.push((await space.branches(id)).branches[0]!.status))
  await space.send(t.id, { text: '[长回答]', requestId: 'a' })
  await space.harness.waitForIdle(ctx)
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(seen.includes('running'), seen.join())
  assert.equal((await space.branches(t.id)).branches[0]!.status, 'idle')
  await space.deleteTree(t.id)
  assert.deepEqual(await space.trees(), [])
  await space.close()
})
