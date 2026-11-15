// Roadmap-7 B1–B4: opaque, validated public snapshots in app.sqlite. Tree ownership stays in UserSpace.
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { SHARE_LIMITS, type ShareInfo, type SharedPage, type ShareSnapshot } from '@gense/protocol'
import { randomBytes } from 'node:crypto'
import { Type } from 'typebox'
import { Value } from 'typebox/value'

const object = { additionalProperties: false } as const
const snapshotSchema = Type.Object({
  title: Type.String(),
  turns: Type.Array(Type.Object({
    question: Type.String(),
    answer: Type.Array(Type.Union([
      Type.Object({ kind: Type.Literal('text'), text: Type.String() }, object),
      Type.Object({ kind: Type.Literal('view'), uri: Type.String(), input: Type.Unknown(), result: Type.Optional(Type.Object({ content: Type.String(), structuredContent: Type.Optional(Type.Unknown()) }, object)) }, object),
      Type.Object({ kind: Type.Literal('image'), src: Type.String(), alt: Type.String() }, object),
    ])),
    sources: Type.Optional(Type.Array(Type.Object({ url: Type.String(), title: Type.String() }, object))),
    createdAt: Type.Number(),
  }, object)),
}, object)
const imageSource = /^data:image\/(png|jpeg|webp|gif);base64,/
type ShareRow = ShareInfo & { userId: string; snapshot: string }
const columns = 'token, treeId, title, turns, createdAt, updatedAt'
const TOKEN = /^[a-zA-Z0-9_-]{22}$/

function snapshot(input: unknown) {
  let serialized: string | undefined
  try { serialized = JSON.stringify(input) } catch { throw new Error('分享快照必须是 JSON') }
  if (serialized === undefined) throw new Error('分享快照格式无效')
  if (Buffer.byteLength(serialized) > SHARE_LIMITS.bytes) throw new Error('分享快照超过 8 MB 上限')
  // Validate what will actually be stored, including required unknown-valued fields lost by JSON serialization.
  const value: unknown = JSON.parse(serialized)
  if (!Value.Check(snapshotSchema, value)) throw new Error('分享快照格式无效')
  if (value.turns.length > SHARE_LIMITS.turns) throw new Error('分享快照超过 500 轮上限')
  for (const turn of value.turns) for (const block of turn.answer)
    if (block.kind === 'image' && !imageSource.test(block.src)) throw new Error('分享图片必须是 PNG、JPEG、WebP 或 GIF 的 base64 data URL')
  const saved: ShareSnapshot = { ...value, title: value.title.slice(0, SHARE_LIMITS.title) }
  return { title: saved.title, turns: saved.turns.length, json: JSON.stringify(saved) }
}

export class ShareStore {
  readonly #db: SqliteDatabase
  readonly #queues = new Map<string, Promise<unknown>>()
  readonly #listeners = new Map<string, Set<(shares: ShareInfo[]) => void>>()
  private constructor(db: SqliteDatabase) { this.#db = db }

  static async open(db: SqliteDatabase) {
    // An independent module schema keeps share storage separate from provider and usage migrations.
    await db.run('CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, userId TEXT NOT NULL, treeId TEXT NOT NULL, title TEXT NOT NULL, snapshot TEXT NOT NULL, turns INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)')
    await db.run('CREATE INDEX IF NOT EXISTS shares_user ON shares (userId, updatedAt DESC)')
    await db.run('CREATE INDEX IF NOT EXISTS shares_tree ON shares (userId, treeId)')
    return new ShareStore(db)
  }

  forUser(userId: string, checkTree: (treeId: string) => Promise<{ id: string; expiresAt?: number | null }>, now = Date.now) {
    return new UserShares(this, userId, checkTree, now)
  }

  async page(token: string): Promise<SharedPage | undefined> {
    if (!TOKEN.test(token)) return undefined
    const row = await this.#db.get<Pick<ShareRow, 'snapshot' | 'updatedAt'>>('SELECT snapshot, updatedAt FROM shares WHERE token = ?', token)
    return row ? { ...JSON.parse(row.snapshot) as ShareSnapshot, updatedAt: row.updatedAt } : undefined
  }

  list(userId: string): Promise<ShareInfo[]> {
    return this.#db.all<ShareInfo>(`SELECT ${columns} FROM shares WHERE userId = ? ORDER BY updatedAt DESC, rowid DESC`, userId)
  }
  async owned(userId: string, token: string): Promise<ShareInfo> {
    const row = typeof token === 'string' && await this.#db.get<ShareInfo>(`SELECT ${columns} FROM shares WHERE userId = ? AND token = ?`, userId, token)
    if (!row) throw new Error('分享链接不存在')
    return row
  }
  subscribe(userId: string, listener: (shares: ShareInfo[]) => void) {
    const listeners = this.#listeners.get(userId) ?? new Set()
    this.#listeners.set(userId, listeners); listeners.add(listener)
    return () => { listeners.delete(listener); if (!listeners.size) this.#listeners.delete(userId) }
  }
  async #changed(userId: string) { const shares = await this.list(userId); for (const listener of this.#listeners.get(userId) ?? []) listener(shares) }

  serial<T>(userId: string, change: () => Promise<T>): Promise<T> {
    const result = (this.#queues.get(userId) ?? Promise.resolve()).then(change)
    const tail = result.catch(() => {})
    this.#queues.set(userId, tail)
    void tail.then(() => { if (this.#queues.get(userId) === tail) this.#queues.delete(userId) })
    return result
  }

  async create(userId: string, treeId: string, input: ShareSnapshot, now: number): Promise<ShareInfo> {
    const saved = snapshot(input), token = randomBytes(16).toString('base64url')
    await this.#db.run('INSERT INTO shares (token, userId, treeId, title, snapshot, turns, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', token, userId, treeId, saved.title, saved.json, saved.turns, now, now)
    await this.#changed(userId)
    return { token, treeId, title: saved.title, turns: saved.turns, createdAt: now, updatedAt: now }
  }
  async update(userId: string, previous: ShareInfo, input: ShareSnapshot, now: number): Promise<ShareInfo> {
    const saved = snapshot(input)
    await this.#db.run('UPDATE shares SET title = ?, snapshot = ?, turns = ?, updatedAt = ? WHERE userId = ? AND token = ?', saved.title, saved.json, saved.turns, now, userId, previous.token)
    await this.#changed(userId)
    return { ...previous, title: saved.title, turns: saved.turns, updatedAt: now }
  }
  async remove(userId: string, token: string) {
    await this.#db.run('DELETE FROM shares WHERE userId = ? AND token = ?', userId, token)
    await this.#changed(userId)
  }
  async removeTree(userId: string, treeId: string) {
    await this.#db.run('DELETE FROM shares WHERE userId = ? AND treeId = ?', userId, treeId)
    await this.#changed(userId)
  }
  async flush() { await Promise.all(this.#queues.values()) }
}

/** All mutations, including deleting a tree, validate ownership while holding the same per-user queue. */
export class UserShares {
  readonly #store: ShareStore
  readonly #userId: string
  readonly #checkTree: (id: string) => Promise<{ id: string; expiresAt?: number | null }>
  readonly #now: () => number
  constructor(store: ShareStore, userId: string, checkTree: (id: string) => Promise<{ id: string; expiresAt?: number | null }>, now: () => number) {
    this.#store = store; this.#userId = userId; this.#checkTree = checkTree; this.#now = now
  }
  list() { return this.#store.list(this.#userId) }
  subscribe(listener: (shares: ShareInfo[]) => void) { return this.#store.subscribe(this.#userId, listener) }
  async #shareable(treeId: string) {
    const tree = await this.#checkTree(treeId)
    if (tree.expiresAt != null) throw new Error('临时对话不能分享')
  }
  create(treeId: string, input: ShareSnapshot) {
    return this.#store.serial(this.#userId, async () => { await this.#shareable(treeId); return this.#store.create(this.#userId, treeId, input, this.#now()) })
  }
  update(token: string, input: ShareSnapshot) {
    return this.#store.serial(this.#userId, async () => { const previous = await this.#store.owned(this.#userId, token); await this.#shareable(previous.treeId); return this.#store.update(this.#userId, previous, input, this.#now()) })
  }
  remove(token: string) {
    return this.#store.serial(this.#userId, async () => { await this.#store.owned(this.#userId, token); await this.#store.remove(this.#userId, token) })
  }
  flush() { return this.#store.serial(this.#userId, async () => {}) }
  deleteTree(treeId: string, remove: () => Promise<void>) {
    return this.#store.serial(this.#userId, async () => { await this.#checkTree(treeId); await this.#store.removeTree(this.#userId, treeId); await remove() })
  }
}

/** Fixed one-minute windows, bounded to active clients. Forwarded headers cannot spoof the socket's IP. */
export class ShareRateLimit {
  readonly #clients = new Map<string, { count: number; expiresAt: number }>()
  allow(ip: string, now = Date.now()) {
    for (const [key, value] of this.#clients) if (value.expiresAt <= now) this.#clients.delete(key)
    const current = this.#clients.get(ip) ?? { count: 0, expiresAt: now + 60_000 }
    this.#clients.set(ip, current)
    return ++current.count <= 60
  }
}
