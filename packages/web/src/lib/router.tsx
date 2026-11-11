// Path routes (roadmap-5 N45): /, /c/:treeId, /plugins, /automations, /channels, /settings, /admin (roadmap-6 D7). The server answers any
// unknown path with index.html, so a reload or a shared link lands on the same page.
import { useSyncExternalStore, type ComponentProps, type MouseEvent } from 'react'

export const settingsSections = ['personal', 'models', 'appearance', 'account'] as const
export type SettingsSection = (typeof settingsSections)[number]

export const adminSections = ['users', 'models', 'usage'] as const
export type AdminSection = (typeof adminSections)[number]

export type Route =
  | { name: 'home' }
  | { name: 'chat'; id: string }
  | { name: 'plugins'; tab?: 'skills' }
  | { name: 'automations' }
  | { name: 'channels' }
  | { name: 'settings'; section?: SettingsSection }
  | { name: 'admin'; section?: AdminSection }
  | { name: 'missing' }

export function parse(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  })
  if (!parts.length) return { name: 'home' }
  switch (parts[0]) {
    case 'c':
      return parts[1] ? { name: 'chat', id: parts[1] } : { name: 'home' }
    case 'plugins':
      return parts[1] === 'skills' ? { name: 'plugins', tab: 'skills' } : { name: 'plugins' }
    case 'automations':
      return { name: 'automations' }
    case 'channels':
      return { name: 'channels' }
    case 'settings': {
      const section = settingsSections.find((s) => s === parts[1])
      return section ? { name: 'settings', section } : { name: 'settings' }
    }
    case 'admin': {
      const section = adminSections.find((s) => s === parts[1])
      return section ? { name: 'admin', section } : { name: 'admin' }
    }
    default:
      return { name: 'missing' }
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'home':
    case 'missing':
      return '/'
    case 'chat':
      return `/c/${encodeURIComponent(route.id)}`
    case 'plugins':
      return route.tab ? '/plugins/skills' : '/plugins'
    case 'settings':
    case 'admin':
      return route.section ? `/${route.name}/${route.section}` : `/${route.name}`
    default:
      return `/${route.name}`
  }
}

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
window.addEventListener('popstate', emit)

export function navigate(route: Route, options: { replace?: boolean } = {}) {
  const to = href(route)
  if (to === location.pathname) return
  if (options.replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  emit()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

let cached: { path: string; route: Route } | undefined
const current = () => {
  if (cached?.path !== location.pathname) cached = { path: location.pathname, route: parse(location.pathname) }
  return cached.route
}

export const useRoute = () => useSyncExternalStore(subscribe, current)

/** A real link (middle click, copy address) that navigates in place on a plain click. */
export function Link({ to, replace, onClick, ...props }: Omit<ComponentProps<'a'>, 'href'> & { to: Route; replace?: boolean }) {
  return (
    <a
      href={href(to)}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e)
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(to, { replace })
      }}
      {...props}
    />
  )
}
