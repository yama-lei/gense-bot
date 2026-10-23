// Email and password login (roadmap-3 D1). Uses only WebCrypto and the portable SQLite facade, so both hosts share it.
import { applySqliteMigrations, type SqliteDatabase } from '@earendil-works/chord/sqlite'

export interface User {
  id: string
  email: string
}

/** Workers caps PBKDF2 at 100,000 iterations; both hosts use the same count so a user table can move between them. */
const ITERATIONS = 100_000
const SESSION_MS = 30 * 24 * 3600_000
/** Failed logins allowed per email within LOCK_MS. */
const MAX_FAILURES = 5
const LOCK_MS = 15 * 60_000

const migrations = [
  {
    version: 1,
    statements: [
      'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, createdAt INTEGER NOT NULL)',
      'CREATE TABLE sessions (tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL)',
      'CREATE INDEX sessions_user ON sessions (userId)',
    ],
  },
]

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const normalize = (email: string) => email.trim().toLowerCase()

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

/** Users and login sessions in the host's app database. Only a hash of each session token is stored. */
export class Auth {
  #db: SqliteDatabase
  #failures = new Map<string, { count: number; since: number }>()
  #now: () => number

  private constructor(db: SqliteDatabase, now: () => number) {
    this.#db = db
    this.#now = now
  }

  static async open(db: SqliteDatabase, now = Date.now) {
    await applySqliteMigrations(db, migrations, { table: 'auth_migrations' })
    return new Auth(db, now)
  }

  async createUser(email: string, password: string): Promise<User> {
    email = normalize(email)
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('邮箱格式不对')
    if (password.length < 8) throw new Error('密码至少 8 位')
    if (await this.#db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new Error('这个邮箱已经有账号')
    const user = { id: crypto.randomUUID(), email }
    await this.#db.run('INSERT INTO users (id, email, password, createdAt) VALUES (?, ?, ?, ?)', user.id, email, await hashPassword(password), this.#now())
    return user
  }

  async setPassword(email: string, password: string) {
    if (password.length < 8) throw new Error('密码至少 8 位')
    const user = await this.#db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', normalize(email))
    if (!user) throw new Error('没有这个账号')
    await this.#db.run('UPDATE users SET password = ? WHERE id = ?', await hashPassword(password), user.id)
    await this.#db.run('DELETE FROM sessions WHERE userId = ?', user.id)
  }

  /** Resolves to a session token, or rejects with a message for the user. */
  async login(email: string, password: string): Promise<{ token: string; user: User }> {
    email = normalize(email)
    const now = this.#now()
    const failures = this.#failures.get(email)
    if (failures && now - failures.since < LOCK_MS && failures.count >= MAX_FAILURES) throw new Error('尝试次数过多，请 15 分钟后再试')
    const row = await this.#db.get<{ id: string; password: string }>('SELECT id, password FROM users WHERE email = ?', email)
    // Hash even for unknown emails so response time does not reveal which accounts exist.
    const ok = row ? await verifyPassword(password, row.password) : (await hashPassword(password), false)
    if (!row || !ok) {
      const f = failures && now - failures.since < LOCK_MS ? failures : { count: 0, since: now }
      this.#failures.set(email, { count: f.count + 1, since: f.since })
      throw new Error('邮箱或密码不对')
    }
    this.#failures.delete(email)
    const token = b64url(random(32))
    await this.#db.run('INSERT INTO sessions (tokenHash, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)', await sha256(token), row.id, now, now + SESSION_MS)
    return { token, user: { id: row.id, email } }
  }

  async session(token: string | undefined): Promise<User | null> {
    if (!token) return null
    const row = await this.#db.get<{ id: string; email: string; expiresAt: number }>(
      'SELECT users.id AS id, users.email AS email, sessions.expiresAt AS expiresAt FROM sessions JOIN users ON users.id = sessions.userId WHERE sessions.tokenHash = ?',
      await sha256(token),
    )
    if (!row || row.expiresAt < this.#now()) return null
    return { id: row.id, email: row.email }
  }

  async logout(token: string) {
    await this.#db.run('DELETE FROM sessions WHERE tokenHash = ?', await sha256(token))
  }

  async users(): Promise<User[]> {
    return this.#db.all<User>('SELECT id, email FROM users ORDER BY createdAt')
  }

  async close() {
    await this.#db.close()
  }
}

export const SESSION_COOKIE = 'gense_session'
export const SESSION_MAX_AGE_S = SESSION_MS / 1000
