import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { ConversationId } from '@earendil-works/pi-durable'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { Auth, accountApi, fauxModels, UserSpace } from '../src/index.ts'
import { diskEnv } from './fixtures.ts'

test('N26: declarations expose tools and views; tool switches apply to real conversation resolution and view calls', async () => {
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: fauxModels(), env: await diskEnv() })
  try {
    const plugins = space.plugins.list()
    assert.equal(plugins.length, 6)
    assert.ok(plugins.every(p => p.tools.length > 0 && p.tools.every(t => t.description)))
    assert.equal(plugins.find(p => p.id === 'artifact')!.tools.find(t => t.name === 'artifact_create')!.resourceUri, 'ui://artifact/view')
    assert.equal(plugins.find(p => p.id === 'ui')!.tools.find(t => t.name === 'ui_photos')!.viewOnly, true)
    await space.plugins.set('artifact', { enabled: true })
    const tree = await space.createTree()
    const branch = (await space.branches(tree.id)).branches[0]!
    const conv = (await space.harness.conversation(branch.conversationId as ConversationId, ctx))!
    assert.ok((await conv.agent(ctx)).tools.some(t => t.name === 'artifact_create'))
    assert.ok(!(await conv.agent(ctx)).tools.some(t => t.name === 'artifact_save'))
    await space.plugins.setTool('artifact', 'artifact_create', false)
    assert.ok(!(await conv.agent(ctx)).tools.some(t => t.name === 'artifact_create'))
    await assert.rejects(space.callTool(tree.id, 'ui', 'artifact_save', {}), /已关闭|不能调用/)
    const saved = await space.callTool(tree.id, 'artifact', 'artifact_save', { title: 'test', type: 'markdown', content: 'real file' })
    assert.match(saved.content, /已保存/)
    await space.plugins.setTool('artifact', 'artifact_save', false)
    await assert.rejects(space.callTool(tree.id, 'artifact', 'artifact_save', {}), /工具已关闭/)
    await space.plugins.setTool('artifact', 'artifact_create', true)
    assert.ok((await conv.agent(ctx)).tools.some(t => t.name === 'artifact_create'))
  } finally { await space.close() }
})

test('R5 preferences enter the prompt and search finds titles and messages across forks', async () => {
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: fauxModels(), env: await diskEnv() })
  try {
    await space.preferences.set({ name: 'Ada', instructions: 'Answer carefully' })
    assert.match(space.preferences.prompt()!, /Ada[\s\S]*<user_instructions>\nAnswer carefully\n<\/user_instructions>/)
    await assert.rejects(space.preferences.set({ timeZone: 'Mars/Olympus' }), /时区无效/)
    await space.preferences.set({ timeZone: 'Asia/Shanghai' })
    assert.equal(space.preferences.get().timeZone, 'Asia/Shanghai')
    const tree = await space.createTree()
    await space.send(tree.id, { text: 'needle in message', requestId: 'search' })
    await space.harness.waitForIdle(ctx)
    await space.updateTree(tree.id, { title: 'renamed title' })
    const hits = await space.searchTrees('needle')
    assert.equal(hits[0]!.treeId, tree.id)
    assert.match(hits[0]!.snippet, /needle/)
    assert.equal((await space.searchTrees('renamed'))[0]!.title, 'renamed title')
    assert.deepEqual(await space.searchTrees('absent'), [])
    const { branch } = await space.branchRow(tree.id)
    const conv = await space.open(branch, ctx)
    assert.ok((await conv.agent(ctx)).extensions.some(e => e.name === 'preferences'))
  } finally { await space.close() }
})

test('R5 password endpoint verifies current password, rotates the cookie and revokes other sessions', async () => {
  const db = await openNodeSqliteDatabase(':memory:')
  try {
    const auth = await Auth.open(db)
    await auth.setPassword('old-password')
    const a = await auth.login('old-password'), b = await auth.login('old-password')
    const change = (current: string, next: string) => accountApi(auth, new Request('http://localhost/api/password', { method: 'POST', headers: { cookie: `gense_session=${a}` }, body: JSON.stringify({ current, next }) }))
    assert.equal((await change('bad', 'new-password')).status, 400)
    assert.equal(await auth.session(b), true)
    const result = await change('old-password', 'new-password')
    assert.equal(result.status, 200)
    assert.equal(await auth.session(a), false)
    assert.equal(await auth.session(b), false)
    assert.ok(result.headers.get('set-cookie')?.includes('HttpOnly'))
    await assert.rejects(auth.login('old-password'))
    assert.ok(await auth.login('new-password'))
  } finally { await db.close() }
})

test('R5 password rotation closes old live WebSockets and admits a new cookie', async () => {
  const { startServer } = await import('../src/platform/server.ts')
  const { configFromEnv } = await import('../src/platform/config.ts')
  const { login, tempDir } = await import('./host-helpers.ts')
  const { WebSocket } = await import('ws')
  const server = await startServer({ ...configFromEnv({ GENSE_FAUX:'1', DATA_DIR:await tempDir(), SANDBOX:'0', BACKUPS:'0' }), port:0 })
  const sockets:InstanceType<typeof WebSocket>[]=[]
  try {
    await server.auth.setPassword('initial-password')
    const a = await login(server.url,'initial-password'), b = await login(server.url,'initial-password')
    for (const cookie of [a.cookie,b.cookie]) { const ws=new WebSocket(server.url.replace('http','ws')+'/ws',{headers:{cookie:cookie!}});sockets.push(ws);await once(ws,'open') }
    const closed = sockets.map(ws=>once(ws,'close'))
    const changed = await fetch(server.url+'/api/password',{method:'POST',headers:{cookie:a.cookie!,'content-type':'application/json'},body:JSON.stringify({current:'initial-password',next:'changed-password'})})
    assert.equal(changed.status,200)
    await Promise.all(closed)
    const fresh=new WebSocket(server.url.replace('http','ws')+'/ws',{headers:{cookie:changed.headers.get('set-cookie')!.split(';')[0]!}});sockets.push(fresh);await once(fresh,'open')
    assert.equal(fresh.readyState,WebSocket.OPEN)
  } finally { for(const socket of sockets)socket.terminate(); await server.close() }
})
