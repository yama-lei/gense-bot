import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHANGED, fauxModels, MUST_READ, SKILLS_DIR, SqliteFiles, treeDir, UserSpace } from '../src/index.ts'

async function open() {
  const db = await openNodeSqliteDatabase(':memory:')
  const files = await SqliteFiles.open(db, { id: 'x' })
  const space = await UserSpace.open(db, { models: fauxModels(), env: (cwd) => files.env({ cwd }) })
  return { space, files }
}

type Entry = { kind: string; model?: { content: { type: string; text?: string }[] }[] }

/** Runs one tool call on a branch and resolves to what the model was told. */
async function call(space: UserSpace, treeId: string, branchId: string, tool: string, args: object) {
  await space.send(treeId, { text: `[工具 ${tool}] ${JSON.stringify(args)}`, requestId: crypto.randomUUID(), branchId })
  await space.harness.waitForIdle(ctx)
  const { watch } = await space.watch(treeId, branchId)
  await watch.stop()
  const answer = (watch.value as unknown as { entries: Entry[] }).entries.findLast((e) => e.kind === 'pi.assistant')!
  return answer.model![0]!.content.map((b) => b.text ?? '').join('')
}

test('R43, R44: a branch changes a file only as it last read it', async () => {
  const { space, files } = await open()
  const t = await space.createTree()
  const { branchId: a } = await space.send(t.id, { text: '开始', requestId: 'a' })
  await space.harness.waitForIdle(ctx)
  const b = (await space.fork(t.id, a, (await space.branches(t.id)).branches[0]!.lastEntryId!)).id
  const env = await files.env({ cwd: treeDir(t.id) })
  const content = async () => {
    const r = await env.readTextFile(`${treeDir(t.id)}/f.txt`, ctx)
    return r.ok ? r.value : null
  }

  // A new file needs no read; changing it again does not either, the ledger holds what this branch wrote.
  assert.match(await call(space, t.id, a, 'write', { path: 'f.txt', content: 'one' }), /Successfully wrote/)
  assert.match(await call(space, t.id, a, 'edit', { path: 'f.txt', edits: [{ oldText: 'one', newText: 'two' }] }), /Successfully/)

  // Branch b shares the directory but has not read the file.
  assert.match(await call(space, t.id, b, 'write', { path: 'f.txt', content: 'b' }), new RegExp(MUST_READ))
  assert.match(await call(space, t.id, b, 'delete', { path: 'f.txt' }), new RegExp(MUST_READ))
  assert.match(await call(space, t.id, b, 'read', { path: 'f.txt' }), /two/)
  assert.match(await call(space, t.id, b, 'write', { path: 'f.txt', content: 'three' }), /Successfully wrote/)

  // Now a's view is stale until it reads again.
  assert.match(await call(space, t.id, a, 'edit', { path: 'f.txt', edits: [{ oldText: 'three', newText: 'four' }] }), new RegExp(CHANGED))
  assert.equal(await content(), 'three')
  await call(space, t.id, a, 'read', { path: 'f.txt' })
  assert.match(await call(space, t.id, a, 'edit', { path: 'f.txt', edits: [{ oldText: 'three', newText: 'four' }] }), /Successfully/)

  // A change from the file panel counts too, and a deleted file is not quietly written again.
  await space.workspace.delete(t.id, 'f.txt')
  assert.match(await call(space, t.id, a, 'write', { path: 'f.txt', content: 'five' }), new RegExp(CHANGED))
  assert.equal(await content(), null)
  assert.match(await call(space, t.id, a, 'read', { path: 'f.txt' }), /not found|ENOENT|不存在|No such/i)
  assert.match(await call(space, t.id, a, 'write', { path: 'f.txt', content: 'five' }), /Successfully wrote/)

  // delete removes a file this branch read.
  await env.writeFile(`${treeDir(t.id)}/g.txt`, 'g', ctx)
  await call(space, t.id, b, 'read', { path: 'g.txt' })
  assert.match(await call(space, t.id, b, 'delete', { path: 'g.txt' }), /Deleted/)
  assert.deepEqual(await env.exists(`${treeDir(t.id)}/g.txt`, ctx), { ok: true, value: false })
})

test('R45: the file tools stay in the tree; Skills are read-only; an @-mentioned file of another tree is copied in', async () => {
  const { space, files } = await open()
  const t = await space.createTree()
  const other = await space.createTree()
  const { branchId } = await space.send(t.id, { text: '开始', requestId: 'a' })
  await space.harness.waitForIdle(ctx)
  const env = await files.env({ cwd: '/data' })
  await env.writeFile(`${treeDir(other.id)}/secret.txt`, '别的会话', ctx)

  assert.match(await call(space, t.id, branchId, 'read', { path: `${treeDir(other.id)}/secret.txt` }), /只能读取本会话工作区/)
  assert.match(await call(space, t.id, branchId, 'read', { path: '../x.txt' }), /只能读取本会话工作区/)
  assert.match(await call(space, t.id, branchId, 'write', { path: `${treeDir(other.id)}/secret.txt`, content: 'x' }), /只能修改本会话工作区/)
  await env.writeFile(`${SKILLS_DIR}/demo/SKILL.md`, '技能说明', ctx)
  assert.match(await call(space, t.id, branchId, 'read', { path: `${SKILLS_DIR}/demo/SKILL.md` }), /技能说明/)
  assert.match(await call(space, t.id, branchId, 'write', { path: `${SKILLS_DIR}/demo/SKILL.md`, content: 'x' }), /只能修改本会话工作区/)

  const path = await space.workspace.mentioned(t.id, `${treeDir(other.id)}/secret.txt`)
  assert.equal(path, `${treeDir(t.id)}/attachments/secret.txt`)
  assert.match(await call(space, t.id, branchId, 'read', { path }), /别的会话/)
  await assert.rejects(space.workspace.mentioned(t.id, '/data/uploads/x'), /只能引用会话工作区里的文件/)
})
