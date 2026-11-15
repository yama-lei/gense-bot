// The Inbox: what the assistant did while you were away. Scheduled runs and channel conversations are real; which
// ones were read is remembered in this browser.
import { CheckCheck, Inbox, Radio, Timer } from 'lucide-react'
import { useState } from 'react'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { formatTime } from '../../lib/format'
import { Link, navigate } from '../../lib/router'
import { Button } from '../../ui/button'
import { Empty } from '../../ui/feedback'
import { Tabs, TabsList, TabsTrigger } from '../../ui/tabs'
import { markRead, useInbox, type InboxItem } from './items'

type Filter = 'all' | 'unread' | InboxItem['kind']

const kinds = {
  schedule: { label: '定时任务', icon: Timer },
  channel: { label: '渠道', icon: Radio },
}

export default function InboxPage() {
  const { items, unread } = useInbox()
  const [filter, setFilter] = useState<Filter>('all')
  const shown = items.filter((i) => filter === 'all' || (filter === 'unread' ? i.unread : i.kind === filter))

  return (
    <Page
      title="收件箱"
      description="你不在的时候，Gense 做了什么：定时任务的结果、从飞书等渠道进来的对话，都汇在这里。"
      actions={
        <Button disabled={!unread} onClick={() => markRead(items.map((i) => i.id))}>
          <CheckCheck /> 全部已读
        </Button>
      }
    >
      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} className="mb-4">
        <TabsList>
          <TabsTrigger value="all">全部</TabsTrigger>
          <TabsTrigger value="unread">
            未读 {unread > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] leading-4.5 font-semibold text-accent-foreground">{unread}</span>}
          </TabsTrigger>
          <TabsTrigger value="schedule">定时任务</TabsTrigger>
          <TabsTrigger value="channel">渠道</TabsTrigger>
        </TabsList>
      </Tabs>

      {shown.length === 0 ? (
        <Empty
          icon={<Inbox />}
          title={items.length ? '这里没有内容' : '收件箱是空的'}
          action={
            !items.length && (
              <Button asChild variant="primary">
                <Link to={{ name: 'automations' }}>创建定时任务</Link>
              </Button>
            )
          }
        >
          {items.length ? '换个筛选条件看看。' : '让 Gense 定时替你做事，或把它接入飞书，结果会出现在这里。'}
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-2xl border bg-card">
          {shown.map((item) => {
            const kind = kinds[item.kind]
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    markRead([item.id])
                    navigate({ name: 'chat', id: item.treeId })
                  }}
                  className="flex w-full items-start gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-hover"
                >
                  <span className={cn('relative mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground', item.unread && 'bg-accent-soft text-accent')}>
                    <kind.icon className="size-4.5" />
                    {item.unread && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-accent ring-2 ring-card" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={cn('min-w-0 flex-1 truncate text-sm', item.unread ? 'font-semibold' : 'font-medium text-foreground/80')}>{item.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatTime(item.at)}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{item.body}</span>
                    <span className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {kind.label} · <span className="truncate">{item.chat}</span>
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Page>
  )
}
