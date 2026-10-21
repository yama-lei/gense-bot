import type { WorkerEnv } from './env'
import { getAgentByName } from 'agents'
import { authenticate } from './auth'
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

    if (url.pathname === '/agents/hub' || url.pathname.startsWith('/agents/hub/')) {
      const headers = new Headers(request.headers)
      headers.set(EMAIL_HEADER, user.email)
      const hub = await getAgentByName(env.UserHub, user.sub)
      return hub.fetch(new Request(request, { headers }))
    }
    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<WorkerEnv>
