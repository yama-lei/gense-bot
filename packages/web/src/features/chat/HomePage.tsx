import { ArrowUpRight, CalendarClock, Code, Ghost, GraduationCap, Inbox, LayoutDashboard, MessageCircle, PenLine, Telescope, Timer, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { report, useClient, useHost } from '../../app/client'
import { SidebarToggle } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { formatTime } from '../../lib/format'
import { Link, navigate } from '../../lib/router'
import type { Outgoing } from '../../lib/types'
import { Logo } from '../../ui/logo'
import { Button } from '../../ui/button'
import { Tooltip } from '../../ui/tooltip'
import { useInbox } from '../inbox/items'
import { Composer } from './Composer'

interface Starter {
  id: string
  icon: LucideIcon
  label: string
  prompts: string[]
}

const starters: Starter[] = [
  { id: 'research', icon: Telescope, label: '研究', prompts: ['帮我调研一下这个话题，给出带来源的结论：', '对比这几个方案的优缺点，用表格呈现：', '读一下这个网页并总结要点：'] },
  { id: 'write', icon: PenLine, label: '写作', prompts: ['帮我起草一封邮件，内容是：', '把下面这段话改得更简洁有力：', '为这个主题列一份文章大纲：'] },
  { id: 'code', icon: Code, label: '编程', prompts: ['帮我写一段代码：', '解释这段代码做了什么，并指出潜在问题：', '帮我排查这个报错：'] },
  { id: 'build', icon: LayoutDashboard, label: '做个页面', prompts: ['用一个可交互的页面展示：', '把这份数据做成图表：', '做一个小工具，用来'] },
  { id: 'learn', icon: GraduationCap, label: '学习', prompts: ['像给初学者讲解一样，解释一下：', '围绕这个主题给我出 5 道练习题：', '帮我制定一份学习计划，目标是：'] },
  { id: 'auto', icon: CalendarClock, label: '自动化', prompts: ['每天早上 9 点提醒我', '每周一早上总结上周这个话题的新进展：', '每个工作日下午 6 点帮我'] },
]

function greeting(name: string) {
  const h = new Date().getHours()
  const part = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
  return name ? `${part}，${name}` : part
}

export const footnote = <p className="px-2 pt-2 text-center text-xs text-muted-foreground">Gense 可能出错，请核对重要信息。</p>

export function HomePage() {
  const client = useClient()
  const { prefs, trees, schedules } = useHost()
  const inbox = useInbox()
  const [starting, setStarting] = useState(false)
  const [seed, setSeed] = useState<{ text: string; key: number }>()
  const [starter, setStarter] = useState<string | null>(null)
  const [temporary, setTemporary] = useState(false)

  const start = (message: Outgoing) => {
    setStarting(true)
    client.start(message, { temporary }).then(
      (id) => navigate({ name: 'chat', id }),
      (e: unknown) => {
        setStarting(false)
        // The message is gone from the box; give its text back.
        setSeed({ text: message.text, key: Date.now() })
        report(e)
      },
    )
  }

  const recent = [...(trees ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3)
  const upcoming = schedules.filter((s) => s.enabled && s.nextRunAt).sort((a, b) => a.nextRunAt! - b.nextRunAt!)[0]
  const open = starters.find((s) => s.id === starter)

  return (
    <div className="relative flex h-full flex-col">
      <div aria-hidden className="aura pointer-events-none absolute inset-x-0 top-0 h-[55%]" />
      <header className="relative flex h-13 shrink-0 items-center justify-between px-2 md:px-3">
        <SidebarToggle />
        <span className="flex-1" />
        <Tooltip label={temporary ? '关闭临时对话' : '临时对话：不进历史、不读写记忆'}>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={temporary}
            onClick={() => setTemporary(!temporary)}
            className={cn('gap-1.5 text-muted-foreground', temporary && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent')}
          >
            <Ghost /> <span className="max-sm:hidden">临时对话</span>
          </Button>
        </Tooltip>
        {inbox.unread > 0 && (
          <Link to={{ name: 'inbox' }} className="flex h-8 items-center gap-1.5 rounded-full border bg-card px-3 text-sm text-muted-foreground shadow-float hover:text-foreground">
            <Inbox className="size-4 text-accent" /> {inbox.unread} 条新动态
          </Link>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-3 pb-6 md:px-6">
        <div className="flex w-full max-w-3xl flex-1 flex-col md:flex-none md:pt-[max(2rem,calc(22dvh-3rem))]">
          <div className="flex flex-1 animate-rise flex-col items-center justify-center gap-4 py-8 max-md:order-1 md:flex-none md:pt-0 md:pb-9">
            {temporary ? <Ghost className="size-11 text-accent" strokeWidth={1.5} /> : <Logo className="size-11" />}
            <h1 className="text-center text-[1.75rem] leading-tight font-semibold tracking-tight md:text-[2.4rem]">{temporary ? '临时对话' : greeting(prefs?.name.trim() ?? '')}</h1>
            {temporary && <p className="-mt-1 max-w-md text-center text-sm text-muted-foreground">不会出现在历史和搜索里，不参考也不写入记忆。离开对话或 24 小时后删除。</p>}
          </div>

          <div className="max-md:order-3">
            <Composer placeholder="问点什么，或交给我一件事…" onSend={start} busy={starting} autoFocus seed={seed} />
          </div>

          <div className="mt-4 max-md:order-2 max-md:mt-0 max-md:mb-3">
            <div role="tablist" aria-label="从这些开始" className="flex flex-wrap justify-center gap-2 max-md:flex-nowrap max-md:justify-start max-md:overflow-x-auto max-md:[scrollbar-width:none]">
              {starters.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={starter === s.id}
                  onClick={() => setStarter(starter === s.id ? null : s.id)}
                  className={cn(
                    'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border bg-card px-3.5 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground',
                    starter === s.id && 'border-accent/40 bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent',
                  )}
                >
                  <s.icon className="size-4" /> {s.label}
                </button>
              ))}
            </div>
            {open && (
              <ul key={open.id} className="mx-auto mt-3 flex max-w-2xl animate-rise flex-col divide-y rounded-2xl border bg-card px-1.5 py-1 shadow-float">
                {open.prompts.map((p) => (
                  <li key={p}>
                    <button
                      type="button"
                      onClick={() => {
                        setSeed({ text: p, key: Date.now() })
                        setStarter(null)
                      }}
                      className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-hover"
                    >
                      <span className="min-w-0 flex-1 truncate">{p}</span>
                      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {!open && (recent.length > 0 || upcoming) && (
            <section aria-label="继续" className="mt-10 max-md:hidden">
              <h2 className="mb-2 px-1 text-xs font-medium text-muted-foreground">继续上次的</h2>
              <div className="grid gap-2.5 sm:grid-cols-3">
                {recent.slice(0, upcoming ? 2 : 3).map((t) => (
                  <Link key={t.id} to={{ name: 'chat', id: t.id }} className="group flex min-h-21 flex-col justify-between rounded-2xl border bg-card p-3.5 transition-[border-color,box-shadow] hover:border-input hover:shadow-float">
                    <span className="line-clamp-2 text-sm font-medium">{t.title || '新对话'}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <MessageCircle className="size-3.5" /> {formatTime(t.updatedAt)}
                    </span>
                  </Link>
                ))}
                {upcoming && (
                  <Link to={{ name: 'automations' }} className="flex min-h-21 flex-col justify-between rounded-2xl border bg-card p-3.5 transition-[border-color,box-shadow] hover:border-input hover:shadow-float">
                    <span className="line-clamp-2 text-sm font-medium">{upcoming.name || upcoming.prompt}</span>
                    <span className="flex items-center gap-1.5 text-xs text-accent">
                      <Timer className="size-3.5" /> 下次运行 {formatTime(upcoming.nextRunAt!)}
                    </span>
                  </Link>
                )}
              </div>
            </section>
          )}
          <div className="pt-1 max-md:order-4 md:mt-6 md:pt-4">{footnote}</div>
        </div>
      </div>
    </div>
  )
}
