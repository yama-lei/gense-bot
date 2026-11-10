// The owner's login (ADR-0005 decision 3): one password, set from the server's shell, and login sessions.
import { applySqliteMigrations, type SqliteDatabase } from '@earendil-works/chord/sqlite'

const ITERATIONS = 600_000
const SESSION_MS = 30 * 24 * 3600_000
/** Failed logins allowed within LOCK_MS. */
const MAX_FAILURES = 5
const LOCK_MS = 15 * 60_000
export const MIN_PASSWORD = 8

const migrations = [
  {
    version: 1,
    statements: [
      'CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK (id = 1), password TEXT NOT NULL, updatedAt INTEGER NOT NULL)',
      'CREATE TABLE sessions (tokenHash TEXT PRIMARY KEY, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL)',
    ],
  },
]

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

/** The owner's password and login sessions, in the app database. Only a hash of each session token is stored. */
export class Auth {
  #db: SqliteDatabase
  #failures = { count: 0, since: 0 }
  #now: () => number

  private constructor(db: SqliteDatabase, now: () => number) {
    this.#db = db
    this.#now = now
  }

  /** Adds its tables to `db`; the caller owns the database and closes it. */
  static async open(db: SqliteDatabase, now = Date.now) {
    await applySqliteMigrations(db, migrations, { table: 'auth_migrations' })
    return new Auth(db, now)
  }

  async hasPassword() {
    return !!(await this.#db.get('SELECT 1 FROM owner WHERE id = 1'))
  }

  /** Sets the password and ends every session. */
  async setPassword(password: string) {
    if (password.length < MIN_PASSWORD) throw new Error(`密码至少 ${MIN_PASSWORD} 位`)
    const hash = await hashPassword(password)
    await this.#db.transaction(async (tx) => {
      await tx.run('INSERT INTO owner (id, password, updatedAt) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET password = excluded.password, updatedAt = excluded.updatedAt', hash, this.#now())
      await tx.run('DELETE FROM sessions')
    })
  }

  /** Resolves to a session token, or rejects with a message for the user. */
  async login(password: string): Promise<string> {
    const now = this.#now()
    const f = now - this.#failures.since < LOCK_MS ? this.#failures : { count: 0, since: now }
    if (f.count >= MAX_FAILURES) throw new Error('尝试次数过多，请 15 分钟后再试')
    const row = await this.#db.get<{ password: string }>('SELECT password FROM owner WHERE id = 1')
    if (!row) throw new Error('还没有设置密码：在服务器上运行 npm run passwd')
    if (!(await verifyPassword(password, row.password))) {
      this.#failures = { count: f.count + 1, since: f.since }
      throw new Error('密码不对')
    }
    this.#failures = { count: 0, since: 0 }
    const token = b64url(random(32))
    await this.#db.run('DELETE FROM sessions WHERE expiresAt < ?', now)
    await this.#db.run('INSERT INTO sessions (tokenHash, createdAt, expiresAt) VALUES (?, ?, ?)', await sha256(token), now, now + SESSION_MS)
    return token
  }

  async changePassword(current: string, next: string) {
    const token = await this.login(current)
    await this.logout(token)
    await this.setPassword(next)
    return this.login(next)
  }

  /** Whether the token belongs to a live session. */
  async session(token: string | undefined): Promise<boolean> {
    if (!token) return false
    const row = await this.#db.get<{ expiresAt: number }>('SELECT expiresAt FROM sessions WHERE tokenHash = ?', await sha256(token))
    return !!row && row.expiresAt >= this.#now()
  }

  async logout(token: string) {
    await this.#db.run('DELETE FROM sessions WHERE tokenHash = ?', await sha256(token))
  }
}

export const SESSION_COOKIE = 'gense_session'
export const SESSION_MAX_AGE_S = SESSION_MS / 1000
