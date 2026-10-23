// One browser socket: answers ClientRequests and streams watched views (roadmap-3 D9). Hosts only move strings.
import { encoder } from '@earendil-works/chord/delta'
import type { ConversationWatch } from '@earendil-works/pi-durable'
import type { AuthInteraction, AuthType } from '@earendil-works/pi-ai'
import type { ClientRequest, LoginPrompt, ServerMessage } from './protocol.ts'
import type { UserSpace } from './space.ts'
import { fromBase64 } from './workspace.ts'

export interface ConnectionOptions {
  space: UserSpace
  email: string
  send(message: string): void
}

export class Connection {
  readonly #o: ConnectionOptions
  readonly #watches = new Map<string, ConversationWatch>()
  /** Logins this socket runs, and the prompts they wait on; closing the socket cancels them. */
  readonly #logins = new Map<string, AbortController>()
  readonly #prompts = new Map<string, (value: string | undefined) => void>()
  #unsubscribe: (() => void)[] = []
  #closed = false

  constructor(options: ConnectionOptions) {
    this.#o = options
  }

  #send(message: ServerMessage) {
    if (!this.#closed) this.#o.send(JSON.stringify(message))
  }

  async start() {
    const { space, email } = this.#o
    this.#send({ t: 'hello', email })
    const accounts = async () => {
      const { accounts } = space
      this.#send({ t: 'providers', providers: accounts.providers() })
      this.#send({ t: 'models', models: await accounts.list(), defaultModel: await accounts.defaultModel() })
    }
    this.#unsubscribe.push(
      space.accounts.subscribe(() => void accounts()),
      space.subscribeTrees((trees) => this.#send({ t: 'trees', trees })),
      space.plugins.subscribe(() => this.#send({ t: 'plugins', plugins: space.plugins.list() })),
      space.skills.subscribe(() => this.#send({ t: 'skills', skills: space.skills.list() })),
    )
    this.#send({ t: 'plugins', plugins: space.plugins.list() })
    this.#send({ t: 'skills', skills: space.skills.list() })
    await accounts()
    this.#send({ t: 'trees', trees: await space.trees() })
  }

  async handle(raw: string) {
    let request: ClientRequest
    try {
      request = JSON.parse(raw)
    } catch {
      return
    }
    const reply = this.#reply(request)
    // A login waits on the user's answers, which arrive as later requests: it must not hold up the host's queue.
    if (request.t !== 'auth.login') await reply
  }

  async #reply(request: ClientRequest) {
    try {
      const value = await this.#dispatch(request)
      this.#send({ t: 'reply', id: request.id, ...(value !== undefined && { value }) })
    } catch (error) {
      this.#send({ t: 'reply', id: request.id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async #dispatch(r: ClientRequest): Promise<unknown> {
    const { space } = this.#o
    switch (r.t) {
      case 'tree.create':
        return space.createTree()
      case 'tree.update':
        return space.updateTree(r.treeId, { ...(r.title !== undefined && { title: r.title }), ...(r.pinned !== undefined && { pinned: r.pinned }) })
      case 'tree.delete':
        await this.#unwatch(r.treeId)
        return space.deleteTree(r.treeId)
      case 'send':
        return space.send(r.treeId, {
          text: r.text,
          requestId: r.requestId,
          ...(r.model && { model: r.model }),
          ...(r.effort && { effort: r.effort }),
          ...(r.attachments?.length && { attachments: r.attachments }),
          ...(r.command && { command: r.command }),
          ...(r.mentions?.length && { mentions: r.mentions }),
        })
      case 'abort':
        return space.abort(r.treeId)
      case 'watch':
        return this.#watch(r.treeId)
      case 'unwatch':
        return this.#unwatch(r.treeId)
      case 'files.list':
        return (await space.files(r.treeId)).list(r.treeId)
      case 'files.preview':
        return (await space.files(r.treeId)).preview(r.treeId, r.path)
      case 'files.read':
        return (await space.files(r.treeId)).read(r.treeId, r.path)
      case 'files.delete':
        return (await space.files(r.treeId)).delete(r.treeId, r.path)
      case 'upload':
        return space.workspace.upload(r.name, fromBase64(r.base64))
      case 'uploads':
        return space.workspace.uploads()
      case 'tool.call':
        return space.callTool(r.treeId, r.name, r.args)
      case 'skill.set':
        return space.skills.set(r.name, r.enabled)
      case 'auth.login':
        return this.#login(r.loginId, r.provider, r.type)
      case 'auth.answer': {
        const answer = this.#prompts.get(r.promptId)
        if (!answer) throw new Error('这个问题已经失效')
        return answer(r.value)
      }
      case 'auth.cancel':
        return this.#logins.get(r.loginId)?.abort()
      case 'auth.logout':
        return space.accounts.logout(r.provider)
      case 'plugin.set':
        return space.plugins.set(r.pluginId, {
          ...(r.enabled !== undefined && { enabled: r.enabled }),
          ...(r.values && { values: r.values }),
          ...(r.secrets && { secrets: r.secrets }),
        })
      default:
        throw new Error('未知请求')
    }
  }

  /** Relays the login's events and prompts to this socket. */
  async #login(loginId: string, provider: string, type: AuthType) {
    if (this.#logins.has(loginId)) throw new Error('登录已在进行')
    const abort = new AbortController()
    this.#logins.set(loginId, abort)
    const interaction: AuthInteraction = {
      signal: abort.signal,
      notify: (event) => this.#send({ t: 'auth.event', loginId, event }),
      prompt: ({ signal, ...prompt }) =>
        new Promise((resolve, reject) => {
          const promptId = crypto.randomUUID()
          const signals = [abort.signal, ...(signal ? [signal] : [])]
          const settle = (value: string | undefined) => {
            this.#prompts.delete(promptId)
            for (const s of signals) s.removeEventListener('abort', cancel)
            this.#send({ t: 'auth.prompt.done', promptId })
            if (value === undefined) reject(new Error('已取消'))
            else resolve(value)
          }
          const cancel = () => settle(undefined)
          if (signals.some((s) => s.aborted)) return reject(new Error('已取消'))
          for (const s of signals) s.addEventListener('abort', cancel, { once: true })
          this.#prompts.set(promptId, settle)
          this.#send({ t: 'auth.prompt', loginId, promptId, prompt: prompt as LoginPrompt })
        }),
    }
    try {
      await this.#o.space.accounts.login(provider, type, interaction)
    } finally {
      this.#logins.delete(loginId)
    }
  }

  /** Sends the whole view, then the ops of each later commit. Watching again restarts the stream. */
  async #watch(treeId: string) {
    await this.#unwatch(treeId)
    const watch = await this.#o.space.watch(treeId)
    if (this.#closed) return void (await watch.stop())
    this.#watches.set(treeId, watch)
    const enc = encoder()
    this.#send({ t: 'view', treeId, value: watch.value })
    watch.start(async (_value, ops) => this.#send({ t: 'ops', treeId, ops: enc.encode(ops) }))
    void watch.closed.then(() => {
      if (this.#watches.get(treeId) === watch) this.#watches.delete(treeId)
    })
  }

  async #unwatch(treeId: string) {
    const watch = this.#watches.get(treeId)
    this.#watches.delete(treeId)
    await watch?.stop()
  }

  async close() {
    this.#closed = true
    for (const login of this.#logins.values()) login.abort()
    for (const u of this.#unsubscribe.splice(0)) u()
    await Promise.all([...this.#watches.values()].map((w) => w.stop()))
    this.#watches.clear()
  }
}
