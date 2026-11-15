import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { parseNote } from '@gense/protocol'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UserSpace } from '../src/agent/space.ts'
import { AppStore } from '../src/platform/app.ts'
import { Auth } from '../src/platform/auth.ts'
import { fauxModels } from '../src/agent/faux.ts'
import { diskEnv, docxFile, pdfFile } from './fixtures.ts'
import { tempDir } from './host-helpers.ts'

test('C6: local text extraction is listed in the actual user attachment note and written alongside its source', async t => {
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: fauxModels(), env: await diskEnv() })
  t.after(() => space.close())
  const upload = await space.workspace.upload('report.docx', docxFile())
  const tree = await space.createTree()
  await space.send(tree.id, { text: 'Read this', requestId: 'local', attachments: [upload.id] }); await space.harness.waitForIdle(ctx)
  const conv = await space.open((await space.branchRow(tree.id)).branch, ctx)
  const user = (await conv.context(ctx)).messages.find(m => m.role === 'user')!
  const note = (user.content as { type: string; text?: string }[]).map(b => b.text && parseNote(b.text)).find(n => n && n.attachments.length)!
  assert.ok(note); assert.equal(note.parsedAttachments[0]!.how, 'text')
  assert.equal(note.parsedAttachments[0]!.pages, undefined)
  const read = await space.workspace.read(tree.id, note.parsedAttachments[0]!.textPath)
  assert.match(Buffer.from(read.base64, 'base64').toString(), /第一段 & 续/)
})

test('C6/C8: OCR uses shared credentials, removes location wrappers, caches across restart, and fails open', async t => {
  const requests: { name: string; order: string[]; key: string | undefined }[] = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const form = await new Request('http://local/ocr', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: Buffer.concat(chunks) }).formData()
    const file = form.get('file') as File
    requests.push({ name: file.name, order: [...form.keys()], key: req.headers.authorization })
    res.writeHead(200, { 'content-type': 'application/json' })
    if (file.name === 'bad.doc') res.end(JSON.stringify({ error: { message: 'unavailable' } }))
    else res.end(JSON.stringify({ page_count: 2, pages: [{ text: '<｜ref｜>Scanned text<｜/ref｜><｜box｜>[[1,2,3,4]]<｜/box｜>', finish_reason: 'stop' }, { text: 'Page two', finish_reason: 'stop' }] }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections() }))
  const root = await tempDir(), db = await openNodeSqliteDatabase(join(root, 'app.sqlite')), app = await AppStore.open(db, 'seal'), auth = await Auth.open(db)
  t.after(async () => { await app.flush(); await db.close() })
  const user = await auth.register('ocr@example.com', 'long-enough-password')
  await app.putProvider({ kind: 'deepseek', name: 'Services', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, modelIds: [], apiKey: 'service-key' })
  const env = await diskEnv(join(root, 'files'))
  const faux = fauxProvider({ models: [{ id: 'plain', input: ['text'] }] }); faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage('ok')))
  const model = faux.getModel(), option = { provider: model.provider, id: model.id, name: model.name }
  const open = async () => UserSpace.open(await openNodeSqliteDatabase(join(root, 'space.sqlite')), { models: { providers: [faux.provider], options: [option], defaultModel: option }, env, deepseekService: () => app.deepseekService(), serviceUsage: (service, units) => app.recordService(user.id, service, units) })
  let space = await open()
  const tree = await space.createTree(), scan = await space.workspace.upload('scan.pdf', pdfFile(''))
  await space.send(tree.id, { text: 'Scan', requestId: 'scan', attachments: [scan.id] }); await space.harness.waitForIdle(ctx)
  let conv = await space.open((await space.branchRow(tree.id)).branch, ctx)
  const getNotes = async () => (await conv.context(ctx)).messages.filter(m => m.role === 'user').flatMap(m => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content).flatMap(b => b.type === 'text' ? [parseNote(b.text)] : [])).filter(n => n && n.attachments.length)
  const parsed = (await getNotes()).at(-1)!.parsedAttachments[0]!
  assert.equal(parsed.how, 'ocr'); assert.equal(parsed.pages, 2)
  const contents = Buffer.from((await space.workspace.read(tree.id, parsed.textPath)).base64, 'base64').toString()
  assert.equal(contents, 'Scanned text\n\nPage two')
  assert.equal(requests[0]!.key, 'Bearer service-key'); assert.deepEqual(requests[0]!.order, ['purpose', 'file'])
  await space.close(); space = await open(); t.after(() => space.close())
  conv = await space.open((await space.branchRow(tree.id)).branch, ctx)
  await space.send(tree.id, { text: 'Cached', requestId: 'cached', attachments: [scan.id] }); await space.harness.waitForIdle(ctx)
  assert.equal(requests.length, 1)
  const image = await space.workspace.upload('photo.png', Buffer.from('image fixture'))
  await space.send(tree.id, { text: 'No vision', requestId: 'image', attachments: [image.id] }); await space.harness.waitForIdle(ctx)
  const lastUser = (await conv.context(ctx)).messages.filter(m => m.role === 'user').at(-1)!
  assert.ok(Array.isArray(lastUser.content) && !lastUser.content.some(b => b.type === 'image'))
  const bad = await space.workspace.upload('bad.doc', Buffer.from('legacy doc'))
  await space.send(tree.id, { text: 'Failure still answers', requestId: 'bad', attachments: [bad.id] }); await space.harness.waitForIdle(ctx)
  assert.deepEqual((await getNotes()).at(-1)!.parsedAttachments, [])
  const usage = await db.get<{ calls: number; units: number }>("SELECT calls, units FROM service_usage WHERE userId = ? AND service = 'ocr'", user.id)
  assert.deepEqual({ ...usage }, { calls: 2, units: 4 })
})
