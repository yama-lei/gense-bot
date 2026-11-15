// A short, metered side call. It has no tools, prompt sections or durable conversation entries.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Conversation, Submission } from '@earendil-works/pi-durable'
import { parseNote, type Suggestions } from '@gense/protocol'
import { SUGGEST_SYSTEM, suggestInput, parseSuggestions } from './suggest-prompt.ts'
import { entryText, type BranchRow, type TreeRow } from './shared.ts'
import { historyEntries } from './history.ts'
import type { UserSpace } from './space.ts'

export class SuggestionStore {
  readonly #values = new Map<string, Suggestions>()
  readonly #versions = new Map<string, symbol>()
  readonly #controllers = new Map<string, AbortController>()
  readonly #jobs = new Set<Promise<void>>()
  readonly #listeners = new Set<(treeId: string, suggestions: Suggestions) => void>()
  readonly space: UserSpace
  #closed = false
  readonly #unsubscribe: () => void
  constructor(space: UserSpace) {
    this.space = space
    this.#unsubscribe = space.preferences.subscribe(() => {
      if (space.preferences.get().suggestions === false) for (const treeId of this.#versions.keys()) this.clear(treeId)
    })
  }
  get(treeId: string) { return this.#values.get(treeId) }
  subscribe(fn: (treeId: string, suggestions: Suggestions) => void) { this.#listeners.add(fn); return () => { this.#listeners.delete(fn) } }

  clear(treeId: string) {
    this.#versions.delete(treeId)
    this.#controllers.get(treeId)?.abort()
    this.#controllers.delete(treeId)
    const previous = this.#values.get(treeId)
    this.#values.delete(treeId)
    if (previous) for (const listener of this.#listeners) listener(treeId, { turnId: previous.turnId, items: [] })
  }

  begin(treeId: string) {
    this.clear(treeId)
    const version = Symbol()
    this.#versions.set(treeId, version)
    return version
  }

  follow(tree: TreeRow, branch: BranchRow, conv: Conversation, submission: Submission, version: symbol) {
    if (branch.role !== 'main' || this.space.preferences.get().suggestions === false) return
    // Do not hold shutdown open while a durable main run is still waiting; Harness.close owns those runs.
    void submission.wait(BACKGROUND_CONTEXT).then(settled => {
      if (settled.status !== 'done' || settled.type !== 'input' || !this.#current(tree.id, version)) return
      const job = this.#generate(tree.id, conv, settled.entry, settled.answer, settled.requestId, version).catch(() => {})
      this.#jobs.add(job)
      void job.finally(() => this.#jobs.delete(job))
    }).catch(() => {})
  }

  #current(treeId: string, version: symbol) {
    return !this.#closed && !this.space.closed && this.#versions.get(treeId) === version && this.space.preferences.get().suggestions !== false
  }

  async #generate(treeId: string, conv: Conversation, entryId: number, answerId: number, requestId: string | undefined, version: symbol) {
    const { space } = this
    const tree = await space.row(treeId)
    const source = requestId && (await space.triggers.get(requestId))?.source
    if (source ? source !== 'web' : tree.source && JSON.parse(tree.source).kind === 'feishu') return
    const entries = await historyEntries(conv, BACKGROUND_CONTEXT)
    const question = entries.find(e => e.id === entryId), answer = entries.find(e => e.id === answerId)
    const message = answer?.model?.[0]
    if (!question || message?.role !== 'assistant' || message.stopReason !== 'stop') return
    const text = entryText(answer!)
    const input = question.model?.[0]?.content
    const asked = typeof input === 'string' ? input : (input ?? []).flatMap(b => b.type === 'text' && !parseNote(b.text) ? [b.text] : []).join('\n')
    if (!text.trim() || !asked.trim() || !this.#current(treeId, version)) return
    const model = space.accounts.models.getModel(message.provider, message.model)
    if (!model) return
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 20_000)
    this.#controllers.set(treeId, abort)
    try {
      const reply = await space.accounts.models.completeSimple(model, {
        systemPrompt: SUGGEST_SYSTEM,
        messages: [{ role: 'user', content: suggestInput(asked, text), timestamp: space.now() }],
        tools: [],
      // pi-ai's simple API disables thinking when no reasoning level is supplied.
      }, { maxTokens: 300, timeoutMs: 20_000, maxRetries: 0, signal: abort.signal })
      if (abort.signal.aborted || reply.stopReason !== 'stop' || !this.#current(treeId, version)) return
      const items = parseSuggestions(reply.content.flatMap(b => b.type === 'text' ? [b.text] : []).join(''))
      if (!items.length) return
      await space.row(treeId)
      if (!this.#current(treeId, version)) return
      const value = { turnId: String(entryId), items }
      this.#values.set(treeId, value)
      for (const listener of this.#listeners) listener(treeId, value)
    } finally {
      clearTimeout(timer)
      if (this.#controllers.get(treeId) === abort) this.#controllers.delete(treeId)
    }
  }

  async close() {
    this.#closed = true
    this.#unsubscribe()
    for (const abort of this.#controllers.values()) abort.abort()
    await Promise.all(this.#jobs)
    this.#values.clear(); this.#versions.clear(); this.#listeners.clear()
  }
}
