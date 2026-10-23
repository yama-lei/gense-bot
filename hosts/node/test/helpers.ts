// Drives a real host over HTTP and WebSocket, as the browser does.
import { applyImmutable, decoder, type Decoder } from '@earendil-works/chord/delta'
import type { PluginState } from '@gense/core/catalog'
import type { ClientRequest, FileEntry, ServerMessage, TreeMeta, UploadedFile } from '@gense/core/protocol'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

export const tempDir = () => mkdtemp(join(tmpdir(), 'gense-test-'))

export async function login(url: string, email: string, password: string) {
  const res = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  return { status: res.status, body: (await res.json()) as { email?: string; error?: string }, cookie }
}

type Entry = { kind: string; data?: unknown; model?: { role: string; content: unknown; stopReason?: string; isError?: boolean; details?: unknown }[] }
export type View = { entries: Entry[]; docs: Record<string, unknown> }

export const textOf = (e: Entry) => {
  const content = e.model?.[0]?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text : '')).join('') : ''
}

export const stopReason = (e: Entry) => e.model?.[0]?.stopReason

export class Client {
  readonly views = new Map<string, View>()
  trees: TreeMeta[] = []
  plugins: PluginState[] = []
  readonly #ws: WebSocket
  readonly #decoders = new Map<string, Decoder>()
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  readonly #waiters = new Set<() => void>()
  #next = 1

  private constructor(ws: WebSocket) {
    this.#ws = ws
    ws.on('message', (data) => this.#receive(JSON.parse(String(data)) as ServerMessage))
  }

  static connect(url: string, cookie: string | undefined, origin?: string) {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`, { headers: { ...(cookie && { cookie }), ...(origin && { origin }) } })
    return new Promise<Client>((resolve, reject) => {
      ws.once('open', () => resolve(new Client(ws)))
      ws.once('unexpected-response', (_req, res) => reject(new Error(`ws rejected: ${res.statusCode}`)))
      ws.once('error', reject)
    })
  }

  #receive(m: ServerMessage) {
    if (m.t === 'trees') this.trees = m.trees
    if (m.t === 'plugins') this.plugins = m.plugins
    if (m.t === 'view') {
      this.#decoders.set(m.treeId, decoder())
      this.views.set(m.treeId, m.value as View)
    }
    if (m.t === 'ops') {
      const ops = this.#decoders.get(m.treeId)!.decode(m.ops)
      this.views.set(m.treeId, applyImmutable(this.views.get(m.treeId), ops))
    }
    if (m.t === 'reply') {
      const p = this.#pending.get(m.id)
      this.#pending.delete(m.id)
      if (m.error) p?.reject(new Error(m.error))
      else p?.resolve(m.value)
    }
    for (const w of this.#waiters) w()
  }

  request<T = unknown>(r: DistributiveOmit<ClientRequest, 'id'>): Promise<T> {
    const id = this.#next++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.#ws.send(JSON.stringify({ ...r, id }))
    })
  }

  /** Resolves once `check` holds after some message; rejects after `ms`. */
  until<T>(check: () => T | undefined | false, ms = 10_000, label = 'condition'): Promise<T> {
    return new Promise((resolve, reject) => {
      const tryIt = () => {
        const v = check()
        if (v) {
          this.#waiters.delete(tryIt)
          clearTimeout(timer)
          resolve(v)
        }
      }
      const timer = setTimeout(() => {
        this.#waiters.delete(tryIt)
        reject(new Error(`timed out waiting for ${label}`))
      }, ms)
      this.#waiters.add(tryIt)
      tryIt()
    })
  }

  close() {
    this.#ws.close()
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * Stage-3 workspace flow, shared by both hosts: the agent writes a file with a tool, the panel lists, previews,
 * downloads and deletes it, and an upload attached to a message lands in the tree's `attachments/`.
 */
export async function workspaceScenario(client: Client) {
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  const dir = `/data/sessions/${tree.id}`
  const answers = () => client.views.get(tree.id)?.entries.filter((e) => e.kind === 'pi.assistant' && textOf(e)) ?? []
  await client.request({ t: 'watch', treeId: tree.id })

  await client.request({ t: 'send', treeId: tree.id, text: '[工具 write] {"path":"notes/a.md","content":"# 标题\\n正文"}', requestId: 'r1' })
  const wrote = await client.until(() => answers()[0], 15_000, 'tool answer')
  assert.match(textOf(wrote), /^工具结果：Successfully wrote/)

  const files = await client.request<FileEntry[]>({ t: 'files.list', treeId: tree.id })
  assert.deepEqual(files.map((f) => [f.path, f.size, f.readOnly]), [[`${dir}/notes/a.md`, 15, false]])
  assert.deepEqual(await client.request({ t: 'files.preview', treeId: tree.id, path: 'notes/a.md' }), { text: '# 标题\n正文', size: 15, truncated: false, binary: false })
  const read = await client.request<{ name: string; base64: string }>({ t: 'files.read', treeId: tree.id, path: `${dir}/notes/a.md` })
  assert.equal(Buffer.from(read.base64, 'base64').toString(), '# 标题\n正文')
  await assert.rejects(client.request({ t: 'files.read', treeId: tree.id, path: '../other/x' }), /只能查看/)
  await client.request({ t: 'files.delete', treeId: tree.id, path: 'notes/a.md' })
  assert.deepEqual(await client.request({ t: 'files.list', treeId: tree.id }), [])

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const up = await client.request<UploadedFile>({ t: 'upload', name: 'dot.png', base64: png.toString('base64') })
  assert.equal(up.mimeType, 'image/png')
  assert.ok((await client.request<UploadedFile[]>({ t: 'uploads' })).some((u) => u.id === up.id))
  await client.request({ t: 'send', treeId: tree.id, text: '看图', requestId: 'r2', attachments: [up.id] })
  const user = await client.until(() => client.views.get(tree.id)?.entries.filter((e) => e.kind === 'pi.user')[1], 15_000, 'second message')
  const blocks = user.model![0]!.content as { type: string; text?: string }[]
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'text', 'image'])
  assert.equal(blocks[1]!.text, `<attachments>\n${dir}/attachments/dot.png\n</attachments>`)
  const listed = await client.request<FileEntry[]>({ t: 'files.list', treeId: tree.id })
  assert.deepEqual(listed.map((f) => [f.path, f.size]), [[`${dir}/attachments/dot.png`, png.length]])

  await client.request({ t: 'tree.delete', treeId: tree.id })
  await assert.rejects(client.request({ t: 'files.list', treeId: tree.id }), /会话不存在/)
}

const DOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Stands in for DeepSeek's tools API and an image endpoint; records the key each request carried. */
export async function fakeUpstream() {
  const keys: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c))
    req.on('end', () => {
      keys.push(req.headers.authorization?.replace(/^Bearer /, '') ?? '')
      const json = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v))
      const { query } = JSON.parse(body || '{}') as { query?: string }
      if (req.url === '/v1/tools/search') json({ results: [{ title: `关于 ${query}`, url: 'https://example.com/pi?utm_source=x#:~:text=pi', summary: '摘要', site_name: 'Example' }] })
      else if (req.url === '/v1/tools/fetch') json({ title: 'Example', content: '正文内容' })
      else if (req.url === '/v1/images/generations') json({ data: [{ b64_json: DOT_PNG, revised_prompt: '一个点' }] })
      else res.writeHead(404).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, keys, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

/** The host's plugin defaults the scenario expects: DEEPSEEK_API_KEY and PROVIDER_* pointing at `fakeUpstream`. */
export const pluginEnv = (upstream: string) => ({
  DEEPSEEK_API_KEY: 'server-key',
  DEEPSEEK_BASE_URL: upstream,
  PROVIDER_BASE_URL: upstream,
  PROVIDER_AUTH_TOKEN: 'image-key',
  TOKEN_ENCRYPTION_KEY: 'test-encryption-key',
})

/**
 * Plugins (R33), shared by both hosts: a disabled plugin's tools are missing, enabling web search works with the
 * server's key and then with the user's own sealed key, and a generated image lands in the workspace.
 */
export async function pluginScenario(client: Client, upstream: { keys: string[] }) {
  const plugin = (id: string) => client.plugins.find((p) => p.id === id)
  const web = await client.until(() => plugin('web'), 10_000, 'plugin list')
  assert.deepEqual([web.enabled, web.available, web.issue, web.config.serverKeys], [false, true, null, ['deepseekKey']])

  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  const results = () => client.views.get(tree.id)?.entries.filter((e) => e.kind === 'pi.tool-result') ?? []
  const answers = () => client.views.get(tree.id)?.entries.filter((e) => e.kind === 'pi.assistant' && textOf(e)) ?? []
  const ask = async (text: string, n: number) => {
    await client.request({ t: 'send', treeId: tree.id, text, requestId: `r${n}` })
    await client.until(() => answers()[n - 1], 15_000, `answer ${n}`)
    return results().at(-1)!
  }

  const off = await ask('[工具 web_search] {"query":"pi"}', 1)
  assert.equal(off.model![0]!.isError, true, 'a disabled plugin has no tools')

  await client.request({ t: 'plugin.set', pluginId: 'web', enabled: true })
  await client.until(() => plugin('web')?.enabled, 5_000, 'web enabled')
  const found = await ask('[工具 web_search] {"query":"pi"}', 2)
  assert.match(textOf(found), /关于 pi\nhttps:\/\/example.com\/pi\n摘要/)
  assert.deepEqual((found.model![0]!.details as { sources: unknown }).sources, [{ url: 'https://example.com/pi', title: '关于 pi', site: 'Example' }])
  assert.equal(upstream.keys.at(-1), 'server-key')

  await assert.rejects(client.request({ t: 'plugin.set', pluginId: 'image', values: { baseUrl: 'ftp://x' } }), /无效/)
  await client.request({ t: 'plugin.set', pluginId: 'web', secrets: { deepseekKey: 'user-key' } })
  await client.until(() => plugin('web')?.config.secretsSet.includes('deepseekKey'), 5_000, 'secret saved')
  assert.ok(!JSON.stringify(client.plugins).includes('user-key'), 'secrets never reach the browser')
  await ask('[工具 web_fetch] {"url":"https://example.com/pi"}', 3)
  assert.equal(upstream.keys.at(-1), 'user-key')

  await client.request({ t: 'plugin.set', pluginId: 'image', enabled: true })
  const image = await ask('[工具 image_generate] {"prompt":"一个点"}', 4)
  const details = image.model![0]!.details as { images: { path: string; mediaType: string }[]; revisedPrompt: string }
  assert.equal(details.revisedPrompt, '一个点')
  assert.equal(details.images[0]!.mediaType, 'image/png')
  assert.match(details.images[0]!.path, new RegExp(`^/data/sessions/${tree.id}/images/.+\\.png$`))
  const read = await client.request<{ base64: string }>({ t: 'files.read', treeId: tree.id, path: details.images[0]!.path })
  assert.equal(read.base64, DOT_PNG)
  assert.equal(upstream.keys.at(-1), 'image-key')

  // Artifacts: the model shows one, the view saves it into the workspace; saving the same content again reuses the file.
  const artifact = { title: '提纲', type: 'markdown', content: '# 提纲' }
  await assert.rejects(client.request({ t: 'tool.call', treeId: tree.id, name: 'artifact_save', args: artifact }), /已关闭/)
  await client.request({ t: 'plugin.set', pluginId: 'artifact', enabled: true })
  const shown = await ask(`[工具 artifact_create] ${JSON.stringify(artifact)}`, 5)
  assert.deepEqual(shown.model![0]!.details, artifact)
  const saved = await client.request<{ structuredContent: { path: string } }>({ t: 'tool.call', treeId: tree.id, name: 'artifact_save', args: artifact })
  assert.equal(saved.structuredContent.path, `/data/sessions/${tree.id}/artifacts/提纲.md`)
  const again = await client.request<{ structuredContent: { path: string } }>({ t: 'tool.call', treeId: tree.id, name: 'artifact_save', args: artifact })
  assert.equal(again.structuredContent.path, saved.structuredContent.path)
  const other = await client.request<{ structuredContent: { path: string } }>({ t: 'tool.call', treeId: tree.id, name: 'artifact_save', args: { ...artifact, content: '# 第二版' } })
  assert.equal(other.structuredContent.path, `/data/sessions/${tree.id}/artifacts/提纲 (2).md`)
  await assert.rejects(client.request({ t: 'tool.call', treeId: tree.id, name: 'write', args: {} }), /不能调用/)

  // Generative UI: a valid tree is shown as is, an invalid one is refused before the tool runs.
  await client.request({ t: 'plugin.set', pluginId: 'ui', enabled: true })
  const ui = { title: '对比', blocks: [{ type: 'stat', label: '价格', value: '¥5' }] }
  const rendered = await ask(`[工具 ui_render] ${JSON.stringify(ui)}`, 6)
  assert.deepEqual(rendered.model![0]!.details, ui)
  const bad = await ask('[工具 ui_render] {"blocks":[{"type":"video"}]}', 7)
  assert.equal(bad.model![0]!.isError, true)

  await client.request({ t: 'plugin.set', pluginId: 'web', enabled: false })
  await client.until(() => plugin('web')?.enabled === false, 5_000, 'web disabled')
  await client.request({ t: 'tree.delete', treeId: tree.id })
}
