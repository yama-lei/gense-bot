import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TreeMeta } from '@gense/protocol'
import { configFromEnv } from '../src/platform/config.ts'
import { startServer } from '../src/platform/server.ts'
import { Client, login, tempDir } from './host-helpers.ts'
import { deepseekPlatform, fixture } from './deepseek-platform.ts'

test('D2: a new turn, disabling suggestions or deleting a tree cancels stale side calls', async t => {
  const releases = new Map<string, () => void>(), starts = new Set<string>()
  const remote = await deepseekPlatform(async (body, res) => {
    const side = JSON.stringify(body.system).includes('You suggest what the user might say next')
    let text = 'The main answer'
    if (side) {
      const input = JSON.stringify(body.messages)
      const key = ['old', 'cancel', 'remove'].find(key => input.includes(`<question>\\n${key}\\n`))
      if (key) await new Promise<void>(resolve => { releases.set(key, resolve); starts.add(key) })
      text = JSON.stringify({ items: [key ? key + ' stale followup' : 'new followup'] })
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end((await fixture('plain')).replace(JSON.stringify('A short summary or answer.'), JSON.stringify(text)))
  })
  const host = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: await tempDir(), SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'seal' }), port: 0 })
  t.after(async () => { for (const release of releases.values()) release(); await host.close(); await remote.close() })
  const user = await host.auth.register('a@example.com', 'a long password')
  const cookie = (await login(host.url, 'a long password', user.email)).cookie!, client = await Client.connect(host.url, cookie)
  t.after(() => client.close())
  const provider = await host.app.putProvider({ kind: 'deepseek', name: 'Native', apiKey: 'key', baseUrl: remote.url, modelIds: ['deepseek-flash'] })
  const model = { provider: provider.id, id: 'deepseek-flash', name: 'Flash' }, space = host.spaces.get(user.id)!
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  const started = async (key: string) => { const end = Date.now() + 10_000; while (!starts.has(key)) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 20)) } }
  await client.request({ t: 'send', treeId: tree.id, text: 'old', requestId: 'old', model }); await started('old')
  await client.request({ t: 'send', treeId: tree.id, text: 'new', requestId: 'new', model })
  const latest = await client.until(() => client.suggestions.get(tree.id)?.items.includes('new followup') && client.suggestions.get(tree.id))
  releases.get('old')!(); await host.app.flush()
  assert.deepEqual(space.suggestions.get(tree.id), latest)
  await client.request({ t: 'send', treeId: tree.id, text: 'cancel', requestId: 'cancel', model }); await started('cancel')
  assert.equal(space.suggestions.get(tree.id), undefined)
  await client.request({ t: 'prefs.set', suggestions: false }); releases.get('cancel')!(); await host.app.flush()
  assert.equal(space.suggestions.get(tree.id), undefined)
  await client.request({ t: 'prefs.set', suggestions: true })
  const temporary = await client.request<TreeMeta>({ t: 'tree.create', temporary: true })
  await client.request({ t: 'send', treeId: temporary.id, text: 'remove', requestId: 'remove', model }); await started('remove')
  await client.request({ t: 'tree.delete', treeId: temporary.id }); releases.get('remove')!(); await host.app.flush()
  assert.equal(space.suggestions.get(temporary.id), undefined)
  assert.ok(!client.raw.some(raw => /stale followup/.test(raw)))
})

test('D2: a stalled real Messages side call is cancelled at 20 seconds without a suggestions push', async t => {
  let sideAt = 0, response: import('node:http').ServerResponse | undefined
  const remote = await deepseekPlatform(async (body, res) => {
    if (JSON.stringify(body.system).includes('You suggest what the user might say next')) {
      sideAt = Date.now(); response = res
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(await fixture('plain'))
  })
  const host = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: await tempDir(), SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'seal' }), port: 0 })
  t.after(async () => { response?.destroy(); await host.close(); await remote.close() })
  const user = await host.auth.register('a@example.com', 'a long password'), cookie = (await login(host.url, 'a long password', user.email)).cookie!
  const client = await Client.connect(host.url, cookie); t.after(() => client.close())
  const provider = await host.app.putProvider({ kind: 'deepseek', name: 'Native', apiKey: 'key', baseUrl: remote.url, modelIds: ['deepseek-flash'] })
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'send', treeId: tree.id, text: 'Explain this', requestId: 'stalled', model: { provider: provider.id, id: 'deepseek-flash', name: 'Flash' } })
  const end = Date.now() + 10_000
  while (!sideAt) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 20)) }
  await host.app.flush()
  assert.ok(Date.now() - sideAt >= 19_000 && Date.now() - sideAt < 25_000)
  assert.equal(host.spaces.get(user.id)!.suggestions.get(tree.id), undefined)
  assert.ok(!client.raw.some(raw => JSON.parse(raw).t === 'suggestions'))
})
