import type { WorkerEnv } from './env'
import { createRemoteJWKSet, jwtVerify } from 'jose'

export interface User {
  /** Access user ID; names the user's UserHub. */
  sub: string
  email: string
}

let jwks: { team: string; set: ReturnType<typeof createRemoteJWKSet> } | undefined

/**
 * Verifies the Access JWT on a request (architecture "登录与授权" step 2).
 * Returns null when the token is missing or invalid, so a request that bypassed Access is refused.
 */
export async function authenticate(request: Request, env: WorkerEnv): Promise<User | null> {
  // Local `vite dev` has no Access in front; the production build drops this branch.
  if (import.meta.env.DEV) return { sub: 'dev', email: 'dev@localhost' }

  const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? cookie(request, 'CF_Authorization')
  if (!token) return null
  const team = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, '')
  if (jwks?.team !== team) jwks = { team, set: createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`)) }
  try {
    const { payload } = await jwtVerify(token, jwks.set, { issuer: team, audience: env.ACCESS_AUD })
    if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.email !== 'string') return null
    return { sub: payload.sub, email: payload.email }
  } catch {
    return null
  }
}

function cookie(request: Request, name: string): string | null {
  for (const part of request.headers.get('Cookie')?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}
