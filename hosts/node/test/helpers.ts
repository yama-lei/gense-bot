// Drives a real host over HTTP and WebSocket, as the browser does.
import { applyImmutable, decoder, type Decoder } from '@earendil-works/chord/delta'
import type { ClientRequest, FileEntry, ServerMessage, TreeMeta, UploadedFile } from '@gense/core/protocol'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
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

type Entry = { kind: string; data?: unknown; model?: { role: string; content: unknown; stopReason?: string }[] }
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
