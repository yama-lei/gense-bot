// What the assistant did while the owner was away: scheduled runs, conversations that arrived through a channel and
// finished exports. Which ones were read is kept on the server (roadmap-7 D3), so every device agrees.
import { useMemo } from 'react'
import { useHost } from '../../app/client'

export interface InboxItem {
  id: string
  kind: 'schedule' | 'channel' | 'export'
  title: string
  body: string
  at: number
  /** Where the item leads: a conversation, or a file to download. */
  treeId?: string
  href?: string
  /** The second line: the conversation's title, or what the item is. */
  chat: string
  unread: boolean
}

export function useInbox() {
  const { schedules, trees, exports, inboxRead } = useHost()
  return useMemo(() => {
    // Until the server says what was read, nothing counts as unread: no badge that flashes and disappears.
    const seen = inboxRead ? new Set(inboxRead) : null
    const unread = (id: string) => !!seen && !seen.has(id)
    const titleOf = (id: string) => trees?.find((t) => t.id === id)?.title || '新对话'
    const items: InboxItem[] = [
      ...schedules.flatMap((s): InboxItem[] => {
        if (!s.lastRunAt) return []
        const id = `s:${s.id}:${s.lastRunAt}`
        return [{ id, kind: 'schedule', title: s.name || '定时任务', body: s.lastResult || s.prompt, at: s.lastRunAt, treeId: s.treeId, chat: titleOf(s.treeId), unread: unread(id) }]
      }),
      ...(trees ?? []).flatMap((t): InboxItem[] => {
        if (!t.source) return []
        const id = `c:${t.id}:${t.updatedAt}`
        return [{ id, kind: 'channel', title: t.title || '新对话', body: `来自 ${t.source.label || t.source.kind} 的新消息`, at: t.updatedAt, treeId: t.id, chat: t.source.label || t.source.kind, unread: unread(id) }]
      }),
      ...exports.flatMap((e): InboxItem[] => {
        if (e.status === 'running') return []
        const id = `e:${e.id}`
        const at = e.finishedAt ?? e.createdAt
        return e.status === 'ready'
          ? [{ id, kind: 'export', title: '导出已完成', body: '你的全部对话、文件、记忆和项目已经打包好，点击下载。', at, href: exportHref(e.id), chat: '数据导出', unread: unread(id) }]
          : [{ id, kind: 'export', title: '导出失败', body: e.error || '打包时出了问题，可以在设置 → 数据里重试。', at, chat: '数据导出', unread: unread(id) }]
      }),
    ].sort((a, b) => b.at - a.at)
    return { items, unread: items.filter((i) => i.unread).length }
  }, [schedules, trees, exports, inboxRead])
}

export const exportHref = (id: string) => `/api/exports/${encodeURIComponent(id)}`
