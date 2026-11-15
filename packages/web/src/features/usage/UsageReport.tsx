// Token and service usage for a date range (roadmap-7 C8, D6): everyone's in the admin back office
// (`/api/admin/usage`), the signed-in user's own in Settings (`/api/usage`). Same report, same table.
import type { ServiceKind, UsageReport as Report, UsageSummary } from '@gense/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/format'
import { Badge } from '../../ui/badge'
import { Empty, Notice, Skeleton } from '../../ui/feedback'
import { Field, Input } from '../../ui/input'
import { Select } from '../../ui/select'

/** Loads `path` when it changes and on `reload()`; `data` stays until the next load succeeds. Null loads nothing. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(
    async () =>
      path &&
      api<T>(path).then(
        (d) => {
          setData(d)
          setError(null)
        },
        (e) => setError(errorText(e)),
      ),
    [path],
  )
  useEffect(() => void reload(), [reload])
  return { data, error, reload, setData }
}

const utcDay = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat('zh-CN')

type GroupBy = 'user' | 'day' | 'model'
const groupLabels: Record<GroupBy, string> = { user: '按用户', day: '按天', model: '按模型' }
type Totals = Pick<UsageSummary, 'calls' | 'input' | 'output' | 'cacheRead' | 'totalTokens' | 'searches' | 'fetches'>
const columns: { key: keyof Totals; label: string }[] = [
  { key: 'calls', label: '调用' },
  { key: 'input', label: '输入' },
  { key: 'output', label: '输出' },
  { key: 'cacheRead', label: '缓存读取' },
  { key: 'searches', label: '搜索' },
  { key: 'fetches', label: '读网页' },
  { key: 'totalTokens', label: '合计 token' },
]
const zero = (): Totals => ({ calls: 0, input: 0, output: 0, cacheRead: 0, totalTokens: 0, searches: 0, fetches: 0 })
const add = (t: Totals, r: Totals) => {
  for (const c of columns) t[c.key] += r[c.key] ?? 0
  return t
}

const services: Record<ServiceKind, { label: string; unit: string }> = {
  ocr: { label: '文件识别（OCR）', unit: '页' },
  asr: { label: '语音听写', unit: '秒' },
  tts: { label: '朗读', unit: '字符' },
}

/** `everyone`: the admin's view, with a column per user available. */
export function UsageReport({ everyone }: { everyone?: boolean }) {
  const [from, setFrom] = useState(utcDay(-6))
  const [to, setTo] = useState(utcDay())
  const groups: GroupBy[] = everyone ? ['user', 'day', 'model'] : ['day', 'model']
  const [by, setBy] = useState<GroupBy>(groups[0]!)
  const valid = !!from && !!to && from <= to
  const { data, error } = useLoad<Report>(valid ? `${everyone ? '/api/admin/usage' : '/api/usage'}?from=${from}&to=${to}` : null)

  const rows = useMemo(() => {
    const out = new Map<string, { label: string; source?: UsageSummary['source']; totals: Totals }>()
    for (const r of data?.models ?? []) {
      const key = by === 'user' ? r.userId : by === 'day' ? r.day : `${r.source}:${r.provider}:${r.model}`
      // `web-tools`: searches and page reads the web plugin ran outside a model call.
      const label = by === 'user' ? r.email : by === 'day' ? r.day : r.model === 'web-tools' ? '联网工具' : r.model
      const g = out.get(key) ?? { label, ...(by === 'model' && { source: r.source }), totals: zero() }
      add(g.totals, r)
      out.set(key, g)
    }
    const list = [...out.values()]
    return by === 'day' ? list.sort((a, b) => b.label.localeCompare(a.label)) : list.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens)
  }, [data, by])
  const total = useMemo(() => rows.reduce((t, r) => add(t, r.totals), zero()), [rows])
  // Searches and page reads only show when something used them: most models never do.
  const shown = columns.filter((c) => (c.key !== 'searches' && c.key !== 'fetches') || total[c.key] > 0)

  const serviceRows = useMemo(() => {
    const out = new Map<ServiceKind, { calls: number; units: number }>()
    for (const s of data?.services ?? []) {
      const g = out.get(s.service) ?? { calls: 0, units: 0 }
      g.calls += s.calls
      g.units += s.units
      out.set(s.service, g)
    }
    return [...out.entries()]
  }, [data])

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="从" className="w-40">
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="到" className="w-40">
          <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {/* Not a Field: a label around the select's button would open it twice. */}
        <div className="flex w-32 flex-col gap-1.5 text-sm">
          <span className="font-medium">分组</span>
          <Select label="分组" value={by} onChange={(v) => setBy(v as GroupBy)} options={groups.map((g) => ({ value: g, label: groupLabels[g] }))} />
        </div>
      </div>
      {!valid ? (
        <Notice tone="warning">开始日期不能晚于结束日期。</Notice>
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : !data ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : rows.length === 0 && serviceRows.length === 0 ? (
        <Empty title="这段时间没有调用" className="py-10" />
      ) : (
        <div className="flex flex-col gap-4">
          {rows.length > 0 && (
            <div className="overflow-x-auto rounded-2xl border bg-card">
              <table className="w-full min-w-[34rem] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-4 py-2.5 font-medium">{groupLabels[by].slice(1)}</th>
                    {shown.map((c) => (
                      <th key={c.key} className="px-3 py-2.5 text-right font-medium">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => (
                    <tr key={`${r.label}:${r.source ?? ''}`}>
                      <td className="max-w-56 px-4 py-2.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate" title={r.label}>
                            {r.label}
                          </span>
                          {r.source && <Badge variant={r.source === 'shared' ? 'neutral' : 'accent'}>{r.source === 'shared' ? '共享' : '自带'}</Badge>}
                        </div>
                      </td>
                      {shown.map((c) => (
                        <Cell key={c.key} n={r.totals[c.key]} strong={c.key === 'totalTokens'} />
                      ))}
                    </tr>
                  ))}
                </tbody>
                {rows.length > 1 && (
                  <tfoot className="border-t font-medium">
                    <tr>
                      <td className="px-4 py-2.5">合计</td>
                      {shown.map((c) => (
                        <Cell key={c.key} n={total[c.key]} strong />
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          {serviceRows.length > 0 && (
            <div className="overflow-x-auto rounded-2xl border bg-card">
              <table className="w-full min-w-[24rem] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-4 py-2.5 font-medium">其他服务</th>
                    <th className="px-3 py-2.5 text-right font-medium">调用</th>
                    <th className="px-3 py-2.5 text-right font-medium">计量</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {serviceRows.map(([kind, s]) => (
                    <tr key={kind}>
                      <td className="px-4 py-2.5">{services[kind]?.label ?? kind}</td>
                      <Cell n={s.calls} />
                      <td className="px-3 py-2.5 text-right tabular-nums" title={full.format(s.units)}>
                        {compact.format(s.units)} {services[kind]?.unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Cell({ n, strong }: { n: number; strong?: boolean }) {
  return (
    <td className={cn('px-3 py-2.5 text-right tabular-nums', !strong && 'text-muted-foreground')} title={full.format(n)}>
      {compact.format(n)}
    </td>
  )
}
