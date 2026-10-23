// The account endpoints, on web-standard Request and Response so both hosts serve them the same way.
import { SESSION_COOKIE, SESSION_MAX_AGE_S, type Auth, type User } from './auth.ts'

const MAX_BODY = 64 * 1024

export const parseCookies = (header: string | null | undefined) =>
  Object.fromEntries(
    (header ?? '').split(';').flatMap((part) => {
      const i = part.indexOf('=')
      return i < 0 ? [] : [[part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())]]
    }),
  ) as Record<string, string>

/** Browsers send Origin on WebSocket and fetch POSTs; it must match the host the page came from. */
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === (request.headers.get('host') ?? new URL(request.url).host)
  } catch {
    return false
  }
}

const isHttps = (request: Request) => request.headers.get('x-forwarded-proto') === 'https' || new URL(request.url).protocol === 'https:'

const sessionCookie = (request: Request, token: string, maxAge: number) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(request) ? '; Secure' : ''}`

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.length > MAX_BODY) throw new Error('请求太大')
  const value = JSON.parse(text || '{}')
  return value && typeof value === 'object' ? value : {}
}

/** Constant-time comparison of two secrets. */
function equal(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** The user of the request's session cookie, if it is valid. */
export async function sessionUser(auth: Auth, request: Request): Promise<User | undefined> {
  return (await auth.session(parseCookies(request.headers.get('cookie'))[SESSION_COOKIE])) ?? undefined
}

export interface AccountApiOptions {
  /** Enables `POST /api/admin/users` with `Authorization: Bearer <adminToken>`; hosts without a shell use it to add users. */
  adminToken?: string
}

/** Handles `/api/login`, `/api/logout`, `/api/me` and the admin endpoint; other paths get 404. */
export async function accountApi(auth: Auth, request: Request, options: AccountApiOptions = {}): Promise<Response> {
  const path = new URL(request.url).pathname
  if (request.method === 'POST' && !sameOrigin(request)) return json(403, { error: '来源不匹配' })
  try {
    if (path === '/api/login' && request.method === 'POST') {
      const body = await readJson(request)
      try {
        const { token, user } = await auth.login(String(body.email ?? ''), String(body.password ?? ''))
        return json(200, { email: user.email }, { 'set-cookie': sessionCookie(request, token, SESSION_MAX_AGE_S) })
      } catch (error) {
        return json(401, { error: error instanceof Error ? error.message : '登录失败' })
      }
    }
    if (path === '/api/logout' && request.method === 'POST') {
      const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE]
      if (token) await auth.logout(token)
      return json(200, {}, { 'set-cookie': sessionCookie(request, '', 0) })
    }
    if (path === '/api/me' && request.method === 'GET') {
      const user = await sessionUser(auth, request)
      return user ? json(200, { email: user.email }) : json(401, { error: '未登录' })
    }
    if (path === '/api/admin/users' && request.method === 'POST' && options.adminToken) {
      const given = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
      if (!equal(given, options.adminToken)) return json(401, { error: 'unauthorized' })
      const body = await readJson(request)
      const email = String(body.email ?? '')
      const password = String(body.password ?? '')
      const existing = (await auth.users()).find((u) => u.email === email.trim().toLowerCase())
      if (existing) await auth.setPassword(email, password)
      else await auth.createUser(email, password)
      return json(200, { email, created: !existing })
    }
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : String(error) })
  }
  return json(404, { error: 'not found' })
}
