// Drives a real host over HTTP and WebSocket, as the browser does.
import { applyImmutable, decoder, type Decoder } from '@earendil-works/chord/delta'
import type { PluginState } from '@gense/core/catalog'
import { parseNote } from '@gense/core/notes'
import type { BranchesState, BranchMeta, ClientRequest, FileEntry, LoginPrompt, ModelInfo, ProviderState, ServerMessage, SkillInfo, TreeMeta, UploadedFile } from '@gense/core/protocol'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { docxFile, pdfFile } from '../../../packages/core/test/fixtures.ts'

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

type Entry = { id: number; kind: string; data?: unknown; model?: { role: string; content: unknown; stopReason?: string; isError?: boolean; details?: unknown }[] }
export type View = { entries: Entry[]; docs: Record<string, unknown> }

export const textOf = (e: Entry) => {
  const content = e.model?.[0]?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text : '')).join('') : ''
}

export const stopReason = (e: Entry) => e.model?.[0]?.stopReason

export class Client {
  readonly views = new Map<string, View>()
  /** Per watched tree, its branches and the one its view shows. */
  readonly branches = new Map<string, BranchesState>()
  readonly shown = new Map<string, string>()
  trees: TreeMeta[] = []
  plugins: PluginState[] = []
  skills: SkillInfo[] = []
  models: ModelInfo[] = []
  providers: ProviderState[] = []
  /** Login prompts the host is waiting on, by prompt id. */
  readonly prompts = new Map<string, { loginId: string; prompt: LoginPrompt }>()
  /** Every message received, as sent, to check what never reaches the browser. */
  readonly raw: string[] = []
  readonly #ws: WebSocket
  readonly #decoders = new Map<string, Decoder>()
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  readonly #waiters = new Set<() => void>()
  #next = 1

  private constructor(ws: WebSocket) {
    this.#ws = ws
    ws.on('message', (data) => {
      this.raw.push(String(data))
      this.#receive(JSON.parse(String(data)) as ServerMessage)
    })
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
    if (m.t === 'skills') this.skills = m.skills
    if (m.t === 'models') this.models = m.models
    if (m.t === 'providers') this.providers = m.providers
    if (m.t === 'auth.prompt') this.prompts.set(m.promptId, { loginId: m.loginId, prompt: m.prompt })
    if (m.t === 'auth.prompt.done') this.prompts.delete(m.promptId)
    if (m.t === 'branches') {
      const { t: _, treeId, ...state } = m
      this.branches.set(treeId, state)
    }
    if (m.t === 'view') {
      this.shown.set(m.treeId, m.branchId)
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

  const own = async () => (await client.request<FileEntry[]>({ t: 'files.list', treeId: tree.id })).filter((f) => !f.readOnly)
  assert.deepEqual((await own()).map((f) => [f.path, f.size, f.readOnly]), [[`${dir}/notes/a.md`, 15, false]])
  assert.deepEqual(await client.request({ t: 'files.preview', treeId: tree.id, path: 'notes/a.md' }), { text: '# 标题\n正文', size: 15, truncated: false, binary: false })
  const read = await client.request<{ name: string; base64: string }>({ t: 'files.read', treeId: tree.id, path: `${dir}/notes/a.md` })
  assert.equal(Buffer.from(read.base64, 'base64').toString(), '# 标题\n正文')
  await assert.rejects(client.request({ t: 'files.read', treeId: tree.id, path: '../other/x' }), /只能查看/)
  await client.request({ t: 'files.delete', treeId: tree.id, path: 'notes/a.md' })
  assert.deepEqual(await own(), [])

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const up = await client.request<UploadedFile>({ t: 'upload', name: 'dot.png', base64: png.toString('base64') })
  assert.equal(up.mimeType, 'image/png')
  assert.ok((await client.request<UploadedFile[]>({ t: 'uploads' })).some((u) => u.id === up.id))
  await client.request({ t: 'send', treeId: tree.id, text: '看图', requestId: 'r2', attachments: [up.id] })
  const user = await client.until(() => client.views.get(tree.id)?.entries.filter((e) => e.kind === 'pi.user')[1], 15_000, 'second message')
  const blocks = user.model![0]!.content as { type: string; text?: string }[]
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'text', 'image'])
  assert.equal(blocks[1]!.text, `<attachments>\n${dir}/attachments/dot.png\n</attachments>`)
  assert.deepEqual((await own()).map((f) => [f.path, f.size]), [[`${dir}/attachments/dot.png`, png.length]])

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

/** The system prompt sections in effect at the end of a view: `pi.system` entries replayed in order. */
export function sections(view: View | undefined) {
  const shown = new Map<string, string>()
  for (const e of view?.entries ?? []) {
    const m = e.model?.[0] as { role?: string; sections?: Record<string, string | null> } | undefined
    if (m?.role !== 'system' || !m.sections) continue
    for (const [k, v] of Object.entries(m.sections)) v === null ? shown.delete(k) : shown.set(k, v)
  }
  return shown
}

/**
 * Stage-3 Skills, `/` and `@` (R17–R19, R28, R29), shared by both hosts: shared Skills are written to /data/skills
 * and listed in the prompt, a switch removes one, a conversation's own Skill wins on a name clash, and a message's
 * command and mentions reach the model as note blocks the client parses back.
 */
export async function skillsScenario(client: Client) {
  const skills = await client.until(() => client.skills.length > 0 && client.skills, 10_000, 'skill list')
  assert.ok(skills.every((s) => s.source === 'builtin' && s.enabled))
  const name = skills[0]!.name

  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  const dir = `/data/sessions/${tree.id}`
  await client.request({ t: 'watch', treeId: tree.id })
  const answers = () => client.views.get(tree.id)?.entries.filter((e) => e.kind === 'pi.assistant' && textOf(e)) ?? []
  const ask = async (text: string, n: number, extra: object = {}) => {
    await client.request({ t: 'send', treeId: tree.id, text, requestId: `s${n}`, ...extra })
    return client.until(() => answers()[n - 1], 15_000, `answer ${n}`)
  }
  const prompt = () => sections(client.views.get(tree.id)).get('skills') ?? ''

  await ask('你好', 1)
  assert.match(prompt(), new RegExp(`- ${name}：.*（/data/skills/${name}/SKILL.md）`))
  const panel = await client.request<FileEntry[]>({ t: 'files.list', treeId: tree.id })
  assert.ok(panel.some((f) => f.path === `/data/skills/${name}/SKILL.md` && f.readOnly))

  await client.request({ t: 'skill.set', name, enabled: false })
  await client.until(() => client.skills.find((s) => s.name === name)?.enabled === false, 5_000, 'skill off')
  assert.ok(!(await client.request<FileEntry[]>({ t: 'files.list', treeId: tree.id })).some((f) => f.path.startsWith(`/data/skills/${name}/`)))
  await ask('再来', 2)
  assert.doesNotMatch(prompt(), new RegExp(`- ${name}：`))
  await assert.rejects(client.request({ t: 'skill.set', name: '不存在', enabled: true }), /未知 Skill/)

  // The conversation's own Skill of the same name replaces the shared one, switched back on.
  await client.request({ t: 'skill.set', name, enabled: true })
  const skillMd = `---\nname: ${name}\ndescription: 本会话的版本\n---\n\n正文`
  await ask(`[工具 write] ${JSON.stringify({ path: `skills/${name}/SKILL.md`, content: skillMd })}`, 3)
  await ask('看看', 4)
  assert.match(prompt(), new RegExp(`- ${name}：本会话的版本（${dir}/skills/${name}/SKILL.md）`))
  assert.equal(prompt().match(new RegExp(`- ${name}：`, 'g'))?.length, 1)

  // `/` and `@`: a plugin that is on and one that is off, a workspace file, and another conversation.
  await client.request({ t: 'plugin.set', pluginId: 'ui', enabled: true })
  await client.request({ t: 'plugin.set', pluginId: 'email', enabled: false })
  const other = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: other.id })
  await client.request({ t: 'send', treeId: other.id, text: '旧会话里的话', requestId: 'o1' })
  await client.until(() => client.views.get(other.id)?.entries.some((e) => e.kind === 'pi.assistant' && textOf(e)), 15_000, 'other answer')

  const command = { id: 'summarize', label: '总结会话', prompt: '用户要求总结会话。' }
  const mentions = [
    { kind: 'plugin', id: 'ui', label: '生成式界面' },
    { kind: 'plugin', id: 'email', label: '邮件' },
    { kind: 'workspace', id: `${dir}/skills/${name}/SKILL.md`, label: 'SKILL.md' },
    { kind: 'chat', id: other.id, label: '旧会话' },
  ] as const
  await ask('', 5, { command, mentions })
  const user = client.views.get(tree.id)!.entries.filter((e) => e.kind === 'pi.user')[4]!
  const blocks = (user.model![0]!.content as { type: string; text: string }[]).map((b) => b.text)
  assert.deepEqual(blocks.slice(1).map((b) => parseNote(b)), [
    { attachments: [], command: { id: command.id, label: command.label }, mentions: [] },
    { attachments: [], mentions: [...mentions] },
  ])
  assert.match(blocks[1]!, /用户要求总结会话。/)
  assert.match(blocks[2]!, /本轮优先使用这个插件的工具[\s\S]*没有开启[\s\S]*用 read 读取 [\s\S]*用户：旧会话里的话\n\n助手：收到：旧会话里的话/)
  assert.equal(client.trees.find((t) => t.id === tree.id)?.title, '你好')

  for (const id of [tree.id, other.id]) await client.request({ t: 'tree.delete', treeId: id })
  await client.request({ t: 'plugin.set', pluginId: 'ui', enabled: false })
}

/**
 * R62: a user's own model service. The API-key login runs on the host and asks for the key through the socket; the
 * service's models join the list, the key never comes back, and the host's own keys never count as the user's.
 */
export async function accountsScenario(client: Client, { oauth }: { oauth: boolean }) {
  const providers = await client.until(() => client.providers.length > 0 && client.providers, 10_000, 'providers')
  assert.ok(!providers.some((p) => p.id === 'relay' || p.id === 'faux' || p.configured))
  assert.equal(providers.some((p) => p.oauth), oauth)
  const host = await client.until(() => client.models.length > 0 && client.models, 10_000, 'models')
  // The host has DEEPSEEK_API_KEY for its web plugin; it must not make DeepSeek a model of the user's.
  assert.ok(host.every((m) => m.provider === 'faux'))

  const promptFor = (loginId: string) => client.until(() => [...client.prompts].find(([, p]) => p.loginId === loginId), 10_000, `prompt of ${loginId}`)
  const KEY = 'sk-user-secret-123'
  const login = client.request({ t: 'auth.login', loginId: 'l1', provider: 'mistral', type: 'api_key' })
  const [promptId, { prompt }] = await promptFor('l1')
  assert.equal(prompt.type, 'secret')
  await client.request({ t: 'auth.answer', promptId, value: KEY })
  await login
  await client.until(() => client.providers.find((p) => p.id === 'mistral')?.configured === 'api_key', 5_000, 'signed in')
  const models = await client.until(() => client.models.some((m) => m.provider === 'mistral') && client.models, 5_000, 'mistral models')
  assert.deepEqual(models.slice(0, host.length), host)
  assert.ok(!client.raw.some((m) => m.includes(KEY)))
  assert.equal(client.prompts.size, 0)

  // A model the user does not have is refused before the turn starts.
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await assert.rejects(client.request({ t: 'send', treeId: tree.id, text: '你好', requestId: 'm1', model: { provider: 'deepseek', id: 'deepseek-chat', name: 'x' } }), /这个模型不可用/)

  // Cancelling: by declining the prompt, and by cancelling the login.
  const declined = client.request({ t: 'auth.login', loginId: 'l2', provider: 'groq', type: 'api_key' })
  await client.request({ t: 'auth.answer', promptId: (await promptFor('l2'))[0] })
  await assert.rejects(declined, /已取消/)
  const cancelled = client.request({ t: 'auth.login', loginId: 'l3', provider: 'groq', type: 'api_key' })
  await promptFor('l3')
  await client.request({ t: 'auth.cancel', loginId: 'l3' })
  await assert.rejects(cancelled)
  await client.until(() => client.prompts.size === 0, 5_000, 'prompts done')
  assert.equal(client.providers.find((p) => p.id === 'groq')?.configured, null)
  if (!oauth) await assert.rejects(client.request({ t: 'auth.login', loginId: 'l4', provider: 'anthropic', type: 'oauth' }), /不支持/)

  await client.request({ t: 'auth.logout', provider: 'mistral' })
  await client.until(() => client.providers.find((p) => p.id === 'mistral')?.configured === null, 5_000, 'signed out')
  await client.until(() => client.models.length === host.length, 5_000, 'models back to the host')
  await client.request({ t: 'tree.delete', treeId: tree.id })
}

/** R9: an attached Word file and PDF are read as text, pages included, and the second read reuses the extracted text. */
export async function documentsScenario(client: Client) {
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  const answers = () => client.views.get(tree.id)?.entries.filter((e) => e.kind === 'pi.assistant' && textOf(e)) ?? []
  const files = [
    ['报告.docx', docxFile()],
    ['paper.pdf', pdfFile('Attention is all you need')],
  ] as const
  const ids = []
  for (const [name, bytes] of files) ids.push((await client.request<UploadedFile>({ t: 'upload', name, base64: Buffer.from(bytes).toString('base64') })).id)
  await client.request({ t: 'send', treeId: tree.id, text: '看看附件', requestId: 'd0', attachments: ids })
  await client.until(() => answers()[0], 15_000, 'first answer')

  const ask = async (n: number, path: string, extra = {}) => {
    await client.request({ t: 'send', treeId: tree.id, text: `[工具 read] ${JSON.stringify({ path, ...extra })}`, requestId: `d${n}` })
    return textOf(await client.until(() => answers()[n], 30_000, `read ${path}`))
  }
  assert.equal(await ask(1, 'attachments/报告.docx'), '工具结果：第一段 & 续\n甲\t乙\n最后')
  assert.equal(await ask(2, 'attachments/报告.docx', { offset: 3 }), '工具结果：最后')
  assert.equal(await ask(3, 'attachments/paper.pdf'), '工具结果：## 第 1 页\nAttention is all you need')
  // The cache is outside the tree's workspace, so the file panel does not show it.
  const listed = await client.request<FileEntry[]>({ t: 'files.list', treeId: tree.id })
  assert.ok(!listed.some((f) => f.path.includes('.cache')))
  await client.request({ t: 'tree.delete', treeId: tree.id })
}

/**
 * Stage-4 tree sessions, shared by both hosts (R35–R37, R41): an edit and a regeneration become sibling versions of a
 * message, a fork continues from an answer, the shown branch switches, and the sidebar still lists one conversation.
 */
export async function branchesScenario(client: Client) {
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  const answers = (n: number) => client.until(() => (client.views.get(tree.id)?.entries.filter((e) => e.kind === 'pi.assistant').length ?? 0) >= n && client.views.get(tree.id), 15_000, `${n} answers`)
  const idle = (branchId: string) => client.until(() => client.branches.get(tree.id)?.branches.find((b) => b.id === branchId)?.status === 'idle', 15_000, 'idle branch')
  const { branchId: main } = await client.request<{ branchId: string }>({ t: 'send', treeId: tree.id, text: '甲', requestId: 'b1' })
  await answers(1)
  await idle(main)
  await client.request({ t: 'send', treeId: tree.id, text: '乙', requestId: 'b2' })
  const view = await answers(2)
  const [, second] = view.entries.filter((e) => e.kind === 'pi.user')
  const firstAnswer = view.entries.find((e) => e.kind === 'pi.assistant')!
  await idle(main)

  // Edit 乙: a new branch, which the client then shows.
  const edit = await client.request<{ branchId: string }>({ t: 'send', treeId: tree.id, branchId: main, replace: second!.id, text: '乙二', requestId: 'b3' })
  await client.request({ t: 'watch', treeId: tree.id, branchId: edit.branchId })
  await client.until(() => client.shown.get(tree.id) === edit.branchId, 5000, 'edit shown')
  const edited = await client.until(() => client.views.get(tree.id)?.entries.findLast((e) => e.kind === 'pi.assistant' && textOf(e) === '收到：乙二'), 15_000, 'edited answer')
  assert.ok(edited)
  assert.deepEqual(client.views.get(tree.id)!.entries.filter((e) => e.kind === 'pi.user').map(textOf), ['甲', '乙二'])

  // Regenerate 乙 from the main branch: a third version.
  const again = await client.request<BranchMeta>({ t: 'regenerate', treeId: tree.id, branchId: main, entryId: second!.id, requestId: 'b4' })
  // Versions of 乙 are keyed by the entry before it, the first answer.
  const key = String(firstAnswer.id)
  const versions = await client.until(() => client.branches.get(tree.id)?.versions[key]?.length === 3 && client.branches.get(tree.id)!.versions[key], 15_000, 'three versions')
  assert.deepEqual(versions, [main, edit.branchId, again.id])
  await idle(again.id)

  // Fork after the first answer, and go back to the main line (R41).
  const fork = await client.request<BranchMeta>({ t: 'branch.fork', treeId: tree.id, branchId: main, at: firstAnswer.id })
  assert.equal(fork.parentId, main)
  await client.request({ t: 'watch', treeId: tree.id, branchId: fork.id })
  await client.until(() => client.shown.get(tree.id) === fork.id && client.views.get(tree.id)!.entries.filter((e) => e.kind === 'pi.user').length === 1, 5000, 'fork shown')
  await client.request({ t: 'watch', treeId: tree.id, branchId: main })
  await client.until(() => client.shown.get(tree.id) === main && client.branches.get(tree.id)!.activeBranchId === main, 5000, 'main shown')
  assert.deepEqual(client.views.get(tree.id)!.entries.filter((e) => e.kind === 'pi.user').map(textOf), ['甲', '乙'])

  const state = client.branches.get(tree.id)!
  assert.equal(state.branches.length, 4)
  assert.equal(client.trees.filter((t) => t.id === tree.id).length, 1)
  assert.equal(client.trees.find((t) => t.id === tree.id)!.title, '甲')
  await client.request({ t: 'tree.delete', treeId: tree.id })
}

/** R42–R45 through the socket: two branches of a tree share a file, each changing it only as it last read it. */
export async function ledgerScenario(client: Client) {
  const tree = await client.request<TreeMeta>({ t: 'tree.create' })
  await client.request({ t: 'watch', treeId: tree.id })
  let n = 0
  const tool = async (branchId: string, name: string, args: object) => {
    const requestId = `l${++n}`
    await client.request({ t: 'watch', treeId: tree.id, branchId })
    await client.until(() => client.shown.get(tree.id) === branchId, 5000, 'branch shown')
    const answers = () => client.views.get(tree.id)?.entries.filter((e) => e.kind === 'pi.assistant' && textOf(e)) ?? []
    const before = answers().length
    await client.request({ t: 'send', treeId: tree.id, branchId, text: `[工具 ${name}] ${JSON.stringify(args)}`, requestId })
    const answer = await client.until(
      () => answers().length > before && client.branches.get(tree.id)?.branches.find((b) => b.id === branchId)?.status === 'idle' && answers().at(-1),
      15_000,
      `${name} answer`,
    )
    return textOf(answer)
  }
  const { branchId: main } = await client.request<{ branchId: string }>({ t: 'send', treeId: tree.id, text: '开始', requestId: 'l0' })
  await client.until(() => client.branches.get(tree.id)?.branches.find((b) => b.id === main)?.status === 'idle' && client.views.get(tree.id)?.entries.some((e) => e.kind === 'pi.assistant'), 15_000, 'first answer')
  const at = client.views.get(tree.id)!.entries.findLast((e) => e.kind === 'pi.assistant')!.id
  const fork = await client.request<BranchMeta>({ t: 'branch.fork', treeId: tree.id, branchId: main, at })

  assert.match(await tool(main, 'write', { path: 'f.txt', content: 'one' }), /Successfully wrote/)
  // R42: the fork sees the file; R43: it must read it first.
  assert.match(await tool(fork.id, 'write', { path: 'f.txt', content: 'two' }), /请先用 read/)
  assert.match(await tool(fork.id, 'read', { path: 'f.txt' }), /one/)
  assert.match(await tool(fork.id, 'write', { path: 'f.txt', content: 'two' }), /Successfully wrote/)
  // R44: the main branch read nothing since its write, and the file changed.
  assert.match(await tool(main, 'edit', { path: 'f.txt', edits: [{ oldText: 'two', newText: 'three' }] }), /被修改/)
  // R45: no way out of the tree.
  assert.match(await tool(main, 'read', { path: '/data/uploads' }), /只能读取本会话工作区/)
  await client.request({ t: 'tree.delete', treeId: tree.id })
}
