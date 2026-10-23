// Stage-2 E2E: the stage-1 behaviour (R31) and crash recovery (R32) on the Workers runtime, through `wrangler dev`.
import { LONG_REPLY, RUN_ERROR_KIND, type TreeMeta } from '@gense/core'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Client, login, stopReason, tempDir, textOf } from '../../node/test/helpers.ts'
import { addUser, wranglerDev, type Dev } from './helpers.ts'

const EMAIL = 'a@example.com'
const PASSWORD = 'correct horse'
let stateDir: string
let dev: Dev

before(async () => {
  stateDir = await tempDir()
  dev = await wranglerDev(stateDir)
  await addUser(dev.url, EMAIL, PASSWORD)
})
after(() => dev.stop())

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

  dev = await wranglerDev(stateDir)
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
