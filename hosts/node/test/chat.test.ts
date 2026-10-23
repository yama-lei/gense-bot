// Stage-1 E2E against the real host with the faux model (roadmap-3 stage 1).
import { RUN_ERROR_KIND, type TreeMeta } from '@gense/core/protocol'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { configFromEnv } from '../src/config.ts'
import { startServer } from '../src/server.ts'
import { Client, login, tempDir, textOf } from './helpers.ts'

const EMAIL = 'a@example.com'
const PASSWORD = 'correct horse'
let server: Awaited<ReturnType<typeof startServer>>

before(async () => {
  server = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: await tempDir() }), port: 0 })
  await server.auth.createUser(EMAIL, PASSWORD)
})
after(() => server.close())

test('login rejects a wrong password and accepts the right one', async () => {
  const bad = await login(server.url, EMAIL, 'wrong password')
  assert.equal(bad.status, 401)
  assert.equal(bad.cookie, undefined)
  const good = await login(server.url, EMAIL, PASSWORD)
  assert.equal(good.status, 200)
  const me = await fetch(`${server.url}/api/me`, { headers: { cookie: good.cookie! } })
  assert.deepEqual(await me.json(), { email: EMAIL })
})

test('the socket needs a session and a matching origin', async () => {
  await assert.rejects(Client.connect(server.url, undefined), /401/)
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  await assert.rejects(Client.connect(server.url, cookie, 'https://evil.example'), /401/)
})

test('a message streams an answer and names the conversation', async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  await client.request({ t: 'send', treeId: tree.id, text: '你好', requestId: 'r1' })

  const answer = await client.until(() => client.views.get(tree.id)?.entries.find((e) => e.kind === 'pi.assistant'), 10_000, 'answer')
  assert.equal(textOf(answer), '收到：你好')
  assert.equal(client.trees.find((t) => t.id === tree.id)?.title, '你好')

  // The same requestId is not answered twice.
  await client.request({ t: 'send', treeId: tree.id, text: '你好', requestId: 'r1' })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(client.views.get(tree.id)!.entries.filter((e) => e.kind === 'pi.user').length, 1)
  client.close()
})

test('a failed run leaves an error entry', async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  await client.request({ t: 'send', treeId: tree.id, text: '[错误] 试试', requestId: 'r1' })
  const error = await client.until(() => client.views.get(tree.id)?.entries.find((e) => e.kind === RUN_ERROR_KIND), 15_000, 'run error')
  assert.ok((error.data as { reason: string }).reason)
  client.close()
})

test('trees can be renamed, pinned and deleted', async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'tree.update', treeId: tree.id, title: '改名', pinned: true })
  await client.until(() => client.trees[0]?.id === tree.id && client.trees[0].pinned && client.trees[0].title === '改名', 2000, 'update')
  await client.request({ t: 'tree.delete', treeId: tree.id })
  await client.until(() => !client.trees.some((t) => t.id === tree.id), 2000, 'delete')
  await assert.rejects(client.request({ t: 'watch', treeId: tree.id }), /会话不存在/)
  client.close()
})
