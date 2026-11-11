import { CalendarClock, Code, Globe, LayoutDashboard, PenLine } from 'lucide-react'
import { useState } from 'react'
import { report, useClient, useHost } from '../../app/client'
import { SidebarToggle } from '../../app/Shell'
import { navigate } from '../../lib/router'
import type { Outgoing } from '../../lib/types'
import { Logo } from '../../ui/logo'
import { Composer } from './Composer'

const suggestions = [
  { icon: Globe, label: '查一查', text: '帮我搜索并总结：' },
  { icon: PenLine, label: '写点东西', text: '帮我起草一份' },
  { icon: Code, label: '写代码', text: '帮我写一段代码：' },
  { icon: LayoutDashboard, label: '做个页面', text: '用一个可交互的页面展示：' },
  { icon: CalendarClock, label: '定时提醒', text: '每天早上 9 点提醒我' },
]

function greeting(name: string) {
  const h = new Date().getHours()
  const part = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好'
  return name ? `${part}，${name}` : part
}

export const footnote = <p className="px-2 pt-2 text-center text-xs text-muted-foreground">GenseBot 可能出错，请核对重要信息。</p>

export function HomePage() {
  const client = useClient()
  const { prefs } = useHost()
  const [starting, setStarting] = useState(false)
  const [seed, setSeed] = useState<{ text: string; key: number }>()

  const start = (message: Outgoing) => {
    setStarting(true)
    client.start(message).then(
      (id) => navigate({ name: 'chat', id }),
      (e: unknown) => {
        setStarting(false)
        // The message is gone from the box; give its text back.
        setSeed({ text: message.text, key: Date.now() })
        report(e)
      },
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-13 shrink-0 items-center px-2 md:px-3">
        <SidebarToggle />
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-3 pb-6 md:justify-center md:px-6 md:pb-[14dvh]">
        <div className="flex w-full max-w-2xl flex-1 flex-col md:flex-none">
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 md:flex-none md:flex-row md:pt-0">
            <Logo className="size-9" />
            <h1 className="text-center font-serif text-3xl md:text-4xl">{greeting(prefs?.name.trim() ?? '')}</h1>
          </div>
          <Composer placeholder="有什么可以帮你？" onSend={start} busy={starting} autoFocus seed={seed} />
          <div className="mt-4 flex flex-wrap justify-center gap-2 max-md:order-first max-md:mt-0 max-md:mb-4">
            {suggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                onClick={() => setSeed({ text: s.text, key: Date.now() })}
                className="inline-flex h-9 items-center gap-1.5 rounded-full border bg-card px-3.5 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
              >
                <s.icon className="size-4" /> {s.label}
              </button>
            ))}
          </div>
          {footnote}
        </div>
      </div>
    </div>
  )
}
