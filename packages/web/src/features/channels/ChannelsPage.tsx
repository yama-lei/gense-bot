// Bot channels (Feishu): connection, who may talk to the bot, and what recently came in.
import type { ChannelInfo, ChannelStatus, TriggerDecision, TriggerInfo } from '@gense/protocol'
import { Bot, Copy, MessageSquare, RefreshCw, UserPlus, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { report, useClient, useHost } from '../../app/client'
import { Page } from '../../app/Shell'
import { copyText, errorText, formatTime } from '../../lib/format'
import { Link } from '../../lib/router'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { ConfirmDialog } from '../../ui/dialog'
import { Empty, Notice, Skeleton, Spinner } from '../../ui/feedback'
import { Switch } from '../../ui/switch'
import { SettingsForm } from '../plugins/SettingsForm'

type Variant = 'neutral' | 'accent' | 'success' | 'warning' | 'destructive'

const statuses: Record<ChannelStatus, { label: string; variant: Variant }> = {
  off: { label: '未启用', variant: 'neutral' },
  connecting: { label: '连接中', variant: 'accent' },
  ready: { label: '已连接', variant: 'success' },
  error: { label: '连接失败', variant: 'destructive' },
}

const decisions: Record<TriggerDecision, { label: string; variant: Variant }> = {
  accepted: { label: '已处理', variant: 'success' },
  rejected: { label: '已拒绝', variant: 'warning' },
  duplicate: { label: '重复', variant: 'neutral' },
  command: { label: '命令', variant: 'accent' },
}

export default function ChannelsPage() {
  const { channels } = useHost()
  return (
    <Page title="渠道" description="把助手接到聊天软件里：在那里 @ 它或私聊它，对话同步出现在这里。">
      {!channels ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      ) : channels.length === 0 ? (
        <Empty icon={<Bot />} title="这台服务器没有可用的渠道" />
      ) : (
        <div className="flex flex-col gap-12">
          {channels.map((c) => (
            <Channel key={c.id} channel={c} />
          ))}
        </div>
      )}
    </Page>
  )
}

const card = 'rounded-2xl border bg-card'

function Channel({ channel: c }: { channel: ChannelInfo }) {
  const client = useClient()
  const status = statuses[c.status]
  const owner = c.actors.find((a) => a.role === 'owner')
  return (
    <section className="flex flex-col gap-6">
      <div className={`${card} flex items-center gap-3 px-4 py-3.5`}>
        {c.bot?.avatar ? (
          <img src={c.bot.avatar} alt="" className="size-10 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
            <Bot className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <h2 className="font-semibold">{c.name}</h2>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <p className="truncate text-sm text-muted-foreground">{c.bot ? `机器人：${c.bot.name}` : c.description}</p>
        </div>
        <Switch checked={c.enabled} aria-label={`启用 ${c.name}`} onCheckedChange={(enabled) => void client.request({ t: 'channel.set', channelId: c.id, enabled }).catch(report)} />
      </div>
      {c.error && <Notice tone="error">{c.error}</Notice>}

      {c.settings.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold">连接设置</h3>
          <div className={`${card} p-4`}>
            <SettingsForm settings={c.settings} config={c.config} saveLabel="保存并重连" onSave={(change) => client.request({ t: 'channel.set', channelId: c.id, ...change })} />
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold">谁可以使用</h3>
        <p className="mt-0.5 mb-3 text-sm text-muted-foreground">只有配对的你和你允许的人能让机器人回答；其他人的消息会被拒绝并记录在下面。</p>
        {!owner && <Pairing channel={c} />}
        {c.actors.length > 0 && (
          <ul className={`${card} divide-y overflow-hidden`}>
            {c.actors.map((a) => (
              <Actor key={a.id} channelId={c.id} actor={a} />
            ))}
          </ul>
        )}
      </div>

      <Triggers channel={c} />
    </section>
  )
}

function Actor({ channelId, actor: a }: { channelId: string; actor: ChannelInfo['actors'][number] }) {
  const client = useClient()
  const [revoking, setRevoking] = useState(false)
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Users className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{a.name || a.id}</span>
          {a.role === 'owner' && <Badge variant="accent">你</Badge>}
        </div>
        <p className="text-xs text-muted-foreground">{formatTime(a.addedAt)} 加入</p>
      </div>
      <Button variant="ghost-destructive" size="sm" onClick={() => setRevoking(true)}>
        {a.role === 'owner' ? '解除配对' : '移除'}
      </Button>
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title={a.role === 'owner' ? '解除配对？' : `移除「${a.name || a.id}」？`}
        confirm={a.role === 'owner' ? '解除' : '移除'}
        onConfirm={() => void client.request({ t: 'channel.revoke', channelId, actorId: a.id }).catch(report)}
      >
        {a.role === 'owner' ? '机器人不再认得你的账号，需要重新配对才能使用。' : '机器人不再回答此人的消息。'}
      </ConfirmDialog>
    </li>
  )
}

/** The owner proves an account is theirs by sending a short-lived code to the bot. */
function Pairing({ channel: c }: { channel: ChannelInfo }) {
  const client = useClient()
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!pair) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pair])
  const left = pair ? Math.max(0, Math.ceil((pair.expiresAt - now) / 1000)) : 0

  const create = () => {
    setBusy(true)
    client
      .request<{ code: string; expiresAt: number }>({ t: 'channel.pair', channelId: c.id })
      .then((p) => {
        setNow(Date.now())
        setPair(p)
      }, report)
      .finally(() => setBusy(false))
  }

  if (!pair || left === 0)
    return (
      <Notice
        className="mb-3"
        title="还没有配对你的账号"
        action={
          <Button variant="primary" size="sm" disabled={busy || c.status !== 'ready'} onClick={create}>
            {busy ? <Spinner /> : null} {pair ? '重新生成' : '生成配对码'}
          </Button>
        }
      >
        {c.status === 'ready' ? (pair ? '配对码已过期。' : '生成配对码，然后私聊发给机器人。') : '先完成连接设置并启用，连接成功后再配对。'}
      </Notice>
    )
  return (
    <div className={`${card} mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5`}>
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          私聊{c.bot ? `「${c.bot.name}」` : '机器人'}，发送：
        </p>
        <code className="mt-1 block font-mono text-2xl font-semibold tracking-widest">/pair {pair.code}</code>
        <p className="mt-1 text-xs text-muted-foreground">
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} 后过期，只能用一次。
        </p>
      </div>
      <Button
        onClick={() =>
          void copyText(`/pair ${pair.code}`).then(
            () => toast.success('已复制'),
            report,
          )
        }
      >
        <Copy /> 复制
      </Button>
    </div>
  )
}

function Triggers({ channel: c }: { channel: ChannelInfo }) {
  const client = useClient()
  const [list, setList] = useState<TriggerInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const load = useCallback(() => {
    setLoading(true)
    client
      .request<TriggerInfo[]>({ t: 'triggers.list', channelId: c.id, limit: 30 })
      .then(
        (l) => {
          setList(l)
          setError(null)
        },
        (e: unknown) => setError(errorText(e)),
      )
      .finally(() => setLoading(false))
  }, [client, c.id])
  // Pairing or allowing someone changes the actors, and the list's "allow" buttons with them.
  useEffect(load, [load, c.actors.length, c.status])

  const known = new Set(c.actors.map((a) => a.id))
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">最近的消息</h3>
        <Button variant="ghost" size="sm" disabled={loading} onClick={load}>
          {loading ? <Spinner /> : <RefreshCw />} 刷新
        </Button>
      </div>
      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : !list ? (
        <Skeleton className="h-24 rounded-2xl" />
      ) : list.length === 0 ? (
        <Empty icon={<MessageSquare />} title="还没有收到消息" className="py-10">
          在{c.name}里私聊机器人，或在群里 @ 它。
        </Empty>
      ) : (
        <ul className={`${card} divide-y overflow-hidden`}>
          {list.map((t) => {
            const d = decisions[t.decision]
            return (
              <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                    <span className="font-medium">{t.actor.name || t.actor.id}</span>
                    <span className="text-muted-foreground">{t.thread.group ? `在 ${t.thread.label}` : '私聊'}</span>
                    <Badge variant={d.variant}>{d.label}</Badge>
                    <span className="text-xs text-muted-foreground">{formatTime(t.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-sm break-words text-muted-foreground">{t.text}</p>
                  {t.reason && <p className="mt-0.5 text-xs text-warning">{t.reason}</p>}
                </div>
                {t.treeId ? (
                  <Link to={{ name: 'chat', id: t.treeId }} className="shrink-0 text-sm text-accent hover:underline">
                    查看对话
                  </Link>
                ) : (
                  t.decision === 'rejected' &&
                  !known.has(t.actor.id) && (
                    <Button
                      size="sm"
                      className="shrink-0"
                      onClick={() =>
                        void client.request({ t: 'channel.allow', channelId: c.id, actorId: t.actor.id, name: t.actor.name }).then(() => toast.success(`已允许 ${t.actor.name || t.actor.id}`), report)
                      }
                    >
                      <UserPlus /> 允许此人
                    </Button>
                  )
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
