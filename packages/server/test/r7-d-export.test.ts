import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { ExportInfo, TreeMeta, UploadedFile, UsageReport } from '@gense/protocol'
import { unzipSync } from 'fflate'
import assert from 'node:assert/strict'
import { access, mkdir, readdir, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { configFromEnv } from '../src/platform/config.ts'
import { startServer } from '../src/platform/server.ts'
import { SUGGEST_SYSTEM } from '../src/agent/suggest-prompt.ts'
import { Client, login, tempDir } from './host-helpers.ts'

test('D5/D6: exports contain main Markdown, files, projects, memory and preferences; exclude private state and non-live trees; authorize downloads and retain three', async t => {
  const root = await tempDir(), faux = fauxProvider({ models: [{ id: 'export-model' }], tokensPerSecond: 100_000 })
  const respond = (context: { messages: import('@earendil-works/pi-ai').Message[] }) => {
    faux.appendResponses([respond])
    if (context.messages.some(m => m.role === 'system' && m.content === SUGGEST_SYSTEM)) return fauxAssistantMessage([fauxText('{"items":[]}')])
    const last = context.messages.findLast(m => m.role !== 'system')
    return last?.role === 'toolResult' ? fauxAssistantMessage([fauxText('Final answer markdown')]) : fauxAssistantMessage([{ type: 'thinking', thinking: 'hidden-thinking-sentinel' }, fauxText('Preparing the report'), fauxToolCall('write', { path: 'notes/report.md', content: 'tool-arguments-sentinel' })], { stopReason: 'toolUse' })
  }
  faux.setResponses([respond])
  const m = faux.getModel(), option = { provider: m.provider, id: m.id, name: m.name }
  const options = { ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: root, SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'export-key' }), models: () => ({ providers: [faux.provider], options: [option], defaultModel: option }), port: 0 }
  let host = await startServer(options)
  const clients: Client[] = []
  t.after(async () => { for (const c of clients) c.close(); await host.close() })
  const a = await host.auth.register('a@example.com', 'a long password'), b = await host.auth.register('b@example.com', 'a long password')
  const ac = (await login(host.url, 'a long password', a.email)).cookie!, bc = (await login(host.url, 'a long password', b.email)).cookie!
  const first = await Client.connect(host.url, ac), second = await Client.connect(host.url, ac), other = await Client.connect(host.url, bc)
  clients.push(first, second, other)
  await Promise.all(clients.map(c => c.until(() => c.raw.some(raw => JSON.parse(raw).t === 'exports'))))
  assert.equal(first.exports.length, 0)
  const space = host.spaces.get(a.id)!, base = join(root, 'users', a.id, 'files')
  await first.request({ t: 'prefs.set', name: 'Ada', instructions: 'Be brief', suggestions: false })
  const tree = await first.request<TreeMeta>({ t: 'tree.create' })
  await first.request({ t: 'tree.update', treeId: tree.id, title: 'Report / ..' })
  await first.request({ t: 'send', treeId: tree.id, text: 'Make a report', requestId: 'report' }); await space.harness.waitForIdle(ctx)
  const main = await space.mainBranch(tree.id), conv = await space.open(main, ctx), answer = (await conv.entries({}, 100, undefined, ctx)).items.find(e => e.kind === 'pi.assistant' && e.model?.[0]?.role === 'assistant' && e.model[0].stopReason === 'stop')!
  const fork = await space.fork(tree.id, main.id, answer.id)
  await space.send(tree.id, { text: 'fork-content-sentinel', requestId: 'fork', branchId: fork.id }); await space.harness.waitForIdle(ctx)
  const temp = await space.createTree(undefined, ctx, true), removed = await space.createTree()
  for (const [chat, marker] of [[temp, 'live-temporary-sentinel'], [removed, 'deleted-tree-sentinel']] as const) {
    await space.send(chat.id, { text: marker, requestId: marker }); await space.harness.waitForIdle(ctx)
    await writeFile(join(base, 'sessions', chat.id, marker + '.txt'), marker)
  }
  await space.deleteTree(removed.id)
  await mkdir(join(base, 'sessions', removed.id)); await writeFile(join(base, 'sessions', removed.id, 'deleted-tree-sentinel.txt'), 'deleted-tree-sentinel')
  const foreign = await other.request<TreeMeta>({ t: 'tree.create' })
  await other.request({ t: 'send', treeId: foreign.id, text: 'foreign-content-sentinel', requestId: 'foreign' }); await host.spaces.get(b.id)!.harness.waitForIdle(ctx)
  const project = await space.projects.create({ name: 'Research / notes', instructions: 'Project instructions' })
  const upload = await first.request<UploadedFile>({ t: 'upload', name: 'reference.txt', base64: Buffer.from('Project file').toString('base64') })
  await space.projects.addFiles(project.id, [upload.id])
  const memory = await space.memories.add({ text: 'A durable preference', source: 'manual' })
  await space.plugins.set('web', { secrets: { deepseekKey: 'provider-key-sentinel' } })
  await writeFile(join(base, 'sessions', tree.id, '.env'), 'API_KEY=secret-env-sentinel')
  await mkdir(join(base, 'skills', 'excluded'), { recursive: true }); await writeFile(join(base, 'skills', 'excluded', 'SKILL.md'), 'skill-sentinel')
  // Real multi-chunk input keeps the background task running while the other socket asks to start one.
  await writeFile(join(base, 'sessions', tree.id, 'large.bin'), new Uint8Array(8 * 1024 * 1024).fill(97))
  const concurrent = await Promise.allSettled([first.request<ExportInfo>({ t: 'export.create' }), second.request<ExportInfo>({ t: 'export.create' })])
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1)
  const failed = concurrent.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.match(String(failed.reason), /已有一个导出在进行/)
  const created = (concurrent.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<ExportInfo>).value
  assert.equal(created.status, 'running')
  const ready = await first.until(() => first.exports.find(e => e.id === created.id && e.status !== 'running'), 60_000)
  assert.equal(ready.status, 'ready', ready.error); assert.ok(ready.size! > 8 * 1024 * 1024); assert.ok(ready.finishedAt)
  await second.until(() => second.exports.some(e => e.id === created.id && e.status === 'ready')); assert.deepEqual(other.exports, [])
  const get = (id: string, cookie?: string) => fetch(`${host.url}/api/exports/${id}`, { headers: { ...(cookie && { cookie }) } })
  assert.equal((await get(created.id)).status, 401); assert.equal((await get(created.id, bc)).status, 404)
  await assert.rejects(other.request({ t: 'export.delete', exportId: created.id }), /不存在/)
  const response = await get(created.id, ac)
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/zip'); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-disposition')!, /^attachment; filename="gense-export-\d{4}-\d{2}-\d{2}\.zip"$/)
  const zipped = unzipSync(new Uint8Array(await response.arrayBuffer())), names = Object.keys(zipped)
  assert.ok(names.some(n => /^conversations\/\d{4}-\d{2}-\d{2}-.+\/conversation\.md$/.test(n)))
  const md = new TextDecoder().decode(zipped[names.find(n => n.endsWith('/conversation.md'))!]!)
  assert.match(md, /Make a report/); assert.match(md, /Final answer markdown/); assert.match(md, /工具：write/)
  assert.doesNotMatch(md, /hidden-thinking-sentinel|tool-arguments-sentinel|fork-content-sentinel|Successfully wrote|"path"/)
  assert.equal(new TextDecoder().decode(zipped[names.find(n => n.endsWith('/files/notes/report.md'))!]!), 'tool-arguments-sentinel')
  const projectPath = names.find(n => n.startsWith('projects/') && n.endsWith('/project.json'))!
  assert.equal(JSON.parse(new TextDecoder().decode(zipped[projectPath]!)).instructions, 'Project instructions')
  assert.equal(new TextDecoder().decode(zipped[names.find(n => n.endsWith('/files/reference.txt'))!]!), 'Project file')
  assert.deepEqual(JSON.parse(new TextDecoder().decode(zipped['memories.json']!)), [memory])
  const prefs = JSON.parse(new TextDecoder().decode(zipped['preferences.json']!))
  assert.equal(prefs.name, 'Ada'); assert.equal(prefs.instructions, 'Be brief'); assert.equal(prefs.suggestions, false)
  for (const [name, bytes] of Object.entries(zipped)) {
    assert.ok(!name.startsWith('/') && !name.split('/').includes('..'))
    assert.doesNotMatch(name, /app\.sqlite|space\.sqlite|\.env/)
    assert.doesNotMatch(new TextDecoder().decode(bytes), /live-temporary-sentinel|deleted-tree-sentinel|foreign-content-sentinel|provider-key-sentinel|secret-env-sentinel|skill-sentinel/)
  }
  assert.equal((await readdir(join(base, 'exports'))).some(name => name.endsWith('.tmp')), false)
  for (let i = 0; i < 3; i++) {
    const next = await first.request<ExportInfo>({ t: 'export.create' })
    await first.until(() => first.exports.some(e => e.id === next.id && e.status === 'ready'), 60_000)
  }
  assert.equal(first.exports.length, 3); assert.ok(!first.exports.some(e => e.id === created.id))
  assert.equal((await get(created.id, ac)).status, 404); await assert.rejects(access(join(base, 'exports', created.id + '.zip')))
  const kept = first.exports[0]!
  await first.request({ t: 'export.delete', exportId: kept.id }); assert.equal((await get(kept.id, ac)).status, 404)
  // C-5 already implements this endpoint: D only verifies both arrays remain owned even with a forged query userId.
  await host.app.recordService(a.id, 'ocr', 2); await host.app.recordService(b.id, 'tts', 4)
  const usage = await (await fetch(host.url + '/api/usage?userId=' + b.id, { headers: { cookie: ac } })).json() as UsageReport
  assert.ok(usage.models.length && usage.models.every(row => row.userId === a.id))
  assert.deepEqual(usage.services.map(row => [row.userId, row.service]), [[a.id, 'ocr']])
  const saved = first.exports.map(e => e.id)
  await space.db.run("INSERT INTO exports (id, status, createdAt) VALUES ('interrupted', 'running', ?)", Date.now() + 1)
  await writeFile(join(base, 'exports', 'interrupted.zip.tmp'), 'unfinished archive')
  for (const c of clients.splice(0)) c.close()
  await host.close(); host = await startServer(options)
  const reopened = await Client.connect(host.url, ac); clients.push(reopened)
  await reopened.until(() => reopened.exports.length === saved.length + 1)
  assert.deepEqual(reopened.exports.filter(e => e.id !== 'interrupted').map(e => e.id), saved)
  assert.equal(reopened.exports.find(e => e.id === 'interrupted')!.status, 'failed')
  assert.match(reopened.exports.find(e => e.id === 'interrupted')!.error!, /重启中断/)
  await assert.rejects(access(join(base, 'exports', 'interrupted.zip.tmp')))
  assert.equal((await get('interrupted', ac)).status, 404)
  const download = await get(saved[0]!, ac); assert.equal(download.status, 200); await download.arrayBuffer()
})

test('D5: an oversized sparse workspace file fails cleanly instead of publishing an invalid ZIP32 archive', async t => {
  const root = await tempDir(), host = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: root, SANDBOX: '0', BACKUPS: '0' }), port: 0 })
  t.after(() => host.close())
  const user = await host.auth.register('a@example.com', 'a long password'), cookie = (await login(host.url, 'a long password', user.email)).cookie!
  const client = await Client.connect(host.url, cookie); t.after(() => client.close())
  const tree = await client.request<TreeMeta>({ t: 'tree.create' }), path = join(root, 'users', user.id, 'files', 'sessions', tree.id, 'large.bin')
  await writeFile(path, ''); await truncate(path, 0x1_0000_0000)
  const exported = await client.request<ExportInfo>({ t: 'export.create' })
  const failed = await client.until(() => client.exports.find(e => e.id === exported.id && e.status !== 'running'))
  assert.equal(failed.status, 'failed'); assert.match(failed.error!, /4 GiB/)
  const folder = join(root, 'users', user.id, 'files', 'exports')
  assert.deepEqual(await readdir(folder), [])
  assert.equal((await fetch(host.url + '/api/exports/' + failed.id, { headers: { cookie } })).status, 404)
})

test('D5: deleting a tree during a real multi-chunk export prevents its archive from becoming downloadable', { timeout: 30_000 }, async t => {
  let reading!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { reading = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const root = await tempDir(), host = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: root, SANDBOX: '0', BACKUPS: '0' }), port: 0 })
  t.after(async () => { release(); await host.close() })
  const user = await host.auth.register('a@example.com', 'a long password'), cookie = (await login(host.url, 'a long password', user.email)).cookie!
  const client = await Client.connect(host.url, cookie); t.after(() => client.close())
  const tree = await client.request<TreeMeta>({ t: 'tree.create' }), base = join(root, 'users', user.id, 'files')
  await writeFile(join(base, 'sessions', tree.id, 'large.bin'), new Uint8Array(16 * 1024 * 1024))
  // Delay an actual positional file read, retaining its real open descriptor while deletion unlinks the directory.
  const space = host.spaces.get(user.id)!, original = space.workspace.env.bind(space.workspace)
  space.workspace.env = async cwd => {
    const env = await original(cwd)
    return new Proxy(env, { get(target, key) {
      if (key === 'openBinaryReader') return async (...args: Parameters<typeof target.openBinaryReader>) => {
        const result = await target.openBinaryReader(...args)
        if (!result.ok || !args[0].endsWith('/large.bin')) return result
        return { ok: true as const, value: new Proxy(result.value, { get(reader, property) {
          if (property === 'read') return async (...readArgs: Parameters<typeof reader.read>) => { reading(); await gate; return reader.read(...readArgs) }
          const value = Reflect.get(reader, property, reader)
          return typeof value === 'function' ? value.bind(reader) : value
        } }) }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  const exported = await client.request<ExportInfo>({ t: 'export.create' })
  await started
  await client.request({ t: 'tree.delete', treeId: tree.id })
  release()
  const failed = await client.until(() => client.exports.find(e => e.id === exported.id && e.status !== 'running'))
  assert.equal(failed.status, 'failed', 'a tree removed during building cannot be published')
  assert.deepEqual(await readdir(join(base, 'exports')), [])
  assert.equal((await fetch(host.url + '/api/exports/' + failed.id, { headers: { cookie } })).status, 404)
})
