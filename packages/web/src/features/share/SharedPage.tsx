// The public page of a share link (roadmap-7 B2): no sign-in, no socket. It reads the snapshot from
// `GET /api/share/:token` and draws it read-only; generative UI shows but cannot call tools.
import type { SharedBlock, SharedPage as Shared } from '@gense/protocol'
import { Globe, LinkIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { formatTime } from '../../lib/format'
import { views } from '../../plugins'
import type { ViewHost } from '../../plugins/types'
import { Button } from '../../ui/button'
import { Empty, Skeleton } from '../../ui/feedback'
import { Logo } from '../../ui/logo'
import { Markdown } from '../chat/Markdown'
import { sharedViews } from './snapshot'

const readOnly = () => Promise.reject(new Error('公开页面里不能操作'))
const host: ViewHost = { callTool: readOnly, sendMessage: () => {}, requestDisplayMode: () => {}, setViewState: () => {}, readFile: readOnly }

export function SharedPage({ token }: { token: string }) {
  const [page, setPage] = useState<Shared | 'missing' | 'error' | null>(null)

  useEffect(() => {
    // Search engines stay out (B4); the server sends X-Robots-Tag too.
    const meta = Object.assign(document.createElement('meta'), { name: 'robots', content: 'noindex, nofollow' })
    document.head.append(meta)
    api<Shared>(`/api/share/${encodeURIComponent(token)}`).then(
      (p) => {
        setPage(p)
        document.title = `${p.title} · Gense`
      },
      (e: unknown) => setPage(e instanceof ApiError && e.status === 404 ? 'missing' : 'error'),
    )
    return () => meta.remove()
  }, [token])

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-13 max-w-3xl items-center gap-2.5 px-4 md:px-6">
          <a href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <Logo className="size-6" /> Gense
          </a>
          <span className="flex-1" />
          <Button size="sm" variant="primary" asChild>
            <a href="/">开始你自己的对话</a>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pt-8 pb-20 md:px-6">
        {page === null ? (
          <div aria-busy className="flex flex-col gap-6">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="ml-auto h-10 w-2/5 rounded-3xl" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : page === 'missing' ? (
          <Empty icon={<LinkIcon />} title="这个链接已失效" className="mt-16">
            分享者可能已经停止分享，或者链接不完整。
          </Empty>
        ) : page === 'error' ? (
          <Empty icon={<LinkIcon />} title="暂时打不开" className="mt-16">
            网络或服务器出了点问题，请稍后刷新重试。
          </Empty>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{page.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              分享的对话快照 · {formatTime(page.updatedAt)} · {page.turns.length} 轮
            </p>
            <div className="mt-8 flex flex-col gap-10">
              {page.turns.map((t, i) => (
                <section key={i} className="flex flex-col gap-5">
                  {t.question.trim() && (
                    <div className="max-w-[85%] self-end rounded-3xl rounded-br-md bg-bubble px-4.5 py-2.5 leading-relaxed break-words whitespace-pre-wrap">{t.question}</div>
                  )}
                  <div className="flex min-w-0 flex-col gap-3">
                    {t.answer.map((b, j) => (
                      <Block key={j} block={b} />
                    ))}
                  </div>
                  {t.sources && t.sources.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {t.sources.map((s) => (
                        <li key={s.url}>
                          <a href={s.url} target="_blank" rel="noreferrer noopener nofollow" className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-full border px-2.5 text-xs text-muted-foreground hover:bg-hover hover:text-foreground">
                            <Globe className="size-3.5 shrink-0" /> <span className="truncate">{s.title || new URL(s.url).hostname}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
            <p className="mt-16 border-t pt-4 text-center text-xs text-muted-foreground">内容由 AI 生成，可能有误。分享者可以随时停止分享。</p>
          </>
        )}
      </main>
    </div>
  )
}

function Block({ block: b }: { block: SharedBlock }) {
  if (b.kind === 'text') return <Markdown text={b.text} />
  if (b.kind === 'image')
    return (
      <figure className="w-full max-w-md">
        {/^data:image\/(png|jpeg|webp|gif);base64,/.test(b.src) && <img src={b.src} alt={b.alt} className="block w-full rounded-xl border" />}
        {b.alt && <figcaption className="mt-1.5 truncate text-xs text-muted-foreground">{b.alt}</figcaption>}
      </figure>
    )
  // Only views that draw from their own input and result; anything else in a snapshot is ignored.
  const View = sharedViews.has(b.uri) ? views[b.uri] : undefined
  if (!View) return null
  return <View toolInput={b.input} toolResult={b.result} displayMode="inline" host={host} />
}
