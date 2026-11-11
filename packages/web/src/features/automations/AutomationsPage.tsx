// Schedules (R49) and webhooks (R50): both send a conversation an Event, which it answers like a message.
import type { ScheduleInfo, ScheduleRule, WebhookInfo } from '@gense/protocol'
import { Clock, Plus, RefreshCw, Trash2, Webhook } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { report, useClient, useHost } from '../../app/client'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { errorText, formatTime } from '../../lib/format'
import { Link } from '../../lib/router'
import { Button } from '../../ui/button'
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter } from '../../ui/dialog'
import { Empty, Notice } from '../../ui/feedback'
import { Field, Input, Textarea } from '../../ui/input'
import { Select, type SelectOption } from '../../ui/select'
import { Switch } from '../../ui/switch'
import { Tooltip } from '../../ui/tooltip'
import { Markdown } from '../chat/Markdown'

const weekdays = ['日', '一', '二', '三', '四', '五', '六']

function ruleText(rule: ScheduleRule) {
  switch (rule.kind) {
    case 'once':
      return `仅一次 · ${formatTime(rule.at)}`
    case 'daily':
      return `每天 ${rule.time}`
    case 'weekly':
      return `每周${[...rule.days].sort().map((d) => weekdays[d]).join('、')} ${rule.time}`
    case 'interval':
      return rule.minutes % 60 === 0 ? `每 ${rule.minutes / 60} 小时` : `每 ${rule.minutes} 分钟`
  }
}

function Section({ title, description, action, children }: { title: string; description: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

const card = 'divide-y overflow-hidden rounded-2xl border bg-card'

export default function AutomationsPage() {
  const client = useClient()
  const { schedules, webhooks, canCreateWebhooks, trees } = useHost()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [adding, setAdding] = useState(false)
  const [hook, setHook] = useState(false)
  const [created, setCreated] = useState<{ webhook: WebhookInfo; secret: string } | null>(null)
  const [removing, setRemoving] = useState<ScheduleInfo | WebhookInfo | null>(null)

  // Conversations that share a title also show when they were last active, so the pickers can tell them apart.
  const chats = useMemo<SelectOption[]>(() => {
    const list = [...(trees ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
    const name = (t: (typeof list)[number]) => t.title || '新对话'
    return list.map((t) => ({ value: t.id, label: list.filter((x) => name(x) === name(t)).length > 1 ? `${name(t)} · ${formatTime(t.updatedAt)}` : name(t) }))
  }, [trees])
  const title = (id: string) => chats.find((c) => c.value === id)?.label ?? '已删除的对话'
  const free = chats.filter((c) => !webhooks.some((w) => w.treeId === c.value))

  const generate = (treeId: string) =>
    client.request<{ webhook: WebhookInfo; secret: string }>({ t: 'webhook.create', treeId }).then((r) => {
      setHook(false)
      setCreated(r)
    })

  return (
    <Page title="自动化" description="到点或有外部事件时，把一条事件发进对话，助手像回答消息一样处理它。">
      <Section
        title="定时任务"
        description={`按 ${tz} 时区执行。`}
        action={
          <Button variant="primary" disabled={!chats.length} onClick={() => setAdding(true)}>
            <Plus /> 新建
          </Button>
        }
      >
        {schedules.length === 0 ? (
          <Empty icon={<Clock />} title="还没有定时任务">
            {chats.length ? '例如每天早上让助手汇总待办。也可以直接在对话里说"每天 9 点提醒我…"。' : '先开始一个对话，再为它创建定时任务。'}
          </Empty>
        ) : (
          <ul className={card}>
            {schedules.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="truncate text-sm text-muted-foreground">
                    {ruleText(s.rule)} ·{' '}
                    <Link to={{ name: 'chat', id: s.treeId }} className="hover:text-foreground hover:underline">
                      {title(s.treeId)}
                    </Link>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {s.enabled ? (s.nextRunAt !== null ? `下次 ${formatTime(s.nextRunAt)}` : '不再执行') : '已暂停'}
                    {s.lastRunAt !== null && (
                      <span className={cn(s.lastResult.startsWith('失败') && 'text-destructive')}>
                        {' '}
                        · 上次 {formatTime(s.lastRunAt)}：{s.lastResult}
                      </span>
                    )}
                  </div>
                </div>
                <Switch checked={s.enabled} aria-label={`启用 ${s.name}`} onCheckedChange={(enabled) => void client.request({ t: 'schedule.update', scheduleId: s.id, enabled }).catch(report)} />
                <Tooltip label="删除">
                  <Button variant="ghost-destructive" size="icon-sm" aria-label={`删除 ${s.name}`} onClick={() => setRemoving(s)}>
                    <Trash2 />
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Webhook"
        description="外部服务（CI、监控、表单）用签名的 POST 请求给对话发事件。每个对话一个地址。"
        action={
          <Button disabled={!canCreateWebhooks || !free.length} onClick={() => setHook(true)}>
            <Plus /> 生成
          </Button>
        }
      >
        {!canCreateWebhooks && (
          <Notice tone="warning" className="mb-3">
            服务器没有配置 TOKEN_ENCRYPTION_KEY，不能生成 Webhook（它的密钥要加密保存）。配置后重启服务器。
          </Notice>
        )}
        {webhooks.length === 0 ? (
          <Empty icon={<Webhook />} title="还没有 Webhook">
            生成后会得到一个地址和一个只显示一次的密钥。
          </Empty>
        ) : (
          <ul className={card}>
            {webhooks.map((w) => (
              <li key={w.id} className="flex items-center gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link to={{ name: 'chat', id: w.treeId }} className="block truncate font-medium hover:underline">
                    {title(w.treeId)}
                  </Link>
                  <code className="block truncate font-mono text-xs text-muted-foreground">{location.origin + w.path}</code>
                  <div className="mt-0.5 text-xs text-muted-foreground">{w.lastUsedAt ? `上次调用 ${formatTime(w.lastUsedAt)}` : '还没有调用过'}</div>
                </div>
                <Tooltip label="生成新的地址和密钥，旧的立即失效">
                  <Button variant="ghost" size="icon-sm" aria-label="重新生成" disabled={!canCreateWebhooks} onClick={() => void generate(w.treeId).catch(report)}>
                    <RefreshCw />
                  </Button>
                </Tooltip>
                <Tooltip label="删除">
                  <Button variant="ghost-destructive" size="icon-sm" aria-label="删除 Webhook" onClick={() => setRemoving(w)}>
                    <Trash2 />
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent title="新建定时任务" description="到点时，下面的内容会作为事件发进所选对话。">
          {adding && <ScheduleForm chats={chats} tz={tz} onDone={() => setAdding(false)} />}
        </DialogContent>
      </Dialog>

      <Dialog open={hook} onOpenChange={setHook}>
        <DialogContent title="生成 Webhook" description="选择接收事件的对话。" className="sm:max-w-md">
          {hook && <WebhookForm chats={free} onGenerate={generate} onCancel={() => setHook(false)} />}
        </DialogContent>
      </Dialog>

      <Dialog open={!!created} onOpenChange={(open) => !open && setCreated(null)}>
        <DialogContent title="保存这个密钥" description="密钥只显示这一次；服务器只保存加密后的它。" className="sm:max-w-2xl" onInteractOutside={(e) => e.preventDefault()}>
          {created && <WebhookSecret url={location.origin + created.webhook.path} secret={created.secret} onClose={() => setCreated(null)} />}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing && 'name' in removing ? `删除「${removing.name}」？` : '删除这个 Webhook？'}
        confirm="删除"
        onConfirm={() => {
          if (!removing) return
          void client.request('name' in removing ? { t: 'schedule.delete', scheduleId: removing.id } : { t: 'webhook.delete', webhookId: removing.id }).catch(report)
        }}
      >
        {removing && 'name' in removing ? '它不会再执行。' : '它的地址立即失效，外部服务的请求会被拒绝。'}
      </ConfirmDialog>
    </Page>
  )
}

function ScheduleForm({ chats, tz, onDone }: { chats: SelectOption[]; tz: string; onDone: () => void }) {
  const client = useClient()
  const [treeId, setTreeId] = useState(chats[0]?.value ?? '')
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<ScheduleRule['kind']>('daily')
  const [time, setTime] = useState('09:00')
  const [days, setDays] = useState<number[]>([1])
  const [minutes, setMinutes] = useState('60')
  const [at, setAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rule = (): ScheduleRule => {
    switch (kind) {
      case 'once':
        return { kind, at: new Date(at).getTime() }
      case 'daily':
        return { kind, time }
      case 'weekly':
        return { kind, days, time }
      case 'interval':
        return { kind, minutes: Number(minutes) }
    }
  }
  const past = kind === 'once' && !!at && new Date(at).getTime() <= Date.now()
  const valid =
    !!treeId && !!name.trim() && !!prompt.trim() && (kind !== 'once' || (!!at && !past)) && (kind !== 'weekly' || days.length > 0) && (kind !== 'interval' || Number(minutes) >= 5)

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        client.request({ t: 'schedule.create', treeId, name: name.trim(), prompt: prompt.trim(), rule: rule(), tz }).then(onDone, (err: unknown) => {
          setBusy(false)
          setError(errorText(err))
        })
      }}
    >
      <DialogBody className="flex flex-col gap-4">
        <Field label="名称">
          <Input value={name} autoFocus maxLength={80} placeholder="例如：每日简报" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="发到对话">
          <Select label="发到对话" value={treeId} options={chats} onChange={setTreeId} />
        </Field>
        <Field label="内容" help="到点时助手收到的话。">
          <Textarea rows={3} value={prompt} placeholder="例如：汇总今天的待办和日程" onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="重复">
            <Select
              label="重复"
              value={kind}
              options={[
                { value: 'daily', label: '每天' },
                { value: 'weekly', label: '每周' },
                { value: 'interval', label: '按间隔' },
                { value: 'once', label: '仅一次' },
              ]}
              onChange={(v) => setKind(v as ScheduleRule['kind'])}
            />
          </Field>
          {(kind === 'daily' || kind === 'weekly') && (
            <Field label="时间">
              <Input type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          )}
          {kind === 'interval' && (
            <Field label="间隔（分钟）" help="至少 5 分钟。">
              <Input type="number" min={5} step={5} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </Field>
          )}
          {kind === 'once' && (
            <Field label="执行时间" error={past ? '这个时间已经过去了。' : null}>
              <Input type="datetime-local" value={at} aria-invalid={past} onChange={(e) => setAt(e.target.value)} />
            </Field>
          )}
        </div>
        {kind === 'weekly' && (
          <div role="group" aria-label="星期" className="flex flex-wrap gap-1.5">
            {weekdays.map((d, i) => (
              <button
                key={d}
                type="button"
                aria-pressed={days.includes(i)}
                onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i])}
                className={cn('size-9 rounded-full border text-sm transition-colors', days.includes(i) ? 'border-transparent bg-primary text-primary-foreground' : 'hover:bg-hover')}
              >
                {d}
              </button>
            ))}
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          创建
        </Button>
      </DialogFooter>
    </form>
  )
}

function WebhookForm({ chats, onGenerate, onCancel }: { chats: SelectOption[]; onGenerate: (treeId: string) => Promise<void>; onCancel: () => void }) {
  const [treeId, setTreeId] = useState(chats[0]?.value ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <DialogBody className="flex flex-col gap-3">
        <Select label="对话" value={treeId} options={chats} onChange={setTreeId} />
        {error && <Notice tone="error">{error}</Notice>}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onCancel}>取消</Button>
        <Button
          variant="primary"
          disabled={busy || !treeId}
          onClick={() => {
            setBusy(true)
            onGenerate(treeId).catch((e: unknown) => {
              setBusy(false)
              setError(errorText(e))
            })
          }}
        >
          生成
        </Button>
      </DialogFooter>
    </>
  )
}

/** The secret is shown only here, once; the server keeps it sealed. */
function WebhookSecret({ url, secret, onClose }: { url: string; secret: string; onClose: () => void }) {
  const example = [
    `BODY='{"title":"部署完成","text":"v1.2 已上线"}'`,
    `TS=$(date +%s)`,
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac '${secret}' | sed 's/^.* //')`,
    `curl -X POST '${url}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H "x-gense-timestamp: $TS" -H "x-gense-signature: sha256=$SIG" \\`,
    `  -d "$BODY"`,
  ].join('\n')
  return (
    <>
      <DialogBody className="flex flex-col gap-3 text-sm">
        <p>
          请求要带上时间戳和 HMAC-SHA256 签名；可选的 <code className="font-mono text-[13px]">idempotency-key</code> 头能防止重复投递。下面的例子已经填好地址和密钥：
        </p>
        <Markdown text={'```sh\n' + example + '\n```'} />
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          我已保存
        </Button>
      </DialogFooter>
    </>
  )
}
