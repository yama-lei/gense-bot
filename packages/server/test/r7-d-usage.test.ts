// D6 adds acceptance coverage to the C-5 endpoint; no second usage implementation.
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import type { UsageReport } from '@gense/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configFromEnv } from '../src/platform/config.ts'
import { startServer } from '../src/platform/server.ts'
import { login, tempDir } from './host-helpers.ts'

test('D6: ordinary users see only their own shared/BYOK model and service usage, including with a forged user filter', async t => {
  const host = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: await tempDir(), SANDBOX: '0', BACKUPS: '0' }), port: 0 })
  t.after(() => host.close())
  const a = await host.auth.register('a@example.com', 'a long password'), b = await host.auth.register('b@example.com', 'a long password')
  const ac = (await login(host.url, 'a long password', a.email)).cookie!, bc = (await login(host.url, 'a long password', b.email)).cookie!
  for (const user of [a, b]) {
    const space = (await host.spaces.sync(user.id))!, tree = await space.createTree()
    await space.preferences.set({ suggestions: false })
    await space.send(tree.id, { text: 'A private usage test', requestId: 'usage' }); await space.harness.waitForIdle(ctx)
  }
  const personal = fauxProvider({ provider: 'mistral', models: [{ id: 'personal' }] })
  personal.setResponses([fauxAssistantMessage('A personal model answer')])
  const space = host.spaces.get(b.id)!
  space.accounts.models.setProvider(personal.provider)
  await space.accounts.models.completeSimple(personal.getModel(), { messages: [{ role: 'user', content: 'Personal request', timestamp: Date.now() }] })
  await host.app.recordService(a.id, 'asr', 1); await host.app.recordService(b.id, 'tts', 3)
  const get = (path: string, cookie?: string) => fetch(host.url + path, { headers: { ...(cookie && { cookie }) } })
  const today = new Date().toISOString().slice(0, 10)
  const response = await get(`/api/usage?userId=${a.id}&from=${today}&to=${today}`, bc)
  assert.equal(response.status, 200)
  const own = await response.json() as UsageReport
  assert.equal(own.models.length, 2)
  assert.deepEqual(new Set(own.models.map(row => row.source)), new Set(['shared', 'byok']))
  assert.ok(own.models.every(row => row.userId === b.id && row.email === b.email && row.totalTokens > 0))
  assert.deepEqual(own.services.map(row => [row.userId, row.email, row.service, row.units]), [[b.id, b.email, 'tts', 3]])
  assert.ok(!JSON.stringify(own).includes(a.email))
  const all = await (await get('/api/admin/usage', ac)).json() as UsageReport
  assert.equal(all.models.length, 3); assert.equal(all.services.length, 2)
  assert.equal((await get('/api/admin/usage', bc)).status, 403)
  assert.equal((await get('/api/usage')).status, 401)
  assert.equal((await get('/api/usage?from=invalid', bc)).status, 400)
  assert.deepEqual(await (await get('/api/usage?from=2099-01-01&to=2099-01-02', bc)).json(), { models: [], services: [] })
})
