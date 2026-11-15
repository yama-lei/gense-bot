// Memory: what the assistant should keep in mind across conversations. The list lives in this browser (lib/lab.ts)
// until the server keeps memories; the standing instructions in Settings are what reaches the model today.
import { Brain, MessageCircle, PencilLine, Plus, Search, Trash2, UserRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { formatTime } from '../../lib/format'
import { lab, memories, useLab, useMemories, type Memory } from '../../lib/lab'
import { Link } from '../../lib/router'
import { PreviewBadge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { ConfirmDialog } from '../../ui/dialog'
import { Empty } from '../../ui/feedback'
import { Input } from '../../ui/input'
import { Switch } from '../../ui/switch'

const examples = ['回答尽量简洁，先给结论', '我是前端工程师，主要写 TypeScript', '时间一律用北京时间', '写邮件时用正式一点的语气']

const add = (text: string) => memories.set((all) => [{ id: crypto.randomUUID(), text, source: 'manual', enabled: true, createdAt: Date.now() }, ...all])
const patch = (id: string, change: Partial<Memory>) => memories.set((all) => all.map((m) => (m.id === id ? { ...m, ...change } : m)))

export default function MemoryPage() {
  const all = useMemories()
  const { memory: on } = useLab()
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const q = query.trim().toLowerCase()
  const shown = q ? all.filter((m) => m.text.toLowerCase().includes(q)) : all

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!draft.trim()) return
    add(draft.trim())
    setDraft('')
  }

  return (
    <Page
      title="记忆"
      eyebrow={<PreviewBadge />}
      description={
        <>
          让 Gense 记住关于你的事，每次对话都不用再说一遍。记忆目前保存在这个浏览器里；现在就要对所有对话生效的要求，请写进
          <Link to={{ name: 'settings', section: 'personal' }} className="text-accent underline-offset-4 hover:underline">
            个性化指令
          </Link>
          。
        </>
      }
    >
      <div className="mb-6 flex items-center gap-3 rounded-2xl border bg-card p-4">
        <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground', on && 'bg-accent-soft text-accent')}>
          <Brain className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">在对话中参考记忆</div>
          <div className="text-sm text-muted-foreground">{on ? `已开启 · ${all.filter((m) => m.enabled).length} 条生效` : '已关闭，记忆仍会保留'}</div>
        </div>
        <Switch checked={on} onCheckedChange={(v) => lab.set((l) => ({ ...l, memory: v }))} aria-label="在对话中参考记忆" />
      </div>

      <form onSubmit={submit} className="mb-3 flex gap-2">
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={280} placeholder="添加一条记忆，例如：我住在上海，吃素" aria-label="新记忆" className="h-10" />
        <Button type="submit" variant="primary" size="lg" disabled={!draft.trim()}>
          <Plus /> 记住
        </Button>
      </form>

      {all.length === 0 ? (
        <Empty icon={<Brain />} title="还没有记忆" className="mt-6">
          从一条开始，或在任意回答下点「更多 → 存入记忆」。
          <span className="mt-3 flex flex-wrap justify-center gap-1.5">
            {examples.map((e) => (
              <button key={e} type="button" onClick={() => add(e)} className="rounded-full border bg-card px-3 py-1 text-sm text-foreground hover:bg-hover">
                + {e}
              </button>
            ))}
          </span>
        </Empty>
      ) : (
        <>
          <div className="mt-6 mb-2 flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`搜索 ${all.length} 条记忆`} aria-label="搜索记忆" className="pl-9" />
            </div>
            <Button variant="ghost-destructive" onClick={() => setClearing(true)}>
              全部清除
            </Button>
          </div>
          <ul className="flex flex-col divide-y overflow-hidden rounded-2xl border bg-card">
            {shown.map((m) => (
              <li key={m.id} className="group flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 text-muted-foreground [&_svg]:size-4" title={m.source === 'chat' ? '来自对话' : '手动添加'}>
                  {m.source === 'chat' ? <MessageCircle /> : <UserRound />}
                </span>
                <div className="min-w-0 flex-1">
                  {editing === m.id ? (
                    <Input
                      autoFocus
                      defaultValue={m.text}
                      maxLength={280}
                      aria-label="编辑记忆"
                      onBlur={(e) => {
                        if (e.target.value.trim()) patch(m.id, { text: e.target.value.trim() })
                        setEditing(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                  ) : (
                    <p className={cn('text-sm break-words', !m.enabled && 'text-muted-foreground line-through')}>{m.text}</p>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {m.source === 'chat' ? '来自对话' : '手动添加'} · {formatTime(m.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                  <Button variant="ghost" size="icon-sm" aria-label="编辑" onClick={() => setEditing(m.id)}>
                    <PencilLine />
                  </Button>
                  <Button variant="ghost-destructive" size="icon-sm" aria-label="删除" onClick={() => memories.set((list) => list.filter((x) => x.id !== m.id))}>
                    <Trash2 />
                  </Button>
                </div>
                <Switch checked={m.enabled} onCheckedChange={(v) => patch(m.id, { enabled: v })} aria-label="启用这条记忆" className="mt-0.5" />
              </li>
            ))}
            {shown.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">没有匹配「{query.trim()}」的记忆</li>}
          </ul>
        </>
      )}

      <ConfirmDialog open={clearing} onOpenChange={setClearing} title="清除全部记忆？" confirm="全部清除" onConfirm={() => memories.set([])}>
        {all.length} 条记忆会从这个浏览器里删除，无法恢复。
      </ConfirmDialog>
    </Page>
  )
}
