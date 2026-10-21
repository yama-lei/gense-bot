import type { WorkerEnv } from './env'

// Google OAuth for Drive (architecture "登录与授权" step 3). The refresh token never leaves UserHub;
// it is stored encrypted with AES-GCM under TOKEN_ENCRYPTION_KEY.

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

export const CALLBACK_PATH = '/oauth/google/callback'

/** Google rejected the stored grant (revoked, expired or the client changed); the user must reconnect. */
export class GrantRevokedError extends Error {}

export function authUrl(env: WorkerEnv, redirectUri: string, state: string, loginHint: string) {
  const u = new URL(AUTH_URL)
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    // Without consent Google returns no refresh token when the app was authorized before.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString()
  return u.toString()
}

interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string }
  if (!res.ok) {
    if (json.error === 'invalid_grant') throw new GrantRevokedError('Google 授权已失效，请重新连接 Google Drive')
    throw new Error(`Google 授权失败：${json.error_description ?? json.error ?? res.status}`)
  }
  return json
}

export function exchangeCode(env: WorkerEnv, code: string, redirectUri: string) {
  return tokenRequest({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' })
}

export function refreshAccessToken(env: WorkerEnv, refreshToken: string) {
  return tokenRequest({ refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' })
}

export async function revoke(token: string) {
  await fetch(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }).catch(() => {})
}

// ---- AES-GCM for the refresh token ----

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

let keyCache: { raw: string; key: CryptoKey } | undefined
async function key(env: WorkerEnv) {
  if (keyCache?.raw !== env.TOKEN_ENCRYPTION_KEY) {
    const key = await crypto.subtle.importKey('raw', unb64(env.TOKEN_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt'])
    keyCache = { raw: env.TOKEN_ENCRYPTION_KEY, key }
  }
  return keyCache.key
}

/** Returns `iv.ciphertext`, both base64. */
export async function encrypt(env: WorkerEnv, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(plain))
  return `${b64(iv)}.${b64(new Uint8Array(data))}`
}

export async function decrypt(env: WorkerEnv, sealed: string) {
  const [iv, data] = sealed.split('.')
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(env), unb64(data))
  return new TextDecoder().decode(plain)
}
