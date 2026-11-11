import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import type { ConversationId } from '@earendil-works/pi-durable'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { fauxModels, UserSpace } from '../src/index.ts'
import { toolName } from '../src/plugins/mcp/host.ts'
import { diskEnv } from './fixtures.ts'
import { mcpPlatform as platform } from './mcp-platform.ts'
import { tempDir } from './host-helpers.ts'

async function until(check: () => boolean, timeout = 5000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error('state timeout'); await new Promise(r => setTimeout(r, 20)) } }

test('N20–N23: real MCP initialization, deferred tool_search, tool isolation, resources, encrypted headers and automatic recovery', async () => {
  const remote = await platform(), root = await tempDir(), env = await diskEnv(root)
  let space = await UserSpace.open(await openNodeSqliteDatabase(join(root, 'mcp.sqlite')), { models: fauxModels(), env, secretKey: 'test-key', mcp: { retryMs: 50, pollMs: 300, timeoutMs: 1000 } })
  try {
    const plugin = await space.mcp.add({ name: 'Weather', url: remote.url, headers: { 'X-Private': 'header-private-secret' } })
    assert.equal(plugin.mcp?.status, 'ready')
    assert.equal(plugin.tools.length, 21)
    assert.ok(!JSON.stringify(plugin).includes('header-private-secret'))
    const id = plugin.id, name = toolName(id, 'tool_0')
    const tree = await space.createTree(), branch = (await space.branches(tree.id)).branches[0]!
    const conv = (await space.harness.conversation(branch.conversationId as ConversationId, ctx))!
    assert.equal((await conv.agent(ctx)).deferred.length, 21)
    await space.send(tree.id, { text: '[工具 tool_search] {"query":"local weather","limit":1}', requestId: 'search-tools' })
    await space.harness.waitForIdle(ctx)
    assert.ok((await conv.agent(ctx)).tools.some(t => t.name === name))
    await space.send(tree.id, { text: `[工具 ${name}] {"query":"today"}`, requestId: 'mcp-tool' })
    await space.harness.waitForIdle(ctx)
    assert.deepEqual(remote.state.calls, ['tool_0'])
    assert.match((await space.callTool(tree.id, id, 'tool_0', { query: 'app view' })).content, /app view/)
    assert.equal(remote.state.headers.at(-1), 'header-private-secret')
    const view = await space.mcp.readResource(id, 'ui://local/view')
    assert.deepEqual(view.csp?.connectDomains, ['https://weather.example'])
    assert.match(view.html, /weather/)
    await assert.rejects(space.mcp.readResource(id, 'file:///etc/passwd'), /不属于/)
    remote.state.mime = 'text/html'
    await assert.rejects(space.mcp.readResource(id, 'ui://local/view'), /profile=mcp-app/)
    remote.state.mime = 'text/html;profile=mcp-app'
    const other = await space.mcp.add({ name: 'Other', url: remote.url })
    await assert.rejects(space.callTool(tree.id, other.id, name, { query: 'x' }), /不属于/)
    await space.plugins.setTool(id, name, false)
    await assert.rejects(space.callTool(tree.id, id, name, { query: 'x' }), /已关闭/)
    assert.ok(!(await conv.agent(ctx)).tools.some(t => t.name === name))
    await space.plugins.setTool(id, name, true)
    remote.state.online = false
    await assert.rejects(space.mcp.call(id, name, { query: 'offline' }))
    assert.equal(space.plugins.list().find(p => p.id === id)!.mcp!.status, 'error')
    assert.ok(!(await conv.agent(ctx)).tools.some(t => t.name === name))
    remote.state.online = true
    await until(() => space.plugins.list().find(p => p.id === id)?.mcp?.status === 'ready')
    assert.ok((await conv.agent(ctx)).tools.some(t => t.name === name))
    const row = await space.db.get<{ secrets: string }>('SELECT secrets FROM mcp_servers WHERE id = ?', id)
    assert.ok(!row!.secrets.includes('header-private-secret'))
    await space.close()
    space = await UserSpace.open(await openNodeSqliteDatabase(join(root, 'mcp.sqlite')), { models: fauxModels(), env, secretKey: 'test-key', mcp: { retryMs: 50, pollMs: 30_000 } })
    assert.equal(space.plugins.list().find(p => p.id === id)!.mcp!.status, 'ready')
    await space.mcp.update(id, { name: 'Renamed', headers: { 'x-private': null } })
    assert.equal(space.plugins.list().find(p => p.id === id)!.name, 'Renamed')
    assert.deepEqual(space.plugins.list().find(p => p.id === id)!.mcp!.headersSet, [])
    await space.mcp.remove(other.id)
    assert.ok(!space.plugins.list().some(p => p.id === other.id))
  } finally { await space.close(); await remote.close() }
})

test('N20: real OAuth metadata, dynamic registration, PKCE, single-use state and sealed tokens', async () => {
  const remote = await platform(true)
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: fauxModels(), env: await diskEnv(), secretKey: 'oauth-key', mcp: { publicUrl: 'http://localhost:8787', timeoutMs: 1000 } })
  try {
    const plugin = await space.mcp.add({ name: 'OAuth', url: remote.url })
    assert.equal(plugin.mcp!.status, 'auth')
    const { url } = await space.mcp.authorize(plugin.id), authorize = new URL(url)
    assert.equal(authorize.origin, remote.origin)
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
    remote.state.challenge = authorize.searchParams.get('code_challenge')!
    await assert.rejects(space.mcp.callback(new URL('http://localhost/api/mcp/callback?state=bad&code=ok')), /无效/)
    const callback = new URL('http://localhost/api/mcp/callback')
    callback.searchParams.set('state', authorize.searchParams.get('state')!); callback.searchParams.set('code', 'ok')
    await space.mcp.callback(callback)
    assert.equal(space.plugins.list().find(p => p.id === plugin.id)!.mcp!.status, 'ready')
    assert.equal(space.plugins.list().find(p => p.id === plugin.id)!.mcp!.oauth, true)
    await assert.rejects(space.mcp.callback(callback), /无效/)
    const stored = await space.db.get<{ secrets: string }>('SELECT secrets FROM mcp_servers WHERE id = ?', plugin.id)
    assert.ok(!stored!.secrets.includes('oauth-private-token'))
    assert.ok(!JSON.stringify(space.plugins.list()).includes('oauth-private-token'))
  } finally { await space.close(); await remote.close() }
})
