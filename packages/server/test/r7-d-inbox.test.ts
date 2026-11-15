import { INBOX_READ_KEPT } from '@gense/protocol'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configFromEnv } from '../src/platform/config.ts'
import { startServer } from '../src/platform/server.ts'
import { Client, login, tempDir } from './host-helpers.ts'

test('D3: read ids merge across devices, cap requests/retention at 500, truncate ids and survive restart', async t => {
  const options = { ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: await tempDir(), SANDBOX: '0', BACKUPS: '0' }), port: 0 }
  let host = await startServer(options)
  const clients: Client[] = []
  t.after(async () => { for (const c of clients) c.close(); await host.close() })
  const a = await host.auth.register('a@example.com', 'a long password'), b = await host.auth.register('b@example.com', 'a long password')
  const ac = (await login(host.url, 'a long password', a.email)).cookie!, bc = (await login(host.url, 'a long password', b.email)).cookie!
  const first = await Client.connect(host.url, ac), second = await Client.connect(host.url, ac), other = await Client.connect(host.url, bc)
  clients.push(first, second, other)
  await Promise.all(clients.map(c => c.until(() => c.inboxRead)))
  assert.equal(first.inboxRead!.length, 0); assert.equal(second.inboxRead!.length, 0); assert.equal(other.inboxRead!.length, 0)
  const overlong = 'read:'.repeat(80)
  await first.request({ t: 'inbox.read', ids: ['first', 'first', overlong] })
  await second.until(() => second.inboxRead?.includes('first'))
  assert.deepEqual(new Set(second.inboxRead), new Set(['first', overlong.slice(0, 200)]))
  await second.request({ t: 'inbox.read', ids: ['second'] })
  await first.until(() => first.inboxRead?.includes('second'))
  assert.equal(first.inboxRead!.length, 3); assert.deepEqual(other.inboxRead, [])
  const ids = Array.from({ length: INBOX_READ_KEPT + 100 }, (_, i) => `item-${i}`)
  await first.request({ t: 'inbox.read', ids })
  await second.until(() => second.inboxRead?.length === INBOX_READ_KEPT)
  assert.ok(ids.slice(0, INBOX_READ_KEPT).every(id => second.inboxRead!.includes(id)))
  assert.ok(!second.inboxRead!.includes('item-500'), 'a request accepts only its first 500 ids')
  assert.ok(!second.inboxRead!.includes('first'))
  const space = host.spaces.get(a.id)!
  await space.db.run('UPDATE inbox_read SET readAt = 1')
  await first.request({ t: 'inbox.read', ids: ['item-0'] })
  await first.request({ t: 'inbox.read', ids: ['latest'] })
  await second.until(() => second.inboxRead?.includes('latest'))
  assert.equal(second.inboxRead!.length, 500); assert.ok(second.inboxRead!.includes('item-0'), 'rereading refreshes an old id')
  await assert.rejects(first.request({ t: 'inbox.read', ids: [123] as unknown as string[] }), /无效/)
  const saved = new Set(second.inboxRead)
  for (const c of clients.splice(0)) c.close()
  await host.close(); host = await startServer(options)
  const reopened = await Client.connect(host.url, ac); clients.push(reopened)
  await reopened.until(() => reopened.inboxRead)
  assert.deepEqual(new Set(reopened.inboxRead), saved)
})
