// Stage-2 E2E: the stage-1 behaviour (R31) and crash recovery (R32) on the Workers runtime, through `wrangler dev`.
import { EVENT_KIND, LONG_REPLY, RUN_ERROR_KIND, type EventData, type TreeMeta } from '@gense/core'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { accountsScenario, agentsScenario, branchesScenario, Client, documentsScenario, eventsScenario, fakeUpstream, ledgerScenario, login, noSandboxScenario, pluginEnv, pluginScenario, skillsScenario, stopReason, tempDir, textOf, workspaceScenario } from '../../node/test/helpers.ts'
import { addUser, wranglerDev, type Dev } from './helpers.ts'

const EMAIL = 'a@example.com'
const PASSWORD = 'correct horse'
let stateDir: string
let dev: Dev
let upstream: Awaited<ReturnType<typeof fakeUpstream>>
let vars: Record<string, string>

before(async () => {
  stateDir = await tempDir()
  upstream = await fakeUpstream()
  vars = pluginEnv(upstream.url)
  dev = await wranglerDev(stateDir, vars)
  await addUser(dev.url, EMAIL, PASSWORD)
})
after(async () => {
  await dev.stop()
  await upstream.close()
})

test('login, the session check on the socket, and the SPA fallback', async () => {
  assert.equal((await login(dev.url, EMAIL, 'wrong password')).status, 401)
  const { status, cookie } = await login(dev.url, EMAIL, PASSWORD)
  assert.equal(status, 200)
  assert.deepEqual(await (await fetch(`${dev.url}/api/me`, { headers: { cookie: cookie! } })).json(), { email: EMAIL })
  await assert.rejects(Client.connect(dev.url, undefined), /401/)
  await assert.rejects(Client.connect(dev.url, cookie, 'https://evil.example'), /401/)
  const page = await fetch(`${dev.url}/chat/some-id`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<div id="root">/)
})

test('R31: a message streams an answer and names the conversation', { timeout: 30_000 }, async () => {
  const { cookie } = await login(dev.url, EMAIL, PASSWORD)
  const client = await Client.connect(dev.url, cookie)
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  await client.request({ t: 'send', treeId: tree.id, text: '你好', requestId: 'r1' })
  const answer = await client.until(() => client.views.get(tree.id)?.entries.find((e) => e.kind === 'pi.assistant'), 15_000, 'answer')
  assert.equal(textOf(answer), '收到：你好')
  assert.equal(client.trees.find((t) => t.id === tree.id)?.title, '你好')

  await client.request({ t: 'send', treeId: tree.id, text: '[错误] 试试', requestId: 'r2' })
  await client.until(() => client.views.get(tree.id)?.entries.find((e) => e.kind === RUN_ERROR_KIND), 20_000, 'run error')
  client.close()
})

test('R32: an answer cut off by killing workerd completes after restart', { timeout: 120_000 }, async () => {
  let { cookie } = await login(dev.url, EMAIL, PASSWORD)
  let client = await Client.connect(dev.url, cookie)
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  await client.request({ t: 'send', treeId: tree.id, text: '[长回答] 讲讲', requestId: 'r1' })
  await client.until(() => {
    const live = client.views.get(tree.id)?.docs['pi.live'] as { generation?: { message?: { content?: { text?: string }[] } } } | undefined
    return (live?.generation?.message?.content?.[0]?.text?.length ?? 0) > 50
  }, 20_000, 'partial answer')
  assert.ok(!client.views.get(tree.id)!.entries.some((e) => e.kind === 'pi.assistant'), 'answer still streaming at the crash')
  client.close()
  await dev.stop('SIGKILL')

  dev = await wranglerDev(stateDir, vars)
  ;({ cookie } = await login(dev.url, EMAIL, PASSWORD))
  client = await Client.connect(dev.url, cookie)
  await client.request({ t: 'watch', treeId: tree.id })
  const answer = await client.until(
    () => client.views.get(tree.id)?.entries.find((e) => e.kind === 'pi.assistant' && stopReason(e) === 'stop'),
    60_000,
    'answer after restart',
  )
  assert.equal(textOf(answer), LONG_REPLY)
  const entries = client.views.get(tree.id)!.entries
  assert.equal(entries.filter((e) => e.kind === 'pi.user').length, 1, 'the question is asked once')
  client.close()
})

test('R33: the workspace: tool writes, the file panel, uploads and attachments', { timeout: 60_000 }, async () => {
  const { cookie } = await login(dev.url, EMAIL, PASSWORD)
  const client = await Client.connect(dev.url, cookie)
  await workspaceScenario(client)
  client.close()
})

test('R33: plugins: switches, the server key, a sealed user key, and a generated image', { timeout: 60_000 }, async () => {
  const { cookie } = await login(dev.url, EMAIL, PASSWORD)
  const client = await Client.connect(dev.url, cookie)
  await pluginScenario(client, upstream)
  client.close()
})

test('R33: Skills, / commands and @ mentions', { timeout: 60_000 }, async () => {
  const { cookie } = await login(dev.url, EMAIL, PASSWORD)
  const client = await Client.connect(dev.url, cookie)
  await skillsScenario(client)
  client.close()
})

test('R62: signing in to a model service with an API key', { timeout: 60_000 }, async () => {
  const { cookie } = await login(dev.url, EMAIL, PASSWORD)
  const client = await Client.connect(dev.url, cookie)
  await accountsScenario(client, { oauth: false })
  client.close()
})

test('R57: Cloudflare has no sandbox, and the assistant is told it cannot run code', { timeout: 60_000 }, async () => {
  const { cookie } = await login(dev.url, EMAIL, PASSWORD)
  const client = await Client.connect(dev.url, cookie)
  await noSandboxScenario(client)
  client.close()
})

test('R9: Word and PDF attachments are read as text', { timeout: 60_000 }, async () => {
  const { cookie } = await login(dev.url, EMAIL, PASSWORD)
  const client = await Client.connect(dev.url, cookie)
  await documentsScenario(client)
  client.close()
})

test('R35–R37: edits, regenerations and forks are branches of one conversation', { timeout: 60_000 }, async () => {
  const { cookie } = await login(dev.url, EMAIL, PASSWORD)
  const client = await Client.connect(dev.url, cookie)
  await branchesScenario(client)
  client.close()
})

test('R42–R45: branches share the workspace and change a file only as they last read it', { timeout: 60_000 }, async () => {
  const { cookie } = await login(dev.url, EMAIL, PASSWORD)
  const client = await Client.connect(dev.url, cookie)
  await ledgerScenario(client)
  client.close()
})

test('R40, R46–R50: webhooks, branch summaries and schedules arrive as Events', { timeout: 90_000 }, async () => {
  const { cookie } = await login(dev.url, EMAIL, PASSWORD)
  const client = await Client.connect(dev.url, cookie)
  await eventsScenario(client, dev.url)
  client.close()
})

test('R51–R55: subagents report back to the main line, and one is stopped', { timeout: 90_000 }, async () => {
  const { cookie } = await login(dev.url, EMAIL, PASSWORD)
  const client = await Client.connect(dev.url, cookie)
  await agentsScenario(client)
  client.close()
})

test('V6: a subagent cut off by killing workerd finishes after restart and is reported once', { timeout: 120_000 }, async () => {
  let { cookie } = await login(dev.url, EMAIL, PASSWORD)
  let client = await Client.connect(dev.url, cookie)
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  const { branchId: main } = await client.request<{ branchId: string }>({ t: 'send', treeId: tree.id, text: '[派出] [长回答] 长任务', requestId: 'v6' })
  const agent = await client.until(() => client.branches.get(tree.id)?.branches.find((b) => b.role === 'agent'), 20_000, 'agent')
  await client.request({ t: 'watch', treeId: tree.id, branchId: agent.id })
  await client.until(() => {
    const live = client.views.get(tree.id)?.docs['pi.live'] as { generation?: { message?: { content?: { text?: string }[] } } } | undefined
    return client.shown.get(tree.id) === agent.id && (live?.generation?.message?.content?.[0]?.text?.length ?? 0) > 50
  }, 20_000, 'partial answer')
  client.close()
  await dev.stop('SIGKILL')

  dev = await wranglerDev(stateDir, vars)
  ;({ cookie } = await login(dev.url, EMAIL, PASSWORD))
  client = await Client.connect(dev.url, cookie)
  await client.request({ t: 'watch', treeId: tree.id, branchId: main })
  const notices = () => (client.views.get(tree.id)?.entries ?? []).filter((e) => e.kind === EVENT_KIND)
  const notice = await client.until(() => client.shown.get(tree.id) === main && notices()[0], 60_000, 'notice after restart')
  assert.match((notice.data as EventData).body, new RegExp(LONG_REPLY.slice(-20)))
  await client.until(() => client.branches.get(tree.id)?.branches.find((b) => b.id === main)?.status === 'idle', 30_000, 'main idle')
  assert.equal(notices().length, 1)
  client.close()
})
