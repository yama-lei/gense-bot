import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { startServer } from '../src/platform/server.ts'
import { configFromEnv } from '../src/platform/config.ts'
import { audioDuration, ttsCharacters } from '../src/platform/speech.ts'
import { login, tempDir } from './host-helpers.ts'

const wav = (seconds: number) => {
  const bytes = Buffer.alloc(44 + Math.ceil(seconds * 16000))
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40)
  return bytes
}

test('C7: duration and billed characters use real WAV/Ogg containers and Unicode code points', () => {
  assert.equal(audioDuration(wav(5), 'audio/wav'), 5)
  assert.throws(() => audioDuration(Buffer.from('not audio'), 'audio/wav'))
  const opus = Buffer.alloc(19); opus.write('OpusHead'); opus[8] = 1; opus[9] = 1; opus.writeUInt16LE(312, 10)
  const page = (granule: bigint, payload: Buffer) => {
    const header = Buffer.alloc(28); header.write('OggS'); header.writeBigInt64LE(granule, 6); header[26] = 1; header[27] = payload.length
    return Buffer.concat([header, payload])
  }
  assert.equal(audioDuration(Buffer.concat([page(0n, opus), page(48312n, Buffer.from([0xf8, 0xff, 0xfe]))]), 'audio/ogg'), 1)
  assert.equal(ttsCharacters('中文 a😀'), 7)
})

test('C7/C8: speech HTTP is authenticated, bounded and tenant-limited; TTS forwards its first bytes before completion', async t => {
  const requests: { path: string; key?: string; body?: any }[] = []
  let release!: () => void
  const tail = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    if (req.url === '/v1/tools/asr') {
      const form = await new Request('http://service/asr', { method: 'POST', headers: { 'content-type': req.headers['content-type']! }, body: bytes }).formData()
      requests.push({ path: req.url, key: req.headers.authorization, body: { fileSize: (form.get('file') as File).size } })
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'A transcript', duration_ms: 5001 }))
    } else {
      requests.push({ path: req.url!, key: req.headers.authorization, body: JSON.parse(bytes.toString()) })
      res.writeHead(200, { 'content-type': 'audio/wav' }); res.write('RIFF'); await tail; res.end('audio tail')
    }
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  t.after(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeIdleConnections() }))
  const root = await tempDir(), host = await startServer({ ...configFromEnv({ GENSE_FAUX: '1', DATA_DIR: root, SANDBOX: '0', BACKUPS: '0', TOKEN_ENCRYPTION_KEY: 'seal' }), port: 0 })
  t.after(() => host.close())
  await host.auth.register('owner@example.com', 'correct password')
  await host.auth.register('other@example.com', 'correct password')
  const owner = await login(host.url, 'correct password'), other = await login(host.url, 'correct password', 'other@example.com')
  const call = (path: string, body?: BodyInit, type = 'application/json', cookie = owner.cookie!, origin?: string) => fetch(host.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': type, ...(origin && { origin }) }, ...(body !== undefined && { body }) })
  assert.equal((await fetch(host.url + '/api/speech')).status, 401)
  assert.deepEqual(await (await call('/api/speech')).json(), { asr: false, tts: false })
  assert.equal((await call('/api/speech/tts', '{"text":"hello"}')).status, 503)
  const provider = await call('/api/admin/providers', JSON.stringify({ kind: 'deepseek', name: 'Speech', baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, modelIds: [], apiKey: 'speech-secret' }))
  assert.equal(provider.status, 200)
  assert.deepEqual(await (await call('/api/speech')).json(), { asr: true, tts: true })
  const asr = await call('/api/speech/asr', wav(5), 'audio/wav')
  assert.equal(asr.status, 200); assert.deepEqual(await asr.json(), { text: 'A transcript', durationMs: 5001 })
  assert.ok(requests[0]!.body.fileSize > 64 * 1024)
  assert.equal((await call('/api/speech/asr', wav(121), 'audio/wav')).status, 413)
  assert.equal((await call('/api/speech/asr', new Uint8Array(8 * 1024 * 1024 + 1), 'audio/wav')).status, 413)
  assert.equal((await call('/api/speech/asr', 'webm', 'audio/webm')).status, 415)
  assert.equal((await call('/api/speech/tts', JSON.stringify({ text: 'x'.repeat(4001) }))).status, 413)
  assert.equal((await call('/api/speech/tts', '{"text":"hello"}', 'application/json', owner.cookie!, 'https://other.invalid')).status, 403)
  const tts = await call('/api/speech/tts', JSON.stringify({ text: '中文 a😀', voice: 'tide' }))
  assert.equal(tts.headers.get('content-type'), 'audio/wav')
  const reader = tts.body!.getReader(), first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), 'RIFF')
  release(); let rest = ''; for (;;) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value) }
  assert.equal(rest, 'audio tail')
  assert.deepEqual(requests[1]!.body, { text: '中文 a😀', voice_id: 'tide', format: 'wav', filter_markdown: true })
  assert.ok(requests.every(r => r.key === 'Bearer speech-secret'))
  let limited = false
  for (let i = 0; i < 25; i++) if ((await call('/api/speech/tts', '{"text":""}')).status === 429) { limited = true; break }
  assert.ok(limited)
  assert.equal((await call('/api/speech/tts', '{"text":""}', 'application/json', other.cookie!)).status, 400)
  const db = await openNodeSqliteDatabase(join(root, 'app.sqlite'))
  try {
    const rows = await db.all<{ service: string; calls: number; units: number }>('SELECT service, calls, units FROM service_usage ORDER BY service')
    assert.deepEqual(rows.map(r => ({ ...r })), [{ service: 'asr', calls: 1, units: 6 }, { service: 'tts', calls: 1, units: 7 }])
  } finally { await db.close() }
})
