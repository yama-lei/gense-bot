import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { AppStore } from '../src/platform/app.ts'
import { ModelAccounts } from '../src/agent/credentials.ts'
import { DEEPSEEK_MODELS, deepseekAppModel } from '../src/agent/deepseek.ts'
import { tempDir } from './host-helpers.ts'

test('C1: shared DeepSeek defaults, encrypted persistence, provider kind and BYOK use Messages', async () => {
  const file = join(await tempDir(), 'app.sqlite')
  let db = await openNodeSqliteDatabase(file)
  let app = await AppStore.open(db, 'seal')
  const registered = await app.putProvider({ kind: 'deepseek', name: 'Team', baseUrl: '', modelIds: [], apiKey: 'shared-key' })
  assert.match(registered.id, /^shared-/)
  assert.equal(registered.kind, 'deepseek')
  assert.equal(registered.baseUrl, 'https://api.deepseek.com/')
  assert.deepEqual(registered.modelIds, DEEPSEEK_MODELS)
  assert.ok(!(await db.get<{ sealed: string }>('SELECT sealed FROM shared_providers WHERE id = ?', registered.id))!.sealed.includes('shared-key'))
  await app.flush(); await db.close()
  db = await openNodeSqliteDatabase(file)
  try {
    app = await AppStore.open(db, 'seal')
    const accounts = await ModelAccounts.open(db, { host: app.models, secretKey: 'seal', oauth: false })
    const model = accounts.models.getModel(registered.id, 'deepseek-flash')!
    assert.equal(model.api, 'anthropic-messages')
    assert.equal(model.baseUrl, 'https://api.deepseek.com/anthropic')
    assert.equal(accounts.kind(registered.id), 'deepseek')
    assert.equal((await accounts.models.getAuth(model))!.auth.apiKey, 'shared-key')
    assert.ok(deepseekAppModel(model.id)); assert.ok(!deepseekAppModel('deepseek-v4-pro'))
    await accounts.login('deepseek', 'api_key', { prompt: async () => 'own-key', notify: () => {}, signal: new AbortController().signal })
    const own = accounts.models.getModel('deepseek', 'deepseek-flash')!
    assert.equal(own.api, 'anthropic-messages')
    assert.equal(accounts.source('deepseek'), 'byok')
    assert.equal((await accounts.models.getAuth(own))!.auth.apiKey, 'own-key')
    await accounts.refreshHost()
    assert.equal(accounts.models.getModel('deepseek', own.id)!.api, 'anthropic-messages')
    await assert.rejects(app.putProvider({ kind: 'openai', name: 'Broken', baseUrl: '', modelIds: [], apiKey: 'key' }))
  } finally { await app.flush(); await db.close() }
})
