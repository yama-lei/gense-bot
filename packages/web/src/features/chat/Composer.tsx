import type { Effort, Mention } from '@gense/protocol'
import { ArrowUp, AtSign, Brain, Check, ChevronDown, CircleAlert, FileText, FolderOpen, MessageSquare, Paperclip, Puzzle, Slash, Square, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { localPrefs, modelKey, useClient, useHost, useLocalPrefs } from '../../app/client'
import { cn } from '../../lib/cn'
import { availableCommands, localSkillNames, toOutgoingCommand, type Command } from '../../lib/commands'
import { baseName, errorText } from '../../lib/format'
import { Link } from '../../lib/router'
import type { Attachment, Outgoing } from '../../lib/types'
import { Spinner } from '../../ui/feedback'
import { DropdownMenu, DropdownMenuCheckItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../../ui/menu'
import { Tooltip } from '../../ui/tooltip'

/** Reasoning effort, named by how hard the model thinks. */
export const effortLabel: Record<Effort, string> = { low: '快速', medium: '标准', high: '深度思考' }
const effortHint: Record<Effort, string> = { low: '少想一点，回答更快', medium: '多数问题够用', high: '难题多想一会儿' }

/** A file being attached: uploading, uploaded, or failed. */
interface Pending {
  key: string
  name: string
  file?: Attachment
  error?: string
}

type MentionOption = Mention & { hint?: string }
type MenuItem = { kind: 'command'; command: Command } | { kind: 'mention'; option: MentionOption }

/** Items per group in the `@` menu. */
const GROUP_SIZE = 5
const MAX_HEIGHT = 240
const mentionGroups: [Mention['kind'], string][] = [
  ['plugin', '插件'],
  ['workspace', '本会话的文件'],
  ['chat', '其他对话'],
]
const mentionIcon = { plugin: Puzzle, workspace: FolderOpen, chat: MessageSquare }

/** The `/` at the start of the message or the `@` before the caret, with what was typed after it. */
function triggerAt(text: string, caret: number, commandSet: boolean) {
  const before = text.slice(0, caret)
  const slash = /^\/(\S*)$/.exec(before)
  if (slash && !commandSet) return { kind: '/' as const, query: slash[1]!, start: 0 }
  const at = /(^|\s)@(\S*)$/.exec(before)
  if (at) return { kind: '@' as const, query: at[2]!, start: before.length - at[2]!.length - 1 }
  return null
}

/** What `/` and `@` offer here: commands, and the plugins, files of this conversation and other conversations to mention. */
function useSuggestions(treeId: string | undefined) {
  const host = useHost()
  const client = useClient()
  const files = treeId ? client.files(treeId) : undefined
  return useMemo(() => {
    const plugins = (host.plugins ?? []).filter((p) => p.enabled && p.available)
    const mentions: MentionOption[] = [
      ...plugins.map((p): MentionOption => ({ kind: 'plugin', id: p.id, label: p.name, hint: p.description })),
      ...(files ?? []).filter((f) => !f.readOnly).map((f): MentionOption => ({ kind: 'workspace', id: f.path, label: baseName(f.path), hint: f.path.replace(/^\/data\/sessions\/[^/]+\//, '') })),
      ...(host.trees ?? []).filter((t) => t.id !== treeId).map((t): MentionOption => ({ kind: 'chat', id: t.id, label: t.title })),
    ]
    return {
      commands: availableCommands(
        plugins.map((p) => p.id),
        host.skills ?? [],
        localSkillNames(files),
        !!treeId,
      ),
      mentions,
    }
  }, [host.plugins, host.skills, host.trees, files, treeId])
}

function menuItems(suggest: ReturnType<typeof useSuggestions>, trigger: NonNullable<ReturnType<typeof triggerAt>>): MenuItem[] {
  const q = trigger.query.toLowerCase()
  const hit = (...s: (string | undefined)[]) => !q || s.some((x) => x?.toLowerCase().includes(q))
  if (trigger.kind === '/') return suggest.commands.filter((c) => hit(c.label, c.hint, c.id)).map((command) => ({ kind: 'command', command }))
  return mentionGroups.flatMap(([kind]) =>
    suggest.mentions
      .filter((m) => m.kind === kind && hit(m.label, m.kind === 'workspace' ? m.hint : undefined))
      .slice(0, GROUP_SIZE)
      .map((option): MenuItem => ({ kind: 'mention', option })),
  )
}

interface Props {
  /** The conversation it writes to; absent on the home page, where sending starts one. */
  treeId?: string
  placeholder: string
  onSend: (message: Outgoing) => void
  busy?: boolean
  onStop?: () => void
  autoFocus?: boolean
  /** Text to start with, and a key that changes when it should be put in again. */
  seed?: { text: string; key: number }
}

export function Composer({ treeId, placeholder, onSend, busy, onStop, autoFocus, seed }: Props) {
  const client = useClient()
  const suggest = useSuggestions(treeId)
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Pending[]>([])
  const [command, setCommand] = useState<Command | null>(null)
  const [mentions, setMentions] = useState<Mention[]>([])
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  // A menu closed with Esc stays closed until the text before the caret changes.
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [text])

  useEffect(() => {
    if (!seed) return
    setText(seed.text)
    ref.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.key])

  // `@` offers this conversation's files; ask for them when the menu first needs them.
  useEffect(() => {
    if (treeId && focused && !client.files(treeId)) void client.refreshFiles(treeId).catch(() => {})
  }, [client, treeId, focused])

  const trigger = focused ? triggerAt(text, caret, !!command) : null
  const triggerKey = trigger && `${trigger.start}:${text.slice(0, caret)}`
  const items = trigger && triggerKey !== dismissed ? menuItems(suggest, trigger) : []
  const current = Math.min(active, Math.max(items.length - 1, 0))

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, items.length])

  const pick = (item: MenuItem) => {
    if (!trigger) return
    const rest = text.slice(0, trigger.start) + text.slice(caret)
    // Render the shortened text first, so the caret lands where the trigger was.
    flushSync(() => setText(rest))
    ref.current?.setSelectionRange(trigger.start, trigger.start)
    setCaret(trigger.start)
    setActive(0)
    if (item.kind === 'command') return setCommand(item.command)
    const { kind, id, label } = item.option
    if (!mentions.some((m) => m.kind === kind && m.id === id)) setMentions((ms) => [...ms, { kind, id, label }])
  }

  const attach = (picked: Iterable<File>) => {
    for (const file of picked) {
      const key = crypto.randomUUID()
      setFiles((fs) => [...fs, { key, name: file.name }])
      client.upload(file).then(
        (uploaded) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, file: uploaded } : f))),
        (e: unknown) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, error: errorText(e) } : f))),
      )
    }
  }

  const uploading = files.some((f) => !f.file && !f.error)
  const ready = files.flatMap((f) => (f.file ? [f.file] : []))
  const canSend = !busy && !uploading && (text.trim() !== '' || ready.length > 0 || !!command)

  const send = () => {
    if (!canSend) return
    onSend({
      text: text.trim(),
      ...(ready.length && { attachments: ready }),
      ...(command && { command: toOutgoingCommand(command) }),
      ...(mentions.length && { mentions }),
    })
    setText('')
    setFiles([])
    setCommand(null)
    setMentions([])
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((current + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(items[current]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(triggerKey)
        return
      }
    }
    if (e.key === 'Backspace' && !text && !e.repeat) {
      if (mentions.length) setMentions((ms) => ms.slice(0, -1))
      else if (command) setCommand(null)
      return
    }
    // A phone's Enter is a new line; its send key is the button.
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault()
      send()
    }
  }

  const onPaste = (e: ClipboardEvent) => {
    const pasted = [...e.clipboardData.files]
    if (!pasted.length) return
    e.preventDefault()
    attach(pasted)
  }

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? 0)
  const insert = (ch: string) => {
    const el = ref.current
    if (!el) return
    const at = el.selectionStart ?? text.length
    const lead = ch === '@' && at > 0 && !/\s/.test(text[at - 1]!) ? ' ' : ''
    const next = text.slice(0, at) + lead + ch + text.slice(at)
    flushSync(() => setText(next))
    el.focus()
    const pos = at + lead.length + 1
    el.setSelectionRange(pos, pos)
    setCaret(pos)
  }

  let group = ''
  return (
    <div className="relative">
      {items.length > 0 && (
        <div
          ref={list}
          role="listbox"
          aria-label={trigger?.kind === '/' ? '命令' : '提及'}
          className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-2xl bg-popover p-1 text-sm shadow-pop"
          // Keeps the textarea focused, so the pick lands where the caret was.
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.map((item, i) => {
            const heading = item.kind === 'mention' ? mentionGroups.find(([k]) => k === item.option.kind)![1] : i === 0 ? '命令' : group
            const showHeading = heading !== group
            group = heading
            const Icon = item.kind === 'command' ? Slash : mentionIcon[item.option.kind]
            const label = item.kind === 'command' ? item.command.label : item.option.label
            const hint = item.kind === 'command' ? item.command.hint : item.option.hint
            return (
              <div key={item.kind === 'command' ? item.command.id : `${item.option.kind}:${item.option.id}`}>
                {showHeading && <div className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">{heading}</div>}
                <div
                  role="option"
                  aria-selected={i === current}
                  className={cn('flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-1.5', i === current && 'bg-hover')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(item)}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="max-w-[45%] shrink-0 truncate font-medium">{label}</span>
                  {hint && <span className="min-w-0 flex-1 truncate text-muted-foreground">{hint}</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div
        className={cn(
          'rounded-3xl border border-input bg-card shadow-float transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-3 focus-within:ring-ring/15',
          dragging && 'border-ring ring-3 ring-ring/25',
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          attach(e.dataTransfer.files)
        }}
      >
        {(files.length > 0 || command || mentions.length > 0) && (
          <div className="flex flex-wrap gap-1.5 px-3.5 pt-3">
            {command && (
              <Chip tone="accent" icon={<Slash />} onRemove={() => setCommand(null)} label={command.label} title={command.hint} />
            )}
            {mentions.map((m) => {
              const Icon = mentionIcon[m.kind]
              return <Chip key={m.kind + m.id} icon={<Icon />} label={m.label} onRemove={() => setMentions((ms) => ms.filter((x) => x !== m))} />
            })}
            {files.map((f) => (
              <Chip
                key={f.key}
                tone={f.error ? 'error' : undefined}
                icon={f.error ? <CircleAlert /> : f.file ? <FileText /> : <Spinner className="size-3.5" />}
                label={f.name}
                title={f.error}
                onRemove={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}
              />
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          aria-label="消息"
          placeholder={placeholder}
          className="block w-full resize-none bg-transparent px-4.5 pt-3.5 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground"
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <div className="flex items-center gap-0.5 px-2 pt-1 pb-2">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              attach(e.target.files ?? [])
              e.target.value = ''
            }}
          />
          <ToolButton label="添加文件（最大 20 MB）" onClick={() => picker.current?.click()}>
            <Paperclip />
          </ToolButton>
          <ToolButton label="命令" onClick={() => insert('/')} disabled={!!command || text !== ''}>
            <Slash />
          </ToolButton>
          <ToolButton label="提及插件、文件或对话" onClick={() => insert('@')}>
            <AtSign />
          </ToolButton>
          <div className="min-w-0 flex-1" />
          <ModelPicker />
          {busy ? (
            <Tooltip label="停止">
              <button
                type="button"
                aria-label="停止"
                onClick={onStop}
                className="ml-1 grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/85"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            </Tooltip>
          ) : (
            <button
              type="button"
              aria-label="发送"
              disabled={!canSend}
              onClick={send}
              className="ml-1 grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground transition-colors hover:bg-accent/88 disabled:bg-muted disabled:text-muted-foreground"
            >
              {uploading ? <Spinner className="text-current" /> : <ArrowUp className="size-5" />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ToolButton({ label, children, ...props }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4.5"
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function Chip({ icon, label, title, tone, onRemove }: { icon: ReactNode; label: string; title?: string; tone?: 'accent' | 'error'; onRemove: () => void }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-7 max-w-56 items-center gap-1.5 rounded-lg bg-muted pr-1 pl-2 text-sm [&_svg]:size-3.5 [&_svg]:shrink-0',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'error' && 'bg-destructive-soft text-destructive',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      <button type="button" aria-label={`移除 ${label}`} onClick={onRemove} className="grid size-5 place-items-center rounded-md opacity-60 hover:bg-hover hover:opacity-100">
        <X />
      </button>
    </span>
  )
}

/** The model new messages go to and how hard it thinks; both are remembered in this browser. */
function ModelPicker() {
  const { models, defaultModel } = useHost()
  const client = useClient()
  const prefs = useLocalPrefs()
  const model = client.model()
  if (!models.length)
    return (
      <Link to={{ name: 'settings', section: 'models' }} className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-sm text-warning hover:bg-warning-soft">
        <CircleAlert className="size-4" /> 登录模型
      </Link>
    )
  const groups = Map.groupBy(models, (m) => m.provider)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-9 min-w-0 items-center gap-1 rounded-full px-3 text-sm text-muted-foreground outline-none transition-colors hover:bg-hover hover:text-foreground data-[state=open]:bg-hover">
        <span className="truncate">{model?.name ?? '选择模型'}</span>
        {prefs.effort !== 'medium' && <span className="hidden shrink-0 text-xs opacity-75 sm:inline">· {effortLabel[prefs.effort]}</span>}
        <ChevronDown className="size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-72">
        {[...groups].map(([provider, list]) => (
          <div key={provider}>
            <DropdownMenuLabel>{provider}</DropdownMenuLabel>
            {list.map((m) => (
              <DropdownMenuCheckItem
                key={modelKey(m)}
                checked={!!model && modelKey(model) === modelKey(m)}
                onSelect={() => localPrefs.set((p) => ({ ...p, model: defaultModel && modelKey(defaultModel) === modelKey(m) ? '' : modelKey(m) }))}
              >
                {m.name}
              </DropdownMenuCheckItem>
            ))}
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-1.5">
          <Brain className="size-3.5" /> 思考程度
        </DropdownMenuLabel>
        {(Object.keys(effortLabel) as Effort[]).map((e) => (
          <DropdownMenuItem key={e} onSelect={() => localPrefs.set((p) => ({ ...p, effort: e }))}>
            <span className="w-16 shrink-0">{effortLabel[e]}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{effortHint[e]}</span>
            {prefs.effort === e && <Check className="text-accent" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
