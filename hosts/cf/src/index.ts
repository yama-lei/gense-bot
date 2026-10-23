// Cloudflare deployment (ADR-0004 decision 3): the Worker routes, one Accounts object holds users and sessions, and
// one UserHub object per user holds that user's pi-durable Harness and sockets.
import { DurableObjectSqliteDatabase } from '@earendil-works/chord/sqlite/cloudflare'
import type { Wake } from '@earendil-works/pi-durable'
import { accountApi, Auth, Connection, fauxModels, json, relayFromEnv, sameOrigin, sessionUser, SqliteFiles, UserSpace, type ModelSetup, type User } from '@gense/core'
import { DurableObject } from 'cloudflare:workers'

export interface Env {
  ACCOUNTS: DurableObjectNamespace<Accounts>
  HUBS: DurableObjectNamespace<UserHub>
  ASSETS: Fetcher
  GENSE_FAUX?: string
  ADMIN_TOKEN?: string
  PROVIDER_BASE_URL?: string
  PROVIDER_AUTH_TOKEN?: string
  DEFAULT_PROVIDER_MODEL?: string
  PROVIDER_MODELS?: string
}

/** Set by the Worker on the request it forwards to a UserHub, after checking the session. */
const USER_HEADER = 'x-gense-user'

const accounts = (env: Env) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts'))

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    // Password hashing takes longer than a Worker request may on the free plan, so the object does it.
    if (path.startsWith('/api/')) return accounts(env).fetch(request)
    if (path === '/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'expected a WebSocket' })
      const user = sameOrigin(request) ? await accounts(env).user(request.headers.get('cookie')) : null
      if (!user) return json(401, { error: '未登录' })
      const headers = new Headers(request.headers)
      headers.set(USER_HEADER, JSON.stringify(user))
      return env.HUBS.get(env.HUBS.idFromName(user.id)).fetch(new Request(request, { headers }))
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

export class Accounts extends DurableObject<Env> {
  #auth!: Auth

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      this.#auth = await Auth.open(new DurableObjectSqliteDatabase(ctx.storage))
    })
  }

  override async fetch(request: Request) {
    return accountApi(this.#auth, request, { adminToken: this.env.ADMIN_TOKEN || undefined })
  }

  async user(cookie: string | null): Promise<User | null> {
    return (await sessionUser(this.#auth, new Request('https://accounts/', { headers: cookie ? { cookie } : {} }))) ?? null
  }
}

export class UserHub extends DurableObject<Env> {
  #space!: UserSpace
  #setup!: ModelSetup

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      // A fallback before anything can throw: an object whose open or recovery fails is started again.
      const fallback = Date.now() + 60_000
      const current = await ctx.storage.getAlarm()
      if (current === null || current > fallback) await ctx.storage.setAlarm(fallback)
      this.#setup = env.GENSE_FAUX === '1' ? fauxModels() : relayFromEnv(env as unknown as Record<string, string | undefined>)
      const db = new DurableObjectSqliteDatabase(ctx.storage)
      const files = await SqliteFiles.open(db, { id: `hub:${ctx.id.toString()}` })
      this.#space = await UserSpace.open(db, {
        models: this.#setup.models,
        env: (cwd) => files.env({ cwd }),
        defaultModel: this.#setup.defaultModel,
        // A failed alarm write resets the object; it arms again when it next starts.
        harness: { onWake: (wake) => void this.#arm(wake).catch(() => ctx.abort('Alarm write failed')) },
        arm: (wake) => this.#arm(wake),
      })
    })
  }

  override async alarm() {
    await this.#arm({ ...this.#space.harness.wake(), active: true })
    this.#space.harness.resume()
  }

  async #arm(wake: Wake) {
    // A recovery heartbeat while work runs, never later than the earliest sleep.
    const heartbeat = wake.active ? Date.now() + 60_000 : undefined
    const at = heartbeat === undefined || wake.at === undefined ? (heartbeat ?? wake.at) : Math.min(heartbeat, wake.at)
    if (at === undefined) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(at)
  }

  override async fetch(request: Request) {
    const user = JSON.parse(request.headers.get(USER_HEADER) ?? 'null') as User | null
    if (!user) return json(401, { error: '未登录' })
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    server.accept()
    const connection = new Connection({
      space: this.#space,
      email: user.email,
      models: this.#setup.options,
      defaultModel: this.#setup.defaultModel,
      send: (m) => server.send(m),
    })
    // Requests are handled in arrival order so a send never overtakes the watch before it.
    let queue = connection.start()
    server.addEventListener('message', (event) => {
      queue = queue.then(() => connection.handle(String(event.data))).catch(() => {})
    })
    server.addEventListener('close', () => {
      void connection.close()
      try {
        server.close()
      } catch {
        // Already closed.
      }
    })
    return new Response(null, { status: 101, webSocket: client })
  }
}
