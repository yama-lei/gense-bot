import { Renderer, type ActionEvent } from '@openuidev/react-lang'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewProps } from '../types'
import { runLibraryAction } from './genui/actions'
import { library } from './genui/library'
import { setLookupHost } from './genui/lookup'
import type { UiInput, UiState } from './views'

const SAVE_DELAY = 400
const dark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches

/** The library reads its theme from data-theme; ours follows the system. */
function useTheme() {
  const [theme, setTheme] = useState(() => (dark() ? 'dark' : 'light'))
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const update = () => setTheme(query.matches ? 'dark' : 'light')
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return theme
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

/** What the user filled in, as lines under the message: form fields, page variables and the action's context. */
export function attachments(event: Pick<ActionEvent, 'formState' | 'params'>) {
  const lines: string[] = []
  for (const [key, value] of Object.entries(event.formState ?? {})) {
    if (key.startsWith('$')) {
      if (value != null && value !== '') lines.push(`${key.slice(1)}: ${show(value)}`)
    } else if (value && typeof value === 'object') {
      for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
        const v = entry && typeof entry === 'object' && 'value' in entry ? (entry as { value: unknown }).value : entry
        if (v != null && v !== '') lines.push(`${field}: ${show(v)}`)
      }
    }
  }
  if (event.params?.context !== undefined) lines.push(show(event.params.context))
  return lines
}

function webUrl(value: unknown) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export default function Render({ program, toolResult, viewState, host }: ViewProps<UiInput, unknown, UiState> & { program: string }) {
  const theme = useTheme()
  const [notice, setNotice] = useState('')
  setLookupHost(host.callTool)

  // Page state ($variables and form fields) survives a reload through viewState (R70).
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pending = useRef<UiState>(undefined)
  const flush = useCallback(() => {
    clearTimeout(timer.current)
    if (pending.current) host.setViewState(pending.current)
    pending.current = undefined
  }, [host])
  const onStateUpdate = useCallback(
    (state: UiState) => {
      pending.current = state
      clearTimeout(timer.current)
      timer.current = setTimeout(flush, SAVE_DELAY)
    },
    [flush],
  )
  useEffect(() => flush, [flush])

  const onAction = useCallback(
    (event: ActionEvent) => {
      const custom = runLibraryAction(event)
      if (custom) {
        void custom.then((ok) => setNotice(ok ? '已复制到剪贴板' : '复制失败'))
        return
      }
      if (event.type === 'open_url') {
        const url = webUrl(event.params?.url)
        if (url) window.open(url, '_blank', 'noopener,noreferrer')
        return
      }
      if (event.type !== 'continue_conversation' || !event.humanFriendlyMessage) return
      flush()
      const lines = attachments(event)
      host.sendMessage(lines.length ? `${event.humanFriendlyMessage}\n\n${lines.map((l) => `- ${l}`).join('\n')}` : event.humanFriendlyMessage)
    },
    [host, flush],
  )

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 2000)
    return () => clearTimeout(t)
  }, [notice])

  return (
    <div className="genui" data-theme={theme}>
      <Renderer
        response={program}
        library={library}
        isStreaming={!toolResult}
        initialState={viewState}
        onStateUpdate={onStateUpdate}
        onAction={onAction}
      />
      {notice && (
        <div className="genui-toast" role="status">
          {notice}
        </div>
      )}
    </div>
  )
}
