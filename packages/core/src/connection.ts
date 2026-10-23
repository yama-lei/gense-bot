// One browser socket: answers ClientRequests and streams watched views (roadmap-3 D9). Hosts only move strings.
import { encoder } from '@earendil-works/chord/delta'
import type { ConversationWatch } from '@earendil-works/pi-durable'
import type { ClientRequest, ModelInfo, ServerMessage } from './protocol.ts'
import type { UserSpace } from './space.ts'
import { fromBase64 } from './workspace.ts'

export interface ConnectionOptions {
  space: UserSpace
  email: string
  models: ModelInfo[]
  defaultModel: ModelInfo | null
  send(message: string): void
}

export class Connection {
  readonly #o: ConnectionOptions
  readonly #watches = new Map<string, ConversationWatch>()
  #unsubscribe: (() => void) | undefined
  #closed = false

  constructor(options: ConnectionOptions) {
    this.#o = options
  }

  #send(message: ServerMessage) {
    if (!this.#closed) this.#o.send(JSON.stringify(message))
  }

  async start() {
    const { space, email, models, defaultModel } = this.#o
    this.#send({ t: 'hello', email, models, defaultModel })
    this.#unsubscribe = space.subscribeTrees((trees) => this.#send({ t: 'trees', trees }))
    this.#send({ t: 'trees', trees: await space.trees() })
  }

  async handle(raw: string) {
    let request: ClientRequest
    try {
      request = JSON.parse(raw)
    } catch {
      return
    }
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
      default:
        throw new Error('未知请求')
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
    this.#unsubscribe?.()
    await Promise.all([...this.#watches.values()].map((w) => w.stop()))
    this.#watches.clear()
  }
}
