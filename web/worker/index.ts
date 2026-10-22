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

    // Generated images live in their chat; the hub checks the chat is this user's.
    const image = url.pathname.match(/^\/api\/chats\/([\w-]{1,100})\/images\/([\w-]{1,100})$/)
    if (image && request.method === 'GET') {
      const found = await (await hub()).chatImage(image[1], image[2])
      if (!found) return new Response('Not found', { status: 404 })
      return new Response(found.bytes, { headers: { 'content-type': found.mediaType, 'cache-control': 'private, max-age=31536000, immutable' } })
    }

    // Workspace files live in their chat too (roadmap-2 "L0-6 会话工作区").
    const file = url.pathname.match(/^\/api\/chats\/([\w-]{1,100})\/files$/)
    const path = url.searchParams.get('path')
    if (file && path && request.method === 'GET') {
      try {
        const found = await (await hub()).chatFile(file[1], path)
        if (!found) return new Response('Not found', { status: 404 })
        const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(found.name)}`
        return new Response(found.bytes, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': disposition, 'cache-control': 'private, no-store' } })
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 400 })
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
