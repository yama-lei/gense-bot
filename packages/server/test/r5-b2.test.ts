import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'
import { strToU8, zipSync } from 'fflate'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { fauxModels, parseSkill, UserSpace } from '../src/index.ts'
import { archiveFiles, gitFiles, MAX_FILES } from '../src/plugins/skills/sources.ts'
import { diskEnv } from './fixtures.ts'
import { tempDir } from './host-helpers.ts'

const raw = `---
name: demo-skill
description: >-
  Read a document and
  produce a careful answer.
license: MIT
compatibility: Requires Node.js
metadata:
  author: community
  version: "1.0"
allowed-tools: Read Bash(node:*)
---
# Demo
Read references/guide.md and run scripts/run.mjs.
`
const files = { 'repo/demo-skill/SKILL.md': strToU8(raw), 'repo/demo-skill/references/guide.md': strToU8('Reference text'), 'repo/demo-skill/scripts/run.mjs': strToU8('console.log("skill script ran")'), 'repo/demo-skill/assets/icon.bin': Uint8Array.of(0, 255, 1) }

test('N24/N25: full community front matter and directory files survive install, switches, restart and removal', async () => {
  const root = await tempDir(), path = join(root, 'skills.sqlite'), env = await diskEnv(root)
  let space = await UserSpace.open(await openNodeSqliteDatabase(path), { models: fauxModels(), env })
  try {
    const parsed = parseSkill(raw, true)!
    assert.equal(parsed.description, 'Read a document and produce a careful answer.')
    assert.deepEqual(parsed.metadata, { author: 'community', version: '1.0' })
    assert.equal(parsed['allowed-tools'], 'Read Bash(node:*)')
    const upload = await space.workspace.upload('skills.zip', zipSync(files))
    const installed = await space.skills.install({ upload: upload.id })
    assert.equal(installed[0]!.license, 'MIT')
    assert.equal(installed[0]!.source, 'upload')
    assert.match(installed[0]!.origin!, /skills.zip/)
    assert.deepEqual(installed[0]!.files, ['SKILL.md', 'assets/icon.bin', 'references/guide.md', 'scripts/run.mjs'])
    assert.equal((await space.skills.read('demo-skill', 'references/guide.md')).text, 'Reference text')
    const mounted = await env('/data')
    const binary = await mounted.readBinaryFile('/data/skills/demo-skill/assets/icon.bin', ctx)
    assert.ok(binary.ok); assert.deepEqual([...binary.value], [0,255,1])
    await space.skills.set('demo-skill', false)
    assert.equal((await space.skills.read('demo-skill', 'SKILL.md')).text, raw)
    assert.equal((await mounted.listDir('/data/skills/demo-skill', ctx)).ok, false)
    await space.close()
    space = await UserSpace.open(await openNodeSqliteDatabase(path), { models: fauxModels(), env })
    assert.equal(space.skills.list().find(s => s.name === 'demo-skill')!.enabled, false)
    await space.skills.set('demo-skill', true)
    assert.equal((await mounted.readTextFile('/data/skills/demo-skill/scripts/run.mjs', ctx)).ok, true)
    await assert.rejects(space.skills.read('demo-skill', '../outside'), /路径/)
    await space.skills.remove('demo-skill')
    assert.ok(!space.skills.list().some(s => s.name === 'demo-skill'))
    assert.equal((await mounted.listDir('/data/skills/demo-skill', ctx)).ok, false)
    assert.equal(space.skills.list().filter(s => s.source === 'builtin').length, 3)
  } finally { await space.close() }
})

test('N24: archives reject traversal, symlinks, excessive files, bad metadata and conflicting skill names', async () => {
  assert.throws(() => archiveFiles(zipSync({ '../escape': strToU8('x') })), /路径/)
  assert.throws(() => archiveFiles(zipSync(Object.fromEntries(Array.from({ length: MAX_FILES + 1 }, (_,i) => ['a/' + i, strToU8('')])))), /太多/)
  const symlink = zipSync({ 'link': strToU8('../outside') })
  const view = new DataView(symlink.buffer)
  for (let i = 0; i < symlink.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 38, 0xa1ff0000, true)
  assert.throws(() => archiveFiles(symlink), /符号链接/)
  for (const changed of [raw.replace('demo-skill','Bad_Name'), raw.replace('version: "1.0"','version: 1'), raw.replace('name: demo-skill','name: demo--skill'), raw.replace('license: MIT','license: [MIT]')]) assert.equal(parseSkill(changed, true), null)
  assert.ok(parseSkill('---\nname: 论文速读\ndescription: 内置\n---\nRead it'))
  assert.equal(parseSkill('---\nname: 论文速读\ndescription: 安装\n---\nRead it', true), null)
  await assert.rejects(gitFiles({ git: 'https://user:token@example.com/repo' }, join(import.meta.dirname, '../../../data/git-test')), /凭据/)
  await assert.rejects(gitFiles({ git: 'file:///outside' }, join(import.meta.dirname, '../../../data/git-test')), /HTTP/)
  await assert.rejects(gitFiles({ git: 'https://example.com/repo', path: '../escape' }, join(import.meta.dirname, '../../../data/git-test')), /路径/)
})

test('N25: a real shallow Git fetch installs an unmodified Skill with ref and subdirectory selection', async () => {
  const { createServer } = await import('node:http')
  const { spawn } = await import('node:child_process')
  const repository = new URL('../../../.git', import.meta.url).pathname
  // Serve this repository read-only over Git's HTTP wire protocol; all clone output is confined to our data directory.
  const server = createServer((req, res) => {
    const advertise = req.url!.includes('/info/refs')
    res.setHeader('content-type', advertise ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-upload-pack-result')
    if (advertise) res.write('001e# service=git-upload-pack\n0000')
    const child = spawn('git', ['upload-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), repository], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.pipe(res)
    if (advertise) child.stdin.end()
    else req.pipe(child.stdin)
    child.on('error', () => res.destroy())
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models: fauxModels(), env: await diskEnv(), skillTempDir: await tempDir() })
  try {
    const skills = await space.skills.install({ git: `http://127.0.0.1:${port}/repo`, ref: 'feat/r5-backend', path: '.agents/skills/code-review' })
    assert.equal(skills[0]!.name, 'code-review')
    assert.equal(skills[0]!.source, 'git')
    assert.ok(skills[0]!.files.includes('agents/openai.yaml'))
    assert.match((await space.skills.read('code-review', 'SKILL.md')).text, /name: code-review/)
  } finally { await space.close(); await new Promise<void>(r => server.close(() => r())) }
})

test('N24: an installed bundled script executes through the real read-only Skills mount in Docker', { timeout: 60000 }, async t => {
  const { execFileSync } = await import('node:child_process')
  try { execFileSync('docker', ['image','inspect','gense-sandbox:slim'], { stdio:'ignore', timeout:5000 }) } catch { t.skip('sandbox image unavailable'); return }
  const { NodeExecutionEnv } = await import('@earendil-works/pi-durable/env/node')
  const { Sandbox, SandboxedEnv } = await import('../src/platform/sandbox.ts')
  const root = await tempDir()
  const sandbox = new Sandbox({ root, name:'gense-skill-'+crypto.randomUUID().slice(0,8), image:()=> 'slim' })
  const space = await UserSpace.open(await openNodeSqliteDatabase(':memory:'), { models:fauxModels(), sandbox:true, env:cwd=>new SandboxedEnv(new NodeExecutionEnv({cwd:root}),sandbox,{target:root,cwd}) })
  try {
    const upload = await space.workspace.upload('community.zip',zipSync(files))
    await space.skills.install({upload:upload.id})
    const tree=await space.createTree()
    await space.send(tree.id,{text:'[工具 bash] {"command":"node /data/skills/demo-skill/scripts/run.mjs"}',requestId:'run-skill-script'})
    await space.harness.waitForIdle(ctx)
    const {watch}=await space.watch(tree.id);await watch.stop()
    assert.match(JSON.stringify(watch.value.entries),/skill script ran/)
  } finally { await space.close(); await sandbox.stop() }
})
