// The web transcript is history, whereas pi's structural view is only the current model context.
import type { Context } from '@earendil-works/chord/context'
import { diffRevisions, type JsonValue } from '@earendil-works/chord/delta'
import type { Conversation, ConversationView, ConversationWatch, EntryId, EntryRecord } from '@earendil-works/pi-durable'

export async function historyEntries(conv: Conversation, ctx: Context, maxEntryId?: EntryId) {
  const entries: EntryRecord[] = []
  let cursor
  do {
    const page = await conv.entries({ order: 'ascending', ...(maxEntryId !== undefined && { maxEntryId }) }, 1000, cursor, ctx)
    entries.push(...page.items)
    cursor = page.next
  } while (cursor !== undefined)
  return entries
}

export async function historyWatch(conv: Conversation, ctx: Context): Promise<ConversationWatch> {
  const watch = await conv.watch(ctx)
  try {
    // Capture the watch first and bound the history query to its revision; later commits stay queued in the watch.
    const tail = Math.max(0, ...watch.value.entries.map(e => e.id)) as EntryId
    const entries = new Map((await historyEntries(conv, ctx, tail)).map(e => [e.id, e]))
    const merge = (next: ConversationView): ConversationView => {
      for (const entry of next.entries) entries.set(entry.id, entry)
      return { ...next, entries: [...entries.values()].sort((a, b) => a.id - b.id) }
    }
    let value = merge(watch.value)
    return {
      get value() { return value },
      start(listener) {
        watch.start(async (next, _ops, ctx) => {
          // A bounded pi watch can coalesce revisions. A new head may hide entries from skipped frames; recover them
          // from durable history before publishing this frame, bounded to the same revision.
          if (next.entries.some(e => e.head !== undefined && !entries.has(e.id))) {
            const tail = Math.max(0, ...next.entries.map(e => e.id)) as EntryId
            for (const entry of await historyEntries(conv, ctx, tail)) entries.set(entry.id, entry)
          }
          const before = value
          value = merge(next)
          await listener(value, diffRevisions(before as unknown as JsonValue, value as unknown as JsonValue), ctx)
        })
      },
      stop: () => watch.stop(),
      closed: watch.closed,
    }
  } catch (error) {
    await watch.stop()
    throw error
  }
}
