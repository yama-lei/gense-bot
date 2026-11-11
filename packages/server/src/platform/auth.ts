// Email accounts and sessions (ADR-0006).
import { applySqliteMigrations, type SqliteDatabase } from '@earendil-works/chord/sqlite'
import type { UserInfo } from '@gense/protocol'

const ITERATIONS = 600_000
const SESSION_MS = 30 * 24 * 3600_000
/** Failed logins allowed within LOCK_MS. */
const MAX_FAILURES = 5
const LOCK_MS = 15 * 60_000
export const MIN_PASSWORD = 8

const migrations = [{ version: 1, statements: [
  'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL)',
  'CREATE TABLE sessions (tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL)',
  'CREATE INDEX sessions_user ON sessions(userId)',
  'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
] }]

type UserRow = Omit<UserInfo, 'disabled'> & { disabled: number; password: string }
const columns = 'id, email, role, disabled, createdAt'
const info = (r: Omit<UserRow, 'password'>): UserInfo => ({ id: r.id, email: r.email, role: r.role, disabled: !!r.disabled, createdAt: r.createdAt })
const emailOf = (email: string) => email.trim().toLowerCase()

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256)
  return new Uint8Array(bits)
}

async function hashPassword(password: string) {
  const salt = random(16)
  return `pbkdf2-sha256$${ITERATIONS}$${b64url(salt)}$${b64url(await derive(password, salt, ITERATIONS))}`
}

async function verifyPassword(password: string, stored: string) {
  const [scheme, iterations, salt, hash] = stored.split('$')
  if (scheme !== 'pbkdf2-sha256' || !iterations || !salt || !hash) return false
  const actual = await derive(password, unb64url(salt), Number(iterations))
  const expected = unb64url(hash)
  let diff = actual.length ^ expected.length
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ (expected[i] ?? 0)
  return diff === 0
}

const sha256 = async (s: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))

/** Accounts and hashed session tokens in app.sqlite. Space data never lives here. */
export class Auth {
  readonly #db: SqliteDatabase
  readonly #now: () => number
  readonly #failures = new Map<string, { count: number; since: number }>()
  private constructor(db: SqliteDatabase, now: () => number) { this.#db = db; this.#now = now }
  static async open(db: SqliteDatabase, now = Date.now) {
    await applySqliteMigrations(db, migrations, { table: 'auth_migrations' })
    return new Auth(db, now)
  }
  async registrationOpen() {
    return (await this.#db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'registration'"))?.value !== 'closed'
  }
  async setRegistration(open: boolean) {
    await this.#db.run("INSERT INTO settings VALUES ('registration', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", open ? 'open' : 'closed')
  }
  async users(): Promise<UserInfo[]> {
    return (await this.#db.all<UserRow>(`SELECT ${columns} FROM users ORDER BY createdAt, id`)).map(info)
  }
  async user(id: string): Promise<UserInfo | undefined> {
    const row = await this.#db.get<UserRow>(`SELECT ${columns} FROM users WHERE id = ?`, id)
    return row && info(row)
  }
  async find(email: string): Promise<UserInfo | undefined> {
    const row = await this.#db.get<UserRow>(`SELECT ${columns} FROM users WHERE email = ?`, emailOf(email))
    return row && info(row)
  }
  async register(email: string, password: string): Promise<UserInfo> {
    email = emailOf(email)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('邮箱无效')
    if (password.length < MIN_PASSWORD) throw new Error(`密码至少 ${MIN_PASSWORD} 位`)
    const hash = await hashPassword(password)
    return this.#db.transaction(async tx => {
      const setting = await tx.get<{ value: string }>("SELECT value FROM settings WHERE key = 'registration'")
      if (setting?.value === 'closed') throw new Error('暂不开放注册')
      if (await tx.get('SELECT 1 FROM users WHERE email = ?', email)) throw new Error('邮箱已注册')
      const first = !(await tx.get('SELECT 1 FROM users LIMIT 1'))
      const user: UserInfo = { id: crypto.randomUUID(), email, role: first ? 'admin' : 'user', disabled: false, createdAt: this.#now() }
      await tx.run('INSERT INTO users VALUES (?, ?, ?, ?, 0, ?)', user.id, email, hash, user.role, user.createdAt)
      return user
    })
  }
  async updateUser(id: string, patch: { disabled?: boolean; role?: 'admin' | 'user' }) {
    await this.#db.transaction(async tx => {
      const row = await tx.get<UserRow>(`SELECT ${columns} FROM users WHERE id = ?`, id)
      if (!row) throw new Error('用户不存在')
      const role = patch.role ?? row.role, disabled = patch.disabled === undefined ? row.disabled : Number(patch.disabled)
      if (row.role === 'admin' && !row.disabled && (role !== 'admin' || disabled)) {
        const others = await tx.get('SELECT 1 FROM users WHERE id != ? AND role = ? AND disabled = 0', id, 'admin')
        if (!others) throw new Error('至少保留一个启用的管理员')
      }
      await tx.run('UPDATE users SET role = ?, disabled = ? WHERE id = ?', role, disabled, id)
      if (disabled) await tx.run('DELETE FROM sessions WHERE userId = ?', id)
    })
    return (await this.user(id))!
  }
  async #issue(userId: string) {
    const token = b64url(random(32)), now = this.#now()
    await this.#db.run('DELETE FROM sessions WHERE expiresAt < ?', now)
    await this.#db.run('INSERT INTO sessions VALUES (?, ?, ?, ?)', await sha256(token), userId, now, now + SESSION_MS)
    return token
  }
  async login(email: string, password: string): Promise<string> {
    email = emailOf(email)
    const now = this.#now(), previous = this.#failures.get(email)
    const f = previous && now - previous.since < LOCK_MS ? previous : { count: 0, since: now }
    if (f.count >= MAX_FAILURES) throw new Error('尝试次数过多，请 15 分钟后再试')
    const row = await this.#db.get<UserRow>('SELECT * FROM users WHERE email = ?', email)
    // Derive even for unknown accounts, so account existence is not exposed by timing.
    const valid = await verifyPassword(password, row?.password ?? `pbkdf2-sha256$${ITERATIONS}$${b64url(new Uint8Array(16))}$${b64url(new Uint8Array(32))}`)
    if (!row || !valid || row.disabled) {
      this.#failures.set(email, { count: f.count + 1, since: f.since })
      throw new Error('邮箱或密码不对，或账号已停用')
    }
    this.#failures.delete(email)
    return this.#issue(row.id)
  }
  async changePassword(userId: string, current: string, next: string) {
    const user = await this.user(userId)
    if (!user || user.disabled) throw new Error('未登录')
    const check = await this.login(user.email, current)
    await this.logout(check)
    await this.setPassword(userId, next)
    return this.#issue(userId)
  }
  async setPassword(userId: string, next: string) {
    if (next.length < MIN_PASSWORD) throw new Error(`密码至少 ${MIN_PASSWORD} 位`)
    const hash = await hashPassword(next)
    await this.#db.transaction(async tx => {
      if (!(await tx.get('SELECT 1 FROM users WHERE id = ?', userId))) throw new Error('用户不存在')
      await tx.run('UPDATE users SET password = ? WHERE id = ?', hash, userId)
      await tx.run('DELETE FROM sessions WHERE userId = ?', userId)
    })
  }
  async session(token: string | undefined): Promise<UserInfo | undefined> {
    if (!token) return undefined
    const row = await this.#db.get<UserRow>(`SELECT ${columns.split(', ').map(c => `u.${c}`).join(', ')} FROM sessions s JOIN users u ON u.id = s.userId WHERE s.tokenHash = ? AND s.expiresAt > ? AND u.disabled = 0`, await sha256(token), this.#now())
    return row && info(row)
  }
  async logout(token: string) { await this.#db.run('DELETE FROM sessions WHERE tokenHash = ?', await sha256(token)) }
}

export const SESSION_COOKIE = 'gense_session'
export const SESSION_MAX_AGE_S = SESSION_MS / 1000
