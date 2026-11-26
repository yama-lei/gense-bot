// Models switched off in Settings (preference `hiddenModels`): the default model skips them, open sockets get the new
// default, and a message may still name one. Real host, WebSocket and SQLite; the faux model plus a signed-in Mistral.
import type { Preferences, TreeMeta } from '@gense/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configFromEnv } from '../src/platform/config.ts'
import { startServer } from '../src/platform/server.ts'
import { Client, login, tempDir } from './host-helpers.ts'

test('hidden models: the default skips them unless every model is hidden; sending to one still works', async t => {
  const dataDir = await tempDir()
  const config = { ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: dataDir, SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'toggle-key' }), port: 0 }
  let host = await startServer(config)
  t.after(() => host.close())
  await host.auth.register('a@example.com', 'a long password')
  let client = await Client.connect(host.url, (await login(host.url, 'a long password', 'a@example.com')).cookie)
  const faux = await client.until(() => client.defaultModel ?? undefined, 10_000, 'default model')
  assert.equal(`${faux.provider}:${faux.id}`, 'faux:faux-1')

  // Invalid lists are refused and change nothing.
  for (const hiddenModels of ['faux:faux-1', [1], [''], ['x'.repeat(301)]] as unknown[])
    await assert.rejects(client.request({ t: 'prefs.set', hiddenModels } as never), /模型开关无效/)
  assert.equal(client.prefs?.hiddenModels, undefined)

  // A second provider, so something stays visible.
  const signIn = client.request({ t: 'auth.login', loginId: 'l1', provider: 'mistral', type: 'api_key' })
  const [promptId] = await client.until(() => [...client.prompts].find(([, p]) => p.loginId === 'l1'), 10_000, 'key prompt')
  await client.request({ t: 'auth.answer', promptId, value: 'sk-test' })
  await signIn
  const mistral = await client.until(() => client.models.filter(m => m.provider === 'mistral').length > 1 && client.models.filter(m => m.provider === 'mistral'), 5_000, 'mistral models')

  // Hiding the host's default moves the default to the first visible model; duplicates collapse.
  const hidden = ['faux:faux-1', 'faux:faux-1', `mistral:${mistral[0]!.id}`]
  const prefs = await client.request<Preferences>({ t: 'prefs.set', hiddenModels: hidden })
  assert.deepEqual(prefs.hiddenModels, ['faux:faux-1', `mistral:${mistral[0]!.id}`])
  const moved = await client.until(() => client.defaultModel?.provider === 'mistral' && client.defaultModel, 5_000, 'default moves')
  assert.equal(moved.id, mistral[1]!.id)
  assert.equal(client.models.length, 1 + mistral.length, 'the socket still gets every model')

  // Hiding is not disabling: a message may name a hidden model.
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  await client.request({ t: 'send', treeId: tree.id, text: 'hello', requestId: 'r1', model: faux })
  await client.until(() => client.views.get(tree.id)?.entries.some(e => e.kind === 'pi.assistant'), 15_000, 'answer from a hidden model')

  // Every model hidden: no filtering, so channels and schedules keep a model.
  await client.request({ t: 'prefs.set', hiddenModels: client.models.map(m => `${m.provider}:${m.id}`) })
  await client.until(() => client.defaultModel?.provider === 'faux', 5_000, 'default back to the host')

  // The list survives a restart.
  await client.request({ t: 'prefs.set', hiddenModels: ['faux:faux-1'] })
  await host.close()
  host = await startServer(config)
  client = await Client.connect(host.url, (await login(host.url, 'a long password', 'a@example.com')).cookie)
  await client.until(() => client.defaultModel?.provider === 'mistral', 10_000, 'default after restart')
  assert.deepEqual(client.prefs?.hiddenModels, ['faux:faux-1'])
})
