import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Markdown } from '../../components/Markdown'
import type { ViewProps } from '../types'
import type { UiBlock, UiCard, UiChart, UiGrid, UiInput } from './schema'

// Renders `ui_render` trees with the app's styles (roadmap-2 R20/R21). The input was validated
// on the server, but old messages or a mock may still carry nodes this version does not know:
// those are skipped, never fatal.

type Node = UiBlock | UiCard | UiGrid
/** Labels of the buttons already pressed, by block path; a choice is made once. */
type State = { pressed?: Record<string, string> }

export function UiView({ toolInput, viewState, host }: ViewProps<UiInput, unknown, State>) {
  const pressed = viewState?.pressed ?? {}
  const press = (path: string, label: string, message: string) => {
    host.setViewState({ pressed: { ...pressed, [path]: label } })
    host.sendMessage(message)
  }
  const blocks = Array.isArray(toolInput?.blocks) ? toolInput.blocks : []
  return (
    <div className="gen-ui">
      {toolInput?.title && <h3 className="gen-title">{toolInput.title}</h3>}
      {blocks.map((b, i) => (
        <Block key={i} node={b} path={String(i)} pressed={pressed} onPress={press} />
      ))}
    </div>
  )
}

interface BlockProps {
  node: Node
  path: string
  pressed: Record<string, string>
  onPress: (path: string, label: string, message: string) => void
}

const httpsUrl = (u: unknown): u is string => typeof u === 'string' && /^https:\/\//i.test(u)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function Block({ node, path, pressed, onPress }: BlockProps): ReactNode {
  switch (node?.type) {
    case 'grid':
      return (
        <div className="gen-grid" style={{ ['--cols' as string]: Math.min(Math.max(node.columns ?? 3, 2), 4) }}>
          {(node.cards ?? []).map((c, i) => (
            <Block key={i} node={c} path={`${path}.${i}`} pressed={pressed} onPress={onPress} />
          ))}
        </div>
      )
    case 'card':
      return (
        <div className="gen-card">
          {httpsUrl(node.image) && <Img src={node.image} alt={node.title ?? ''} className="gen-card-img" />}
          {(node.title || node.subtitle) && (
            <div>
              {node.title && <div className="gen-card-title">{node.title}</div>}
              {node.subtitle && <div className="muted small">{node.subtitle}</div>}
            </div>
          )}
          {(node.blocks ?? []).map((b, i) => (
            <Block key={i} node={b} path={`${path}.${i}`} pressed={pressed} onPress={onPress} />
          ))}
        </div>
      )
    case 'heading':
      return <h4 className="gen-heading">{node.text}</h4>
    case 'text':
      return <Markdown text={String(node.text ?? '')} />
    case 'stat':
      return (
        <div className="gen-stat">
          <span className="muted small">{node.label}</span>
          <strong>{node.value}</strong>
          {(node.note || node.trend) && (
            <span className="muted small">
              {node.trend && { up: '↑ ', down: '↓ ', flat: '→ ' }[node.trend]}
              {node.note}
            </span>
          )}
        </div>
      )
    case 'badges':
      return (
        <div className="gen-badges">
          {strings(node.items).map((t, i) => (
            <span key={i} className="tag">
              {t}
            </span>
          ))}
        </div>
      )
    case 'list': {
      const items = strings(node.items).map((t, i) => <li key={i}>{t}</li>)
      return node.ordered ? <ol className="gen-list">{items}</ol> : <ul className="gen-list">{items}</ul>
    }
    case 'table':
      return <Table columns={strings(node.columns)} rows={Array.isArray(node.rows) ? node.rows : []} />
    case 'chart':
      return <Chart chart={node} />
    case 'image':
      return httpsUrl(node.url) ? <Img src={node.url} alt={node.alt ?? ''} className="gen-img" /> : null
    case 'link':
      return httpsUrl(node.url) || /^http:\/\//i.test(String(node.url)) ? (
        <a className="gen-link" href={node.url} target="_blank" rel="noreferrer noopener">
          {node.text || node.url} ↗
        </a>
      ) : null
    case 'callout': {
      const label = { info: '提示', success: '完成', warning: '注意', error: '错误' }[node.tone] ?? '提示'
      return (
        <div className={`gen-callout ${node.tone}`}>
          <strong>{label}</strong>
          <Markdown text={String(node.text ?? '')} />
        </div>
      )
    }
    case 'buttons': {
      const chosen = pressed[path]
      return (
        <div className="gen-buttons">
          {(node.items ?? []).map((b, i) => (
            <button key={i} className={'pill-btn' + (chosen === b.label ? ' chosen' : '')} disabled={chosen != null} onClick={() => onPress(path, b.label, b.message || b.label)}>
              {b.label}
            </button>
          ))}
        </div>
      )
    }
    default:
      return null
  }
}

function Img({ src, alt, className }: { src: string; alt: string; className: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? null : <img className={className} src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

function Table({ columns, rows }: { columns: string[]; rows: unknown[] }) {
  return (
    <div className="gen-table-wrap">
      <table className="gen-table">
        {columns.length > 0 && (
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {(Array.isArray(r) ? r : []).map((cell, j) => (
                <td key={j} className={typeof cell === 'number' ? 'num' : undefined}>
                  {typeof cell === 'number' ? fmt(cell) : String(cell ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---- Charts: hand-drawn SVG, one y-axis, colors from --series-N (validated categorical order) ----

const fmt = (n: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(n)
const fmtAxis = (n: number) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1, notation: Math.abs(n) >= 10_000 ? 'compact' : 'standard' }).format(n)
/** Shortens a label to about `chars` Latin-width characters (CJK counts double). */
function clip(text: string, chars: number) {
  let used = 0
  for (let i = 0; i < text.length; i++) {
    used += text.charCodeAt(i) > 0x2e80 ? 2 : 1
    if (used > chars) return text.slice(0, Math.max(i - 1, 1)) + '…'
  }
  return text
}
const color = (i: number) => `var(--series-${(i % 8) + 1})`
/** Pie slices beyond this fold into 其他. */
const MAX_SLICES = 8

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

/** Round tick values covering [min, max]. */
function ticks(min: number, max: number, count = 4): number[] {
  const span = max - min || Math.abs(max) || 1
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const out: number[] = []
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) out.push(+v.toFixed(10))
  return out
}

/** Bar with a 4px rounded data end and a square end on the baseline. */
function barPath(x: number, w: number, base: number, end: number) {
  const r = Math.min(4, w / 2, Math.abs(base - end))
  if (end <= base) return `M${x},${base}V${end + r}Q${x},${end} ${x + r},${end}H${x + w - r}Q${x + w},${end} ${x + w},${end + r}V${base}Z`
  return `M${x},${base}V${end - r}Q${x},${end} ${x + r},${end}H${x + w - r}Q${x + w},${end} ${x + w},${end - r}V${base}Z`
}

function cleanChart(c: UiChart) {
  const labels = strings(c.labels)
  const series = (Array.isArray(c.series) ? c.series : [])
    .slice(0, 8)
    .map((s) => ({ name: String(s?.name ?? ''), values: labels.map((_, i) => (typeof s?.values?.[i] === 'number' && Number.isFinite(s.values[i]) ? s.values[i] : null)) }))
  return { labels, series }
}

function Chart({ chart }: { chart: UiChart }) {
  const [asTable, setAsTable] = useState(false)
  const { labels, series } = cleanChart(chart)
  if (!labels.length || !series.length) return null
  const unit = chart.unit ? (/^[%‰°]/.test(chart.unit) ? chart.unit : ` ${chart.unit}`) : ''
  const columns = [chart.kind === 'pie' ? '类别' : '', ...series.map((s) => s.name || '数值')]
  const rows = labels.map((l, i) => [l, ...series.map((s) => (s.values[i] == null ? '' : s.values[i]!))])
  return (
    <figure className="gen-chart">
      <div className="gen-chart-head">
        {chart.title ? <figcaption>{chart.title}</figcaption> : <span />}
        <button className="pill-btn small" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
          {asTable ? '图表' : '表格'}
        </button>
      </div>
      {asTable ? <Table columns={columns} rows={rows} /> : chart.kind === 'pie' ? <Pie labels={labels} values={series[0].values} unit={unit} /> : <XYChart kind={chart.kind} labels={labels} series={series} unit={unit} />}
      {chart.kind !== 'pie' && series.length > 1 && !asTable && (
        <div className="gen-legend">
          {series.map((s, i) => (
            <span key={i}>
              <i style={{ background: color(i) }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </figure>
  )
}

type Series = { name: string; values: (number | null)[] }

function Tooltip({ x, width, title, rows }: { x: number; width: number; title: string; rows: { name: string; value: string; color: string }[] }) {
  const right = x > width / 2
  return (
    <div className="gen-tooltip" style={right ? { right: width - x + 12 } : { left: x + 12 }}>
      <strong>{title}</strong>
      {rows.map((r, i) => (
        <span key={i}>
          <i style={{ background: r.color }} />
          {r.name && <span className="muted">{r.name}</span>}
          <b>{r.value}</b>
        </span>
      ))}
    </div>
  )
}

function XYChart({ kind, labels, series, unit }: { kind: 'bar' | 'line'; labels: string[]; series: Series[]; unit: string }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const height = 220
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null))
  // Bars measure from zero; lines show change, so their axis hugs the data.
  const t = kind === 'bar' ? ticks(Math.min(0, ...all), Math.max(0, ...all)) : ticks(Math.min(...all), Math.max(...all))
  const [lo, hi] = [t[0], t.at(-1)!]
  const left = Math.max(...t.map((v) => fmtAxis(v).length)) * 7 + 10
  const top = 10
  const bottom = 24
  // Lines end in a direct value label (at most 4 series), pushed apart so they never overlap.
  const ends =
    kind === 'line' && series.length <= 4
      ? series.flatMap((s, si) => {
          const i = s.values.findLastIndex((v) => v != null)
          return i < 0 ? [] : [{ key: si, i, text: fmtAxis(s.values[i]!) }]
        })
      : []
  const right = ends.length ? Math.max(...ends.map((e) => e.text.length)) * 7 + 12 : 4
  const plotW = Math.max(width - left - right, 10)
  const plotH = height - top - bottom
  const y = (v: number) => top + plotH - ((v - lo) / (hi - lo || 1)) * plotH
  const band = plotW / labels.length
  const cx = (i: number) => left + band * (i + 0.5)
  const every = Math.ceil(44 / band)
  const single = series.length === 1
  // Values on the marks only while they stay readable.
  const showValues = single && labels.length <= 12 && band >= 36
  const endLabels = ends
    .map((e) => ({ ...e, x: cx(e.i), y: y(series[e.key].values[e.i]!) }))
    .sort((a, b) => a.y - b.y)
    .map((e, k, arr) => (k > 0 && e.y - arr[k - 1].y < 13 ? Object.assign(e, { y: arr[k - 1].y + 13 }) : e))

  return (
    <div ref={ref} className="gen-plot" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${kind === 'bar' ? '柱状图' : '折线图'}：${series.map((s) => s.name).join('、')}`}>
          {t.map((v) => (
            <g key={v}>
              <line x1={left} x2={left + plotW} y1={y(v)} y2={y(v)} className={v === 0 ? 'axis' : 'grid'} />
              <text x={left - 6} y={y(v)} dy="0.32em" textAnchor="end" className="tick">
                {fmtAxis(v)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            i % every === 0 ? (
              <text key={i} x={cx(i)} y={height - 6} textAnchor="middle" className="tick">
                {clip(l, Math.max(Math.floor((band * every - 6) / 7), 3))}
              </text>
            ) : null,
          )}
          {hover != null && <rect x={left + band * hover} y={top} width={band} height={plotH} className="hover-band" />}
          {kind === 'bar' &&
            series.map((s, si) => {
              // Thin marks: bars stay at most 28px wide, 2px apart within a group.
              const w = Math.max(Math.min((band * 0.72 - 2 * (series.length - 1)) / series.length, 28), 1)
              const group = w * series.length + 2 * (series.length - 1)
              return s.values.map((v, i) =>
                v == null ? null : (
                  <g key={`${si}-${i}`}>
                    <path d={barPath(cx(i) - group / 2 + si * (w + 2), w, y(0), y(v))} fill={color(si)} />
                    {showValues && (
                      <text x={cx(i)} y={v >= 0 ? y(v) - 5 : y(v) + 13} textAnchor="middle" className="value">
                        {fmtAxis(v)}
                      </text>
                    )}
                  </g>
                ),
              )
            })}
          {kind === 'line' &&
            series.map((s, si) => {
              const pts = s.values.map((v, i) => (v == null ? null : ([cx(i), y(v)] as const)))
              const d = pts.reduce((acc, p, i) => (p ? acc + `${acc && pts[i - 1] ? 'L' : 'M'}${p[0]},${p[1]}` : acc), '')
              return (
                <g key={si}>
                  <path d={d} fill="none" stroke={color(si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {pts.map((p, i) => (p && (hover === i || labels.length <= 12) ? <circle key={i} cx={p[0]} cy={p[1]} r={4} fill={color(si)} className="marker" /> : null))}
                </g>
              )
            })}
          {endLabels.map((l) => (
            <text key={l.key} x={l.x + 8} y={l.y} dy="0.32em" className="value">
              {l.text}
            </text>
          ))}
          {labels.map((_, i) => (
            <rect key={i} x={left + band * i} y={0} width={band} height={height} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
          ))}
        </svg>
      )}
      {hover != null && (
        <Tooltip
          x={cx(hover)}
          width={width}
          title={labels[hover]}
          rows={series.map((s, i) => ({ name: single ? '' : s.name, value: s.values[hover] == null ? '—' : fmt(s.values[hover]!) + unit, color: color(i) }))}
        />
      )}
    </div>
  )
}

function Pie({ labels, values, unit }: { labels: string[]; values: (number | null)[]; unit: string }) {
  const [hover, setHover] = useState<number | null>(null)
  let slices = labels.map((name, i) => ({ name, value: values[i] ?? 0 })).filter((s) => s.value > 0)
  if (slices.length > MAX_SLICES) {
    const rest = slices.slice(MAX_SLICES - 1).reduce((a, s) => a + s.value, 0)
    slices = [...slices.slice(0, MAX_SLICES - 1), { name: '其他', value: rest }]
  }
  const total = slices.reduce((a, s) => a + s.value, 0)
  if (!total) return <p className="muted small">没有可以画成饼图的正数。</p>
  const size = 180
  const r = size / 2
  const inner = r * 0.58
  const starts = slices.map((_, i) => -Math.PI / 2 + (slices.slice(0, i).reduce((a, s) => a + s.value, 0) / total) * Math.PI * 2)
  const arcs = slices.map((s, i) => {
    const a0 = starts[i]
    const a1 = a0 + (s.value / total) * Math.PI * 2
    const large = a1 - a0 > Math.PI ? 1 : 0
    const p = (a: number, rad: number) => `${r + rad * Math.cos(a)},${r + rad * Math.sin(a)}`
    // A full circle cannot be one arc; split it in two.
    if (slices.length === 1) return `M${p(a0, r)}A${r},${r} 0 1 1 ${p(a0 + Math.PI, r)}A${r},${r} 0 1 1 ${p(a0, r)}M${p(a0, inner)}A${inner},${inner} 0 1 0 ${p(a0 + Math.PI, inner)}A${inner},${inner} 0 1 0 ${p(a0, inner)}Z`
    return `M${p(a0, r)}A${r},${r} 0 ${large} 1 ${p(a1, r)}L${p(a1, inner)}A${inner},${inner} 0 ${large} 0 ${p(a0, inner)}Z`
  })
  const pct = (v: number) => `${((v / total) * 100).toFixed(v / total < 0.1 ? 1 : 0)}%`
  return (
    <div className="gen-pie" onMouseLeave={() => setHover(null)}>
      <svg width={size} height={size} role="img" aria-label={`饼图：${slices.map((s) => `${s.name} ${pct(s.value)}`).join('，')}`}>
        {arcs.map((d, i) => (
          <path key={i} d={d} fill={color(i)} className={'slice' + (hover != null && hover !== i ? ' dim' : '')} fillRule="evenodd" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} />
        ))}
        <text x={r} y={r} textAnchor="middle" dy="0.32em" className="pie-center">
          {hover != null ? pct(slices[hover].value) : fmtAxis(total) + unit}
        </text>
      </svg>
      <ul className="gen-pie-legend">
        {slices.map((s, i) => (
          <li key={i} className={hover === i ? 'active' : undefined} onMouseEnter={() => setHover(i)}>
            <i style={{ background: color(i) }} />
            <span className="ellipsis">{s.name}</span>
            {unit !== '%' && (
              <span className="muted">
                {fmt(s.value)}
                {unit}
              </span>
            )}
            <b>{pct(s.value)}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}
