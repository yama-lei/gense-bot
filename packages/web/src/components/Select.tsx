import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconChevronDown, IconSearch } from './Icons'

// Dropdown in place of the native <select>, like ChatGPT's model menu: a listbox in a popover
// (a bottom sheet on phones), with groups, a second line per option, and search for long lists.

export interface SelectOption {
  value: string
  label: string
  description?: string
  /** Options with the same group are listed under one heading, in the order given. */
  group?: string
  tag?: string
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  /** Accessible name; also the title of the bottom sheet. */
  label: string
  /** `picker`: borderless, for toolbars. `field`: full width with a border, for forms. */
  variant?: 'picker' | 'field'
  strong?: boolean
  title?: string
  /** Shown next to the selected label in the trigger. */
  extra?: ReactNode
  /** Default: on when there are more than 10 options. */
  searchable?: boolean
}

const GAP = 6
const MARGIN = 8

export function Select({ value, options, onChange, label, variant = 'field', strong, title, extra, searchable }: Props) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
  const [sheet, setSheet] = useState(false)
  const search = searchable ?? options.length > 10
  const current = options.find((o) => o.value === value)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? options.filter((o) => [o.label, o.description, o.value].some((s) => s?.toLowerCase().includes(q))) : options
  }, [options, query])

  const show = () => {
    setQuery('')
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setSheet(window.matchMedia('(max-width: 767px)').matches)
    setStyle({ visibility: 'hidden' })
    setOpen(true)
  }
  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }
  const pick = (o: SelectOption | undefined) => {
    if (!o) return
    if (o.value !== value) onChange(o.value)
    close()
  }

  // Below the trigger when it fits, otherwise above (the composer sits at the bottom); kept inside the viewport.
  useLayoutEffect(() => {
    if (!open || sheet || !trigger.current || !pop.current) return
    const r = trigger.current.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - GAP - MARGIN
    const above = r.top - GAP - MARGIN
    const natural = pop.current.scrollHeight
    const up = natural > below && above > below
    const width = Math.max(pop.current.offsetWidth, r.width)
    const left = Math.min(Math.max(MARGIN, r.left), window.innerWidth - width - MARGIN)
    setStyle({
      left,
      minWidth: r.width,
      maxHeight: up ? above : below,
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    })
  }, [open, sheet])

  useEffect(() => {
    if (!open) return
    const onResize = () => close(false)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  // Focus once placed: the popover is measured while hidden, and hidden elements can't take focus.
  const placed = sheet || style.visibility !== 'hidden'
  useEffect(() => {
    if (open && placed) (pop.current?.querySelector('input') ?? list.current)?.focus({ preventScroll: true })
  }, [open, placed])

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const onKey = (e: KeyboardEvent) => {
    const last = shown.length - 1
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
      ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
      Home: () => setActive(0),
      End: () => setActive(last),
      Enter: () => pick(shown[active]),
      Escape: () => close(),
      Tab: () => close(),
    }
    // Home/End and Space stay with the search box while typing.
    if (search && (e.key === 'Home' || e.key === 'End')) return
    if (!search && e.key === ' ') return pick(shown[active])
    const fn = keys[e.key]
    if (!fn) return
    if (e.key !== 'Tab') e.preventDefault()
    fn()
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={variant === 'picker' ? 'picker' + (strong ? ' strong' : '') : 'select-field'}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}：${current?.label ?? value}`}
        title={title}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            show()
          }
        }}
      >
        <span className="ellipsis">{current?.label ?? value}</span>
        {extra}
        <IconChevronDown width={14} height={14} />
      </button>
      {open &&
        createPortal(
          <>
            <div className={'menu-scrim' + (sheet ? ' dim' : '')} onClick={() => close()} />
            <div ref={pop} className={'select-pop' + (sheet ? ' sheet' : '')} style={sheet ? undefined : style} onKeyDown={onKey}>
              {sheet && <div className="select-sheet-title">{label}</div>}
              {search && (
                <div className="select-search">
                  <IconSearch width={15} height={15} />
                  <input
                    value={query}
                    placeholder="搜索"
                    aria-controls={id}
                    aria-activedescendant={shown[active] ? `${id}-${active}` : undefined}
                    onChange={(e) => {
                      setQuery(e.target.value)
                      setActive(0)
                    }}
                  />
                </div>
              )}
              <div
                ref={list}
                id={id}
                role="listbox"
                aria-label={label}
                tabIndex={search ? -1 : 0}
                aria-activedescendant={shown[active] ? `${id}-${active}` : undefined}
                className="select-list"
              >
                {shown.map((o, i) => {
                  const heading = o.group && o.group !== shown[i - 1]?.group ? o.group : null
                  return (
                    <div key={o.value} role="presentation">
                      {heading && <div className="menu-label">{heading}</div>}
                      <div
                        id={`${id}-${i}`}
                        data-index={i}
                        role="option"
                        aria-selected={o.value === value}
                        className={'select-option' + (i === active ? ' active' : '')}
                        onMouseMove={() => i !== active && setActive(i)}
                        onClick={() => pick(o)}
                      >
                        <span className="select-option-main">
                          <span className="select-option-label">
                            {o.label}
                            {o.tag && <span className="tag">{o.tag}</span>}
                          </span>
                          {o.description && <span className="muted small">{o.description}</span>}
                        </span>
                        {o.value === value && <IconCheck width={16} height={16} />}
                      </div>
                    </div>
                  )
                })}
                {!shown.length && <div className="select-empty muted small">没有匹配的选项</div>}
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  )
}
