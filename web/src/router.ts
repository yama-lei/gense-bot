import { useEffect, useState } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'chat'; id: string }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'files'; tab?: 'source' | 'artifact'; id?: string; quote?: string }
  | { name: 'scheduled' }
  | { name: 'customize' }

function parse(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?')
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  switch (parts[0]) {
    case 'c':
      return parts[1] ? { name: 'chat', id: parts[1] } : { name: 'home' }
    case 'projects':
      return parts[1] ? { name: 'project', id: parts[1] } : { name: 'projects' }
    case 'files':
      return {
        name: 'files',
        tab: parts[1] === 'artifact' ? 'artifact' : 'source',
        id: parts[2],
        quote: new URLSearchParams(query).get('q') ?? undefined,
      }
    case 'scheduled':
      return { name: 'scheduled' }
    case 'customize':
      return { name: 'customize' }
    default:
      return { name: 'home' }
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/'
    case 'chat':
      return `#/c/${route.id}`
    case 'projects':
      return '#/projects'
    case 'project':
      return `#/projects/${route.id}`
    case 'files':
      return `#/files/${route.tab ?? 'source'}${route.id ? '/' + encodeURIComponent(route.id) : ''}${route.quote ? '?q=' + encodeURIComponent(route.quote) : ''}`
    case 'scheduled':
      return '#/scheduled'
    case 'customize':
      return '#/customize'
  }
}

export function navigate(route: Route) {
  location.hash = href(route)
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parse(location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
