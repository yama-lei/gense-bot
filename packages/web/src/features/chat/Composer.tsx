import type { Effort, Mention } from '@gense/protocol'
import {
  ArrowUp,
  AtSign,
  Brain,
  ChevronDown,
  CircleAlert,
  FileText,
  FolderOpen,
  Gauge,
  Globe,
  MessageSquare,
  Mic,
  Paperclip,
  Plus,
  Puzzle,
  Rabbit,
  Settings2,
  Slash,
  SlidersHorizontal,
  Sparkles,
  Square,
  Telescope,
  X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { localPrefs, modelKey, useClient, useHost, useLocalPrefs } from '../../app/client'
import { cn } from '../../lib/cn'
import { availableCommands, btwCommand, localSkillNames, toOutgoingCommand, type Command } from '../../lib/commands'
import { baseName, errorText } from '../../lib/format'
import { modKey } from '../../lib/hooks'
import { drafts, useLab } from '../../lib/lab'
import { Link, navigate } from '../../lib/router'
import type { Attachment, Outgoing } from '../../lib/types'
import { Badge } from '../../ui/badge'
import { Spinner } from '../../ui/feedback'
import { DropdownMenu, DropdownMenuCheckItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../../ui/menu'
import { Tooltip } from '../../ui/tooltip'
import { useDictation } from './speech'

/** Reasoning effort, named by how hard the model thinks. */
export const effortLabel: Record<Effort, string> = { low: '快速', medium: '标准', high: '深度思考' }
const effortHint: Record<Effort, string> = { low: '少想一点，回答更快', medium: '多数问题够用', high: '难题多想一会儿' }
const effortIcon: Record<Effort, ReactNode> = { low: <Rabbit />, medium: <Gauge />, high: <Brain /> }

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
const MAX_HEIGHT = 260
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
  /** Chips shown before the composer's own (the project a new conversation starts in). */
  lead?: ReactNode
  /** Where the unsent text is kept; defaults to the conversation, or `home`. */
  draftKey?: string
}

const saveDraft = (key: string, text: string) =>
  drafts.set((all) => {
    if ((all[key] ?? '') === text) return all
    const { [key]: _, ...rest } = all
    return text ? { ...rest, [key]: text } : rest
  })

export function Composer({ treeId, placeholder, onSend, busy, onStop, autoFocus, seed, lead, draftKey = treeId ?? 'home' }: Props) {
  const client = useClient()
  const suggest = useSuggestions(treeId)
  const { sendKey } = useLab()
  const [text, setText] = useState(() => drafts.get()[draftKey] ?? '')
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

  // What is typed and not sent survives a reload or a visit to another conversation. Saved a moment after typing
  // stops, and at once when the box goes away, so neither a sent message nor the last few keys are left behind.
  const latest = useRef(text)
  latest.current = text
  useEffect(() => {
    const timer = setTimeout(() => saveDraft(draftKey, text), 300)
    return () => clearTimeout(timer)
  }, [text, draftKey])
  useEffect(() => () => saveDraft(draftKey, latest.current), [draftKey])

  // `@` offers this conversation's files; ask for them when the menu first needs them.
  useEffect(() => {
    if (treeId && focused && !client.files(treeId)) void client.refreshFiles(treeId).catch(() => {})
  }, [client, treeId, focused])

  const dictation = useDictation((spoken) => setText((t) => (t && !/\s$/.test(t) ? `${t} ${spoken}` : t + spoken)))

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
    addMention(item.option)
  }

  const addMention = ({ kind, id, label }: Mention) => {
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
  // A side question needs its text, and can be asked while an answer is still being written.
  const aside = command?.id === btwCommand.id
  const canSend = aside ? text.trim() !== '' : !busy && !uploading && (text.trim() !== '' || ready.length > 0 || !!command)

  const send = () => {
    if (!canSend) return
    dictation.stop()
    if (aside) {
      onSend({ text: text.trim(), command: toOutgoingCommand(command) })
      setText('')
      saveDraft(draftKey, '')
      setCommand(null)
      return
    }
    onSend({
      text: text.trim(),
      ...(ready.length && { attachments: ready }),
      ...(command && { command: toOutgoingCommand(command) }),
      ...(mentions.length && { mentions }),
    })
    setText('')
    saveDraft(draftKey, '')
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
    if (e.key !== 'Enter' || e.shiftKey) return
    const mod = e.metaKey || e.ctrlKey
    // A phone's Enter is a new line; its send key is the button. ⌘/Ctrl+Enter always sends.
    if (mod || (sendKey === 'enter' && !matchMedia('(pointer: coarse)').matches)) {
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

  const research = suggest.commands.find((c) => c.id === 'research')
  const web = suggest.mentions.find((m) => m.kind === 'plugin' && m.id === 'web')
  const webOn = mentions.some((m) => m.kind === 'plugin' && m.id === 'web')
  const toolsOn = (command ? 1 : 0) + (webOn ? 1 : 0)

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
          <div className="flex gap-3 border-t px-2.5 pt-1.5 pb-1 text-[11px] text-muted-foreground">
            <span>↑↓ 选择</span>
            <span>↵ 确认</span>
            <span>Esc 关闭</span>
          </div>
        </div>
      )}

      <div
        className={cn(
          'relative rounded-[1.75rem] bg-card shadow-float ring-1 ring-input transition-shadow focus-within:shadow-pop focus-within:ring-ring/45',
          dragging && 'ring-2 ring-accent',
          dictation.listening && 'ring-2 ring-accent/60',
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
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-[1.75rem] bg-accent-soft/90 text-sm font-medium text-accent">
            <span className="flex items-center gap-2">
              <Paperclip className="size-4" /> 松手即可添加文件
            </span>
          </div>
        )}
        {(lead || files.length > 0 || command || mentions.length > 0) && (
          <div className="flex flex-wrap gap-1.5 px-3.5 pt-3">
            {lead}
            {command && <Chip tone="accent" icon={command.id === 'research' ? <Telescope /> : <Slash />} onRemove={() => setCommand(null)} label={command.label} title={command.hint} />}
            {mentions.map((m) => {
              const Icon = m.kind === 'plugin' && m.id === 'web' ? Globe : mentionIcon[m.kind]
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
          placeholder={dictation.listening ? '正在听…说完点一下麦克风' : dictation.transcribing ? '正在识别…' : placeholder}
          className="block w-full resize-none bg-transparent px-5 pt-4 pb-1 text-base leading-relaxed outline-none placeholder:text-muted-foreground"
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
        <div className="flex items-center gap-0.5 px-2.5 pt-1.5 pb-2.5">
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
          <DropdownMenu>
            <Tooltip label="添加文件、提及或命令" side="top">
              <DropdownMenuTrigger aria-label="添加" className={toolButton}>
                <Plus />
              </DropdownMenuTrigger>
            </Tooltip>
            <DropdownMenuContent align="start" side="top" className="w-60" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuItem onSelect={() => picker.current?.click()}>
                <Paperclip /> 上传文件
                <span className="ml-auto text-xs text-muted-foreground">最大 20 MB</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTimeout(() => insert('@'))}>
                <AtSign /> 提及插件、文件或对话
                <kbd className="ml-auto text-xs text-muted-foreground">@</kbd>
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!!command || text !== ''} onSelect={() => setTimeout(() => insert('/'))}>
                <Slash /> 命令与 Skill
                <kbd className="ml-auto text-xs text-muted-foreground">/</kbd>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate({ name: 'library' })}>
                <FolderOpen /> 浏览资料库
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger className={cn(toolButton, 'w-auto gap-1.5 px-2.5 text-sm', toolsOn > 0 && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent')}>
              <SlidersHorizontal />
              <span className="max-sm:hidden">工具</span>
              {toolsOn > 0 && <span className="text-xs font-semibold tabular-nums">{toolsOn}</span>}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-72" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuLabel>这条消息使用</DropdownMenuLabel>
              <ToolToggle
                icon={<Telescope />}
                label="深度研究"
                hint={research ? '多方检索、交叉核对，带来源' : '需要先启用「网页」插件'}
                disabled={!research}
                checked={command?.id === 'research'}
                onToggle={() => setCommand(command?.id === 'research' ? null : research!)}
              />
              <ToolToggle
                icon={<Globe />}
                label="联网搜索"
                hint={web ? '回答前先查网页' : '需要先启用「网页」插件'}
                disabled={!web}
                checked={webOn}
                onToggle={() => (webOn ? setMentions((ms) => ms.filter((m) => !(m.kind === 'plugin' && m.id === 'web'))) : addMention(web!))}
              />
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex items-center gap-1.5">
                始终生效
              </DropdownMenuLabel>
              <MemoryToggle />
              <SuggestionsToggle />
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate({ name: 'plugins' })}>
                <Settings2 /> 管理插件与 Skill
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="min-w-0 flex-1" />
          <ModelPicker />
          {dictation.supported && (
            <Tooltip label={dictation.listening ? '停止听写' : dictation.transcribing ? '正在识别' : '语音输入'} side="top">
              <button type="button" aria-label="语音输入" aria-pressed={dictation.listening} aria-busy={dictation.transcribing} disabled={dictation.transcribing} onClick={dictation.toggle} className={cn(toolButton, (dictation.listening || dictation.transcribing) && 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent', dictation.transcribing && 'animate-pulse')}>
                {dictation.listening ? <Wave /> : <Mic />}
              </button>
            </Tooltip>
          )}
          {busy && !aside ? (
            <Tooltip label="停止生成" side="top">
              <button type="button" aria-label="停止" onClick={onStop} className="ml-1 grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/85">
                <Square className="size-3.5 fill-current" />
              </button>
            </Tooltip>
          ) : (
            <Tooltip label={sendKey === 'enter' ? '发送 · ↵' : `发送 · ${modKey} ↵`} side="top">
              <button
                type="button"
                aria-label="发送"
                disabled={!canSend}
                onClick={send}
                className="ml-1 grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground transition-[background-color,transform] hover:bg-accent/88 active:scale-95 disabled:bg-muted disabled:text-muted-foreground"
              >
                {uploading ? <Spinner className="text-current" /> : <ArrowUp className="size-5" />}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
}

const toolButton =
  'inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-offset-[-2px] transition-colors hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-hover data-[state=open]:text-foreground [&_svg]:size-4.5 [&_svg]:shrink-0'

/** Three bars that move while the microphone listens. */
function Wave() {
  return (
    <span aria-hidden className="flex h-4 items-center gap-0.5">
      {[0, 0.15, 0.3].map((d) => (
        <span key={d} className="h-full w-0.5 origin-center animate-wave rounded-full bg-current" style={{ animationDelay: `${d}s` }} />
      ))}
    </span>
  )
}

function ToolToggle({ icon, label, hint, checked, disabled, onToggle }: { icon: ReactNode; label: string; hint: string; checked: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <DropdownMenuItem
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      onSelect={(e) => {
        e.preventDefault()
        onToggle()
      }}
      className="items-start py-2"
    >
      <span className={cn('mt-0.5', checked && 'text-accent')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <span className={cn('mt-1 h-4 w-7 shrink-0 rounded-full bg-input p-0.5 transition-colors', checked && 'bg-accent')}>
        <span className={cn('block size-3 rounded-full bg-card transition-transform', checked && 'translate-x-3')} />
      </span>
    </DropdownMenuItem>
  )
}

/** The account-wide memory switch (roadmap-7 A5); it applies to chats in Feishu too. */
function MemoryToggle() {
  const { prefs } = useHost()
  const client = useClient()
  const on = prefs?.useMemory ?? true
  return <ToolToggle icon={<Brain />} label="参考记忆" hint="回答时带上你让它记住的事" disabled={!prefs} checked={on} onToggle={() => client.setPrefs({ useMemory: !on })} />
}

/** Follow-up suggestions after each answer (roadmap-7 D2); the server skips generating them when off. */
function SuggestionsToggle() {
  const { prefs } = useHost()
  const client = useClient()
  const on = prefs?.suggestions ?? true
  return <ToolToggle icon={<Sparkles />} label="追问建议" hint="每个回答后给出可点的后续问题" disabled={!prefs} checked={on} onToggle={() => client.setPrefs({ suggestions: !on })} />
}

function Chip({ icon, label, title, tone, onRemove }: { icon: ReactNode; label: string; title?: string; tone?: 'accent' | 'error'; onRemove: () => void }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full bg-muted pr-1 pl-2.5 text-sm [&_svg]:size-3.5 [&_svg]:shrink-0',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'error' && 'bg-destructive-soft text-destructive',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      <button type="button" aria-label={`移除 ${label}`} onClick={onRemove} className="grid size-5 place-items-center rounded-full opacity-60 hover:bg-hover hover:opacity-100">
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
      <DropdownMenuTrigger className="inline-flex h-9 min-w-0 items-center gap-1 rounded-full px-3 text-sm text-muted-foreground outline-offset-[-2px] transition-colors hover:bg-hover hover:text-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground">
        <span className="truncate">{model?.name ?? '选择模型'}</span>
        {prefs.effort !== 'medium' && <span className="hidden shrink-0 text-xs opacity-75 sm:inline">· {effortLabel[prefs.effort]}</span>}
        <ChevronDown className="size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-80" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel>思考程度</DropdownMenuLabel>
        <div role="radiogroup" aria-label="思考程度" className="mx-1.5 mb-1 grid grid-cols-3 gap-0.5 rounded-xl bg-muted p-0.5">
          {(Object.keys(effortLabel) as Effort[]).map((e) => (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={prefs.effort === e}
              title={effortHint[e]}
              onClick={() => localPrefs.set((p) => ({ ...p, effort: e }))}
              className={cn('flex h-8 items-center justify-center gap-1.5 rounded-[10px] text-xs text-muted-foreground [&_svg]:size-3.5', prefs.effort === e && 'bg-card font-medium text-foreground shadow-float')}
            >
              {effortIcon[e]}
              {effortLabel[e]}
            </button>
          ))}
        </div>
        <p className="px-2.5 pb-1.5 text-xs text-muted-foreground">{effortHint[prefs.effort]}</p>
        <DropdownMenuSeparator />
        {[...groups].map(([provider, list]) => (
          <div key={provider}>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <span className="min-w-0 truncate">{list[0]!.providerName ?? provider}</span>
              {list[0]!.source && <Badge variant={list[0]!.source === 'shared' ? 'neutral' : 'accent'}>{list[0]!.source === 'shared' ? '共享' : '自带'}</Badge>}
            </DropdownMenuLabel>
            {list.map((m) => (
              <DropdownMenuCheckItem
                key={modelKey(m)}
                checked={!!model && modelKey(model) === modelKey(m)}
                onSelect={() => localPrefs.set((p) => ({ ...p, model: defaultModel && modelKey(defaultModel) === modelKey(m) ? '' : modelKey(m) }))}
              >
                <span className="flex items-center gap-2">
                  <span className="truncate">{m.name}</span>
                  {defaultModel && modelKey(defaultModel) === modelKey(m) && <span className="shrink-0 text-xs text-muted-foreground">默认</span>}
                </span>
              </DropdownMenuCheckItem>
            ))}
          </div>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate({ name: 'settings', section: 'models' })}>
          <Settings2 /> 管理模型
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

