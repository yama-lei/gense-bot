// What the assistant did while the owner was away: scheduled runs and conversations that arrived through a channel.
// Read state stays in this browser (lib/lab.ts).
import { useMemo } from 'react'
import { useHost } from '../../app/client'
import { lab, useLab } from '../../lib/lab'

export interface InboxItem {
  id: string
  kind: 'schedule' | 'channel'
  title: string
  body: string
  at: number
  treeId: string
  /** The conversation's title, for the row's second line. */
  chat: string
  unread: boolean
}

const READ_KEPT = 300

export function useInbox() {
  const { schedules, trees } = useHost()
  const { read } = useLab()
  return useMemo(() => {
    const seen = new Set(read)
    const titleOf = (id: string) => trees?.find((t) => t.id === id)?.title || '新对话'
    const items: InboxItem[] = [
      ...schedules.flatMap((s): InboxItem[] => {
        if (!s.lastRunAt) return []
        const id = `s:${s.id}:${s.lastRunAt}`
        return [{ id, kind: 'schedule', title: s.name || '定时任务', body: s.lastResult || s.prompt, at: s.lastRunAt, treeId: s.treeId, chat: titleOf(s.treeId), unread: !seen.has(id) }]
      }),
      ...(trees ?? []).flatMap((t): InboxItem[] => {
        if (!t.source) return []
        const id = `c:${t.id}:${t.updatedAt}`
        return [{ id, kind: 'channel', title: t.title || '新对话', body: `来自 ${t.source.label || t.source.kind} 的新消息`, at: t.updatedAt, treeId: t.id, chat: t.source.label || t.source.kind, unread: !seen.has(id) }]
      }),
    ].sort((a, b) => b.at - a.at)
    return { items, unread: items.filter((i) => i.unread).length }
  }, [schedules, trees, read])
}

export const markRead = (ids: string[]) => lab.set((l) => ({ ...l, read: [...new Set([...l.read, ...ids])].slice(-READ_KEPT) }))
