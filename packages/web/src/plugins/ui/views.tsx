import { lazy, Suspense } from 'react'
import type { ViewProps } from '../types'

// Renders `ui_render` programs (docs/plans/openui.md). The OpenUI renderer and component library load on first use,
// so a conversation without the ui plugin never downloads them.

export type UiInput = { program?: string; blocks?: unknown }
export type UiState = Record<string, unknown>

const Render = lazy(() => import('./render'))

export function UiView(props: ViewProps<UiInput, unknown, UiState>) {
  const program = props.toolInput?.program
  if (typeof program !== 'string') {
    // Calls from before OpenUI carried a component tree (`blocks`), which this version no longer draws.
    return props.toolInput?.blocks ? <div className="genui-note">旧版界面，已不支持显示。</div> : null
  }
  return (
    <Suspense fallback={<div className="genui-note">正在加载界面…</div>}>
      <Render {...props} program={program} />
    </Suspense>
  )
}
