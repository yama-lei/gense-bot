import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fauxModels, SqliteFiles, UserSpace } from '../src/index.ts'

async function open() {
  const db = await openNodeSqliteDatabase(':memory:')
  const files = await SqliteFiles.open(db, { id: 'x' })
  return UserSpace.open(db, { models: fauxModels(), env: (cwd) => files.env({ cwd }) })
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

test('forks, edits and regenerations are branches of one tree, with versions per message', async () => {
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

  // A regeneration of the first message has nothing before it: a new conversation beside it.
  const again = await space.regenerate(t.id, main, users[0]!.id, { requestId: 'd' })
  await space.harness.waitForIdle(ctx)
  assert.equal(again.forkEntryId, null)
  assert.deepEqual(texts(await view(space, t.id, again.id)), ['一', '收到：一'])

  // A fork after the first answer starts empty and is named by its first message.
  const fork = await space.fork(t.id, main, firstAnswer.id)
  assert.equal(fork.title, '')
  await space.send(t.id, { text: '三', requestId: 'e', branchId: fork.id })
  await space.harness.waitForIdle(ctx)

  const state = await space.branches(t.id)
  assert.equal(state.branches.length, 4)
  assert.equal(state.activeBranchId, fork.id, 'a fork becomes the active branch')
  const byId = Object.fromEntries(state.branches.map((b) => [b.id, b]))
  assert.equal(byId[main]!.role, 'main')
  assert.equal(byId[fork.id]!.title, '三')
  assert.equal(byId[fork.id]!.status, 'idle')
  assert.match(byId[edit.branchId]!.preview, /收到：二改/)
  // The second message has two versions (main's and the edit; the fork's 三 continues the same entry too).
  const key = String(firstAnswer.id)
  assert.deepEqual(state.versions[key], [main, edit.branchId, fork.id])
  assert.deepEqual(state.versions.start, [main, again.id])
  // One tree in the list, titled after the main branch.
  const trees = await space.trees()
  assert.equal(trees.length, 1)
  assert.equal(trees[0]!.title, '一')
  assert.ok(changes.includes(t.id))
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
