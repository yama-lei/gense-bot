// Stage-1 E2E against the real host with the faux model (roadmap-3 stage 1).
import { RUN_ERROR_KIND, type TreeMeta } from '@gense/core/protocol'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { configFromEnv } from '../src/config.ts'
import { startServer } from '../src/server.ts'
import { accountsScenario, agentsScenario, branchesScenario, Client, documentsScenario, eventsScenario, fakeUpstream, ledgerScenario, login, pluginEnv, pluginScenario, skillsScenario, tempDir, textOf, workspaceScenario } from './helpers.ts'

const EMAIL = 'a@example.com'
const PASSWORD = 'correct horse'
let server: Awaited<ReturnType<typeof startServer>>
let upstream: Awaited<ReturnType<typeof fakeUpstream>>

before(async () => {
  upstream = await fakeUpstream()
  server = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: await tempDir(), ...pluginEnv(upstream.url) }), port: 0 })
  await server.auth.createUser(EMAIL, PASSWORD)
})
after(async () => {
  await server.close()
  await upstream.close()
})

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

test('R33: the workspace: tool writes, the file panel, uploads and attachments', { timeout: 60_000 }, async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  await workspaceScenario(client)
  client.close()
})

test('R33: plugins: switches, the server key, a sealed user key, and a generated image', { timeout: 60_000 }, async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  await pluginScenario(client, upstream)
  client.close()
})

test('R33: Skills, / commands and @ mentions', { timeout: 60_000 }, async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  await skillsScenario(client)
  client.close()
})

test('R62: signing in to a model service with an API key', { timeout: 60_000 }, async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  await accountsScenario(client, { oauth: true })
  client.close()
})

test('R9: Word and PDF attachments are read as text', { timeout: 60_000 }, async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  await documentsScenario(client)
  client.close()
})

test('R35–R37: edits, regenerations and forks are branches of one conversation', { timeout: 60_000 }, async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  await branchesScenario(client)
  client.close()
})

test('R42–R45: branches share the workspace and change a file only as they last read it', { timeout: 60_000 }, async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  await ledgerScenario(client)
  client.close()
})

test('R40, R46–R50: webhooks, branch summaries and schedules arrive as Events', { timeout: 90_000 }, async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  await eventsScenario(client, server.url)
  client.close()
})

test('R51–R55: subagents report back to the main line, and one is stopped', { timeout: 90_000 }, async () => {
  const { cookie } = await login(server.url, EMAIL, PASSWORD)
  const client = await Client.connect(server.url, cookie)
  await agentsScenario(client)
  client.close()
})
