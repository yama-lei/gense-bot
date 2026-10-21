import type { WorkerEnv } from './env'
import { getAgentByName } from 'agents'
import { authenticate } from './auth'
import { CALLBACK_PATH } from './google'
import { EMAIL_HEADER } from './hub'

export { Chat } from './chat'
export { UserHub } from './hub'

/**
 * Every API request is authenticated here and sent only to the caller's own hub, which forwards
 * `/agents/hub/chats/<id>` to that chat. No route takes a Durable Object name from the client,
 * so `routeAgentRequest` (which would) is deliberately not used.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const user = await authenticate(request, env)
    if (!user) return new Response('Unauthorized', { status: 401 })
    const hub = () => getAgentByName(env.UserHub, user.sub)

    if (url.pathname === '/agents/hub' || url.pathname.startsWith('/agents/hub/')) {
      const headers = new Headers(request.headers)
      headers.set(EMAIL_HEADER, user.email)
      return (await hub()).fetch(new Request(request, { headers }))
    }

    // Uploads use HTTP, not the WebSocket: large frames are fragile, and the form carries the file as-is.
    if (url.pathname === '/api/files' && request.method === 'POST') {
      const form = await request.formData().catch(() => null)
      const file = form?.get('file')
      if (!file || typeof file === 'string') return Response.json({ error: '请求里没有文件' }, { status: 400 })
      try {
        return Response.json(await (await hub()).uploadFile(file.name, file.type, await file.arrayBuffer()))
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
      }
    }

    // Google OAuth for Drive. Both legs run behind Access, so the state is bound to this user's hub.
    const redirectUri = `${url.origin}${CALLBACK_PATH}`
    if (url.pathname === '/oauth/google/start' && request.method === 'GET') {
      return Response.redirect(await (await hub()).beginGoogleAuth(redirectUri), 302)
    }
    if (url.pathname === CALLBACK_PATH && request.method === 'GET') {
      const p = url.searchParams
      await (await hub()).finishGoogleAuth({ code: p.get('code') ?? undefined, state: p.get('state') ?? undefined, error: p.get('error') ?? undefined }, redirectUri)
      return Response.redirect(`${url.origin}/#/customize`, 302)
    }
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<WorkerEnv>
