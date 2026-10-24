// Stage-8 E2E (R57–R61): `bash` in each user's Docker sandbox, against real containers. Needs Docker and the images
// from `npm run sandbox:build`; skipped without them.
import type { FileEntry, TreeMeta } from '@gense/core/protocol'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { configFromEnv } from '../src/config.ts'
import { NETWORK } from '../src/sandbox.ts'
import { startServer } from '../src/server.ts'
import { Client, fakeUpstream, login, pluginEnv, sections, tempDir, textOf } from './helpers.ts'

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const built = (image: string) => {
  try {
    return !!docker('image', 'inspect', image)
  } catch {
    return false
  }
}
const ready = built('gense-sandbox:slim')

const USERS = [
  ['a@example.com', 'correct horse'],
  ['b@example.com', 'battery staple'],
] as const
const IDLE_MS = 3000
let server: Awaited<ReturnType<typeof startServer>>
let upstream: Awaited<ReturnType<typeof fakeUpstream>>
const env = (url: string) => pluginEnv(url)

before(async () => {
  if (!ready) return
  upstream = await fakeUpstream()
  const config = configFromEnv({ GENSE_FAUX: '1', DATA_DIR: await tempDir(), ...env(upstream.url) })
  server = await startServer({ ...config, sandbox: { memory: '256m', idleMs: IDLE_MS }, port: 0 })
  for (const [email, password] of USERS) await server.auth.createUser(email, password)
})
after(async () => {
  if (!ready) return
  await server.close()
  await upstream.close()
})

/** A signed-in client with a fresh conversation, and `bash` through the faux model's tool rule. */
async function session(user = 0) {
  const [email, password] = USERS[user]!
  const { cookie } = await login(server.url, email, password)
  const client = await Client.connect(server.url, cookie)
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  const results = () => client.views.get(tree.id)?.entries.filter((e) => e.kind === 'pi.tool-result') ?? []
  let n = 0
  const tool = async (name: string, args: object) => {
    const count = results().length
    await client.request({ t: 'send', treeId: tree.id, text: `[工具 ${name}] ${JSON.stringify(args)}`, requestId: `b${++n}` })
    const result = await client.until(() => results()[count], 120_000, `${name}: ${JSON.stringify(args)}`)
    // Wait for the answer, so the next send is not queued behind this run.
    await client.until(() => client.branches.get(tree.id)?.branches.every((b) => b.status !== 'running'), 30_000, 'idle')
    return { text: textOf(result), error: !!result.model?.[0]?.isError }
  }
  const bash = (command: string, timeout?: number) => tool('bash', { command, timeout })
  return { client, tree, bash, tool }
}

const sandboxOf = (user: number) => [...server.sandboxes.values()][user]!

test('R57: bash runs in the sandbox and a png it writes appears in the file panel', { skip: !ready, timeout: 180_000 }, async () => {
  const { client, tree, bash } = await session()
  assert.equal(client.plugins.find((p) => p.id === 'sandbox')?.enabled, true)
  const png = await bash(
    `python3 -c "import zlib,struct
def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d))
raw=b''.join(b'\\x00'+b'\\xff\\x00\\x00'*8 for _ in range(8))
open('plot.png','wb').write(b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',8,8,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))" && pwd && whoami && file plot.png`,
  )
  assert.equal(png.error, false, png.text)
  assert.match(png.text, new RegExp(`/data/sessions/${tree.id}`))
  assert.match(png.text, /PNG image data, 8 x 8/)
  const listed = await client.request<FileEntry[]>({ t: 'files.list', treeId: tree.id })
  assert.ok(listed.some((f) => f.path.endsWith('/plot.png')))
  assert.match(sections(client.views.get(tree.id)).get('sandbox') ?? '', /bash/)

  // A nonzero exit is an error the model sees, with the output.
  const failed = await bash('echo before; exit 3')
  assert.equal(failed.error, true)
  assert.match(failed.text, /before/)
  client.close()
})

test('R57: read opens what a command left in /tmp, which the file tools cannot change', { skip: !ready, timeout: 120_000 }, async () => {
  const { client, bash, tool } = await session()
  assert.equal((await bash('mkdir -p /tmp/crab && echo 螃蟹 > /tmp/crab/note.txt')).error, false)
  const read = await tool('read', { path: '/tmp/crab/note.txt' })
  assert.equal(read.error, false, read.text)
  assert.match(read.text, /螃蟹/)
  const write = await tool('write', { path: '/tmp/crab/note.txt', content: 'x' })
  assert.equal(write.error, true)
  assert.match(write.text, /只能修改本会话工作区/)
  // Not the host's /tmp.
  const host = await tool('read', { path: '/tmp/../etc/hostname' })
  assert.equal(host.error, true)
  client.close()
})

test('R58: the sandbox reaches the internet but not the host or the LAN; switching the image applies', { skip: !built('gense-sandbox:full'), timeout: 600_000 }, async () => {
  const { client, bash } = await session()
  const online = await bash('curl -sS -o /dev/null -w "%{http_code}" https://example.com && python3 --version && node --version && uv --version && git --version && rg --version | head -1 && zip -v | head -2 | tail -1')
  assert.equal(online.error, false, online.text)
  assert.match(online.text, /^200Python 3/)

  const listener = createServer((_req, res) => res.end('host secret page'))
  await new Promise<void>((resolve) => listener.listen(0, '0.0.0.0', resolve))
  const { port } = listener.address() as { port: number }
  const gateway = docker('network', 'inspect', NETWORK, '-f', '{{(index .IPAM.Config 0).Gateway}}')
  const blocked = await bash(`curl -sS --max-time 5 http://${gateway}:${port}/ ; curl -sS --max-time 5 http://172.17.0.1:${port}/ ; echo done`)
  listener.close()
  assert.doesNotMatch(blocked.text, /host secret page/)
  assert.match(blocked.text, /done/)

  const slim = await bash('python3 -c "import numpy" 2>&1 || echo missing')
  assert.match(slim.text, /missing/)
  await client.request({ t: 'plugin.set', pluginId: 'sandbox', values: { image: 'full' } })
  const full = await bash('python3 -c "import numpy, pandas, matplotlib, docx, pptx, pypdf; print(numpy.__version__)" && ffmpeg -version | head -1 && pandoc --version | head -1')
  assert.equal(full.error, false, full.text)
  assert.match(full.text, /2\.5\.3[\s\S]*ffmpeg version[\s\S]*pandoc/)
  await client.request({ t: 'plugin.set', pluginId: 'sandbox', values: { image: 'slim' } })
  client.close()
})

test('R59: no secret reaches the sandbox', { skip: !ready, timeout: 120_000 }, async () => {
  const { client, bash } = await session()
  await client.request({ t: 'plugin.set', pluginId: 'web', secrets: { deepseekKey: 'user-sealed-key' } })
  const seen = await bash('env; cat /proc/1/environ | tr "\\0" "\\n"; ls -a /data; grep -rIl -e server-key -e image-key -e user-sealed-key -e test-encryption-key /data 2>/dev/null; echo end')
  assert.match(seen.text, /end/)
  for (const secret of [...Object.values(env(upstream.url)).filter((v) => !v.startsWith('http')), 'user-sealed-key']) {
    assert.ok(!seen.text.includes(secret), `the sandbox sees ${secret}`)
  }
  assert.doesNotMatch(seen.text, /pi\.sqlite|_PROXY=http/)
  client.close()
})

test('R60: a runaway command is stopped at its limit; an idle sandbox stops and restarts with the files', { skip: !ready, timeout: 180_000 }, async () => {
  const { bash, client } = await session()
  const started = Date.now()
  const slow = await bash('echo start; sleep 60 & sleep 60; echo never', 2)
  assert.equal(slow.error, true)
  assert.match(slow.text, /start[\s\S]*timed out/)
  assert.ok(Date.now() - started < 30_000)
  const left = await bash('ps -eo args | grep -c "[s]leep 60" || true')
  assert.match(left.text, /^0/, 'the timed-out command and its children are gone')

  const memory = await bash('python3 -c "a = bytearray(1024 ** 3); print(len(a))"')
  assert.equal(memory.error, true)
  assert.match(memory.text, /137|Killed|MemoryError/)
  assert.match((await bash('echo alive')).text, /alive/, 'the sandbox survives')

  await bash('echo kept > kept.txt')
  const name = sandboxOf(0).name
  const deadline = Date.now() + IDLE_MS + 30_000
  while (Date.now() < deadline && docker('ps', '-q', '--filter', `name=^${name}$`)) await new Promise((r) => setTimeout(r, 500))
  assert.equal(docker('ps', '-q', '--filter', `name=^${name}$`), '', 'stopped when idle')
  assert.match((await bash('cat kept.txt')).text, /kept/)
  client.close()
})

test('R61: users see neither each other’s files nor processes', { skip: !ready, timeout: 180_000 }, async () => {
  const a = await session(0)
  const b = await session(1)
  await a.bash('echo mine > private.txt; (sleep 120 &) ; true')
  assert.ok(!(await b.bash('ls /data/sessions')).text.includes(a.tree.id), 'the other user’s tree is not there')
  const seen = await b.bash(`cat /data/sessions/${a.tree.id}/private.txt; grep -rs mine /data/sessions; ps -eo args; true`)
  assert.match(seen.text, /No such file/)
  assert.doesNotMatch(seen.text, /mine\n|sleep 120/)
  assert.notEqual(sandboxOf(0).name, sandboxOf(1).name)
  await a.bash('pkill -f "sleep 120"; true')
  a.client.close()
  b.client.close()
})
