// Roadmap-7 B5/B6: temporary trees retain no memory capabilities and leave no reachable content after deletion.
import { AgentDoc, type ConversationInit } from '@earendil-works/pi-durable'
import type { UserSpace } from './space.ts'

/** Applied to new roots and empty branches; ordinary forks inherit their parent's AgentDoc. */
export const temporaryInit: ConversationInit = async (tx, id) => {
  const agent = await tx.doc(AgentDoc, id)
  agent.tools = Array.isArray(agent.tools)
    ? agent.tools.filter(name => name !== 'memory')
    : { remove: [...new Set([...(agent.tools?.remove ?? []), 'memory'])] }
}

export const TEMPORARY_CLEANUP_MS = 10 * 60_000

export function startTemporaryCleanup(this: UserSpace) {
  this.temporaryTimer = setInterval(() => {
    void this.cleanupTemporary().catch(error => console.error('Temporary conversation cleanup failed:', error))
  }, TEMPORARY_CLEANUP_MS)
  this.temporaryTimer.unref()
}

/** The startup sweep runs before trigger recovery and Harness resume. Concurrent sweeps share one operation. */
export function cleanupTemporary(this: UserSpace): Promise<void> {
  if (this.closed) return Promise.resolve()
  if (this.temporaryCleanup) return this.temporaryCleanup
  const run = (async () => {
    const rows = await this.db.all<{ id: string }>('SELECT id FROM trees WHERE expiresAt IS NOT NULL AND expiresAt <= ?', this.now())
    const errors: unknown[] = []
    for (const { id } of rows) {
      if (this.closed) break
      try { await this.deleteTree(id) }
      catch (error) {
        // A browser may delete the tree while it waits in the per-user sharing queue.
        const alreadyDeleted = error instanceof Error && error.message === '会话不存在' && !await this.db.get('SELECT id FROM trees WHERE id = ?', id)
        if (!alreadyDeleted) errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, '临时对话清理失败')
  })()
  this.temporaryCleanup = run
  const settled = () => { if (this.temporaryCleanup === run) this.temporaryCleanup = undefined }
  void run.then(settled, settled)
  return run
}

export async function stopTemporaryCleanup(this: UserSpace) {
  clearInterval(this.temporaryTimer)
  await this.temporaryCleanup
}
