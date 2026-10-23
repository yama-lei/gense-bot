import type { InferEnv } from 'cf/config'
import type { production } from '../cloudflare.config'
import type { Chat } from './chat'
import type { UserHub } from './hub'

/**
 * Bindings of the production Worker; see the note on `production` in cloudflare.config.ts.
 * The Durable Object namespaces are typed here because the generated types infer the class
 * from the default export's union of modes, which yields untyped stubs.
 */
export type WorkerEnv = Omit<InferEnv<typeof production>, 'UserHub' | 'Chat'> & {
  UserHub: DurableObjectNamespace<UserHub>
  Chat: DurableObjectNamespace<Chat>
}
