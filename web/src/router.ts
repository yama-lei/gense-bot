import { useEffect, useState } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'chat'; id: string }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'docs'; path?: string; line?: number }
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
    case 'docs': {
      const line = Number(new URLSearchParams(query).get('line'))
      return { name: 'docs', path: parts.slice(1).join('/') || undefined, line: line || undefined }
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
    case 'docs':
      return `#/docs${route.path ? '/' + route.path.split('/').map(encodeURIComponent).join('/') : ''}${route.line ? `?line=${route.line}` : ''}`
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
