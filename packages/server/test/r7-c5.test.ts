import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { UsageReport } from '@gense/protocol'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { startServer } from '../src/platform/server.ts'
import { configFromEnv } from '../src/platform/config.ts'
import { AppStore } from '../src/platform/app.ts'
import { Auth } from '../src/platform/auth.ts'
import { fauxModels } from '../src/agent/faux.ts'
import { UserSpace } from '../src/agent/space.ts'
import { webFetch, webSearch } from '../src/plugins/web.ts'
import { login, tempDir } from './host-helpers.ts'
import { diskEnv } from './fixtures.ts'
import { deepseekPlatform, fixture } from './deepseek-platform.ts'

test('C8/D6: usage reports expose billed native counts, not display counts, and scope both arrays to the signed-in user', async t => {
  const remote = await deepseekPlatform(async (body, res) => {
    const text = JSON.stringify(body.messages)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (text.includes('error fixture')) res.end(await fixture('error'))
    else res.end((await fixture('read-link')).replace('"tool_search":0', '"tool_search":2').replace('"tool_image_search":0', '"tool_image_search":3').replace('"tool_fetch":1', '"tool_fetch":4').replace('"web_search_requests":0', '"web_search_requests":99').replace('"web_fetch_requests":1', '"web_fetch_requests":88'))
  }); t.after(() => remote.close())
  const host = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: await tempDir(), SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'seal' }), port: 0 })
  t.after(() => host.close())
  const a = await host.auth.register('a@example.com', 'a long password'), b = await host.auth.register('b@example.com', 'a long password')
  const ac = (await login(host.url, 'a long password', a.email)).cookie!, bc = (await login(host.url, 'a long password', b.email)).cookie!
  const provider = await host.app.putProvider({ kind: 'deepseek', name: 'Native', baseUrl: remote.url, modelIds: [], apiKey: 'dummy' })
  for (const user of [a, b]) {
    const space = (await host.spaces.sync(user.id))!, tree = await space.createTree()
    await space.preferences.set({ suggestions: false })
    await space.send(tree.id, { text: 'Read https://example.com/a', requestId: 'native:' + user.id }); await space.harness.waitForIdle(ctx)
  }
  await host.app.recordService(a.id, 'ocr', 2); await host.app.recordService(b.id, 'tts', 7)
  const get = (path: string, cookie?: string) => fetch(host.url + path, { headers: { ...(cookie && { cookie }) } })
  const own = await (await get('/api/usage', ac)).json() as UsageReport
  assert.equal(own.models.length, 1); assert.equal(own.models[0]!.provider, provider.id)
  assert.deepEqual([own.models[0]!.calls, own.models[0]!.searches, own.models[0]!.fetches], [1, 5, 4])
  assert.deepEqual(own.services.map(s => [s.userId, s.service, s.units]), [[a.id, 'ocr', 2]])
  assert.ok(own.models.every(m => m.userId === a.id))
  const admin = await (await get('/api/admin/usage', ac)).json() as UsageReport
  assert.equal(admin.models.length, 2); assert.equal(admin.services.length, 2)
  assert.equal((await get('/api/admin/usage', bc)).status, 403)
  assert.equal((await get('/api/usage')).status, 401)
  assert.equal((await get('/api/usage?from=bad', ac)).status, 400)
  assert.equal((await get('/api/usage?from=2026-11-15&to=2026-11-14', ac)).status, 400)
  assert.deepEqual(await (await get('/api/usage?from=2099-01-01&to=2099-01-02', ac)).json(), { models: [], services: [] })
  const space = host.spaces.get(a.id)!, model = space.accounts.models.getModel(provider.id, 'deepseek-flash')!
  await space.accounts.models.completeSimple(model, { messages: [{ role: 'user', content: 'error fixture', timestamp: Date.now() }], tools: [] })
  const after = await host.app.usage(undefined, undefined, a.id)
  assert.deepEqual([after.models[0]!.calls, after.models[0]!.searches, after.models[0]!.fetches], [2, 9, 6])
  assert.ok(after.services.every(s => ['ocr', 'asr', 'tts'].includes(s.service)))
})

test('C8: real standalone web functions and agent tools meter only successful non-empty calls, without LLM calls', async t => {
  const remote = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (body.query === 'fail' || body.url?.includes('fail')) { res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"failed"}}'); return }
    const result = req.url === '/v1/tools/search' ? { results: body.query === 'empty' ? [] : [{ url: 'https://example.com/a', title: 'Page', summary: 'Summary' }] } : { title: 'Page', content: body.url?.includes('empty') ? '' : 'Page text' }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
  })
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening')
  const url = `http://127.0.0.1:${(remote.address() as { port: number }).port}`
  t.after(() => new Promise<void>(resolve => { remote.close(() => resolve()); remote.closeIdleConnections() }))
  const db = await openNodeSqliteDatabase(':memory:'), auth = await Auth.open(db), app = await AppStore.open(db, 'seal')
  t.after(async () => { await app.flush(); await db.close() })
  const user = await auth.register('tools@example.com', 'a long password')
  const config = { key: 'dummy', base: url, onUse: (service: 'search' | 'fetch') => app.recordWeb(user.id, service) }
  await webSearch(config, 'ok', 1); await webSearch(config, 'empty', 1); await assert.rejects(webSearch(config, 'fail', 1))
  await webFetch(config, 'https://example.com/ok'); await webFetch(config, 'https://example.com/empty'); await assert.rejects(webFetch(config, 'https://example.com/fail'))
  let report = await app.usage()
  assert.deepEqual([report.models[0]!.provider, report.models[0]!.source, report.models[0]!.calls, report.models[0]!.searches, report.models[0]!.fetches], ['deepseek-tools', 'byok', 0, 1, 1])
  assert.deepEqual(report.services, [])
  const shared = await app.putProvider({ kind: 'deepseek', name: 'Web', baseUrl: url, modelIds: [], apiKey: 'key' })
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: fauxModels(), env: await diskEnv(), plugins: { defaults: { web: { deepseekKey: 'key', deepseekUrl: url } } }, webUsage: service => app.recordWeb(user.id, service) })
  t.after(() => space.close())
  const tree = await space.createTree()
    await space.preferences.set({ suggestions: false })
  await space.send(tree.id, { text: '[工具 web_search] {"query":"from actual tool"}', requestId: 'tool' }); await space.harness.waitForIdle(ctx)
  report = await app.usage()
  const selected = report.models.find(m => m.provider === shared.id)!
  assert.deepEqual([selected.model, selected.calls, selected.searches, selected.fetches], ['web-tools', 0, 1, 0])
  assert.deepEqual(report.services, [])
})
