// The login endpoints, on web-standard Request and Response.
import { SESSION_COOKIE, SESSION_MAX_AGE_S, type Auth } from './auth.ts'

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

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.length > MAX_BODY) throw new Error('请求太大')
  const value = JSON.parse(text || '{}')
  return value && typeof value === 'object' ? value : {}
}

/** The enabled user owning the request’s live session cookie. */
export async function signedIn(auth: Auth, request: Request) {
  return auth.session(parseCookies(request.headers.get('cookie'))[SESSION_COOKIE])
}

/** Email registration/login, session identity, logout and password rotation. */
export async function accountApi(auth: Auth, request: Request): Promise<Response> {
  const path = new URL(request.url).pathname
  if (request.method === 'POST' && !sameOrigin(request)) return json(403, { error: '来源不匹配' })
  try {
    if (path === '/api/registration' && request.method === 'GET') return json(200, { open: await auth.registrationOpen() })
    if ((path === '/api/login' || path === '/api/register') && request.method === 'POST') {
      const body = await readJson(request)
      try {
        const email = String(body.email ?? ''), password = String(body.password ?? '')
        if (path === '/api/register') await auth.register(email, password)
        const token = await auth.login(email, password)
        return json(200, { user: await auth.session(token) }, { 'set-cookie': sessionCookie(request, token, SESSION_MAX_AGE_S) })
      } catch (error) {
        return json(path === '/api/register' ? 400 : 401, { error: error instanceof Error ? error.message : '登录失败' })
      }
    }
    if (path === '/api/password' && request.method === 'POST') {
      const user = await signedIn(auth, request)
      if (!user) return json(401, { error: '未登录' })
      const body = await readJson(request)
      const token = await auth.changePassword(user.id, String(body.current ?? ''), String(body.next ?? ''))
      return json(200, {}, { 'set-cookie': sessionCookie(request, token, SESSION_MAX_AGE_S) })
    }
    if (path === '/api/logout' && request.method === 'POST') {
      const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE]
      if (token) await auth.logout(token)
      return json(200, {}, { 'set-cookie': sessionCookie(request, '', 0) })
    }
    if (path === '/api/me' && request.method === 'GET') {
      const user = await signedIn(auth, request)
      return user ? json(200, { user }) : json(401, { error: '未登录' })
    }
  } catch (error) {
    return json(400, { error: error instanceof Error ? error.message : String(error) })
  }
  return json(404, { error: 'not found' })
}
