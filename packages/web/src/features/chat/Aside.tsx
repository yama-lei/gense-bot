// A side question ("btw"): asked about the shown branch with `/顺便问`, answered in a card above the composer. The
// answer never joins the conversation; closing the card drops it, and stops it if it is still streaming.
import { MessageCircleQuestion, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useClient } from '../../app/client'
import { errorText } from '../../lib/format'
import { Button } from '../../ui/button'
import { Spinner } from '../../ui/feedback'
import { Markdown } from './Markdown'

interface Aside {
  question: string
  text: string
  status: 'streaming' | 'done' | 'failed'
  error?: string
}

/** The side question of one chat: `ask` starts one (replacing any before it), `card` shows it. */
export function useAside(treeId: string) {
  const client = useClient()
  const [aside, setAside] = useState<Aside | null>(null)
  const cancel = useRef<(() => void) | null>(null)

  const close = useCallback(() => {
    cancel.current?.()
    cancel.current = null
    setAside(null)
  }, [])

  const ask = useCallback(
    (question: string) => {
      cancel.current?.()
      setAside({ question, text: '', status: 'streaming' })
      let live = true
      const call = client.btw(treeId, question, (text) => live && setAside((a) => (a && a.question === question ? { ...a, text } : a)))
      cancel.current = () => {
        live = false
        call.cancel()
      }
      call.done.then(
        (text) => live && setAside({ question, text, status: 'done' }),
        (e: unknown) => live && setAside((a) => ({ question, text: a?.text ?? '', status: 'failed', error: errorText(e) })),
      ).finally(() => {
        if (live) cancel.current = null
      })
    },
    [client, treeId],
  )

  // Another chat, or leaving this one, ends the question.
  useEffect(() => close, [treeId, close])

  return { ask, card: aside && <AsideCard aside={aside} onClose={close} /> }
}

function AsideCard({ aside, onClose }: { aside: Aside; onClose: () => void }) {
  return (
    <section aria-label="顺便问" className="mb-2 flex max-h-[min(50vh,28rem)] flex-col rounded-xl border bg-card text-sm shadow-float animate-in fade-in-0 slide-in-from-bottom-2">
      <header className="flex shrink-0 items-center gap-2 py-1.5 pr-1.5 pl-3 text-muted-foreground">
        <MessageCircleQuestion className="size-4 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate" title={aside.question}>
          <span className="font-medium text-foreground">顺便问</span> · {aside.question}
        </span>
        {aside.status === 'streaming' && <Spinner />}
        <Button size="icon-sm" variant="ghost" aria-label={aside.status === 'streaming' ? '停止并关闭' : '关闭'} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="min-h-0 overflow-y-auto px-3 pb-3" aria-live="polite">
        {aside.text ? <Markdown text={aside.text} streaming={aside.status === 'streaming'} /> : aside.status === 'streaming' && <p className="text-muted-foreground">正在想…</p>}
        {aside.status === 'failed' && <p className="mt-1 text-destructive">没能回答：{aside.error}</p>}
        <p className="mt-2 text-xs text-muted-foreground">这段回答不会加入对话，也不影响后续回复。</p>
      </div>
    </section>
  )
}
