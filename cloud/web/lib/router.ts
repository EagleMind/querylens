// A small path router: the dashboard has four screens, not worth a dependency.
// The Worker's assets fall back to index.html for unknown paths, so deep links work.
import { useEffect, useState } from 'react'

/** A query is one statement (`seq`) of one stored request of one project. */
export interface QueryRef {
  project: string
  request: number
  seq: number
}

export type Route = { page: 'live' } | ({ page: 'query' } & QueryRef) | { page: 'settings' } | { page: 'docs' }

const POSITIVE = /^[1-9]\d*$/

export function parse(pathname: string): Route {
  const [first, project, request, seq] = pathname.split('/').filter(Boolean)
  if (first === 'queries' && project && POSITIVE.test(request ?? '') && POSITIVE.test(seq ?? '')) {
    return { page: 'query', project, request: Number(request), seq: Number(seq) }
  }
  if (first === 'settings' && !project) return { page: 'settings' }
  if (first === 'docs' && !project) return { page: 'docs' }
  return { page: 'live' }
}

export function href(route: Route): string {
  if (route.page === 'query') return `/queries/${encodeURIComponent(route.project)}/${route.request}/${route.seq}`
  if (route.page === 'docs') return '/docs'
  return route.page === 'settings' ? '/settings' : '/'
}

export function navigate(to: Route | string) {
  const path = typeof to === 'string' ? to : href(to)
  if (path === location.pathname + location.hash) return
  history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname))
  useEffect(() => {
    const update = () => setRoute(parse(location.pathname))
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])
  return route
}

/** Plain left clicks on internal links go through the router. */
export function onLinkClick(e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  navigate(e.currentTarget.getAttribute('href') ?? '/')
}
