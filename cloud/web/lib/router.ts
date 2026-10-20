// A small path router: the dashboard has four screens, not worth a dependency.
// The Worker's assets fall back to index.html for unknown paths, so deep links work.
import { useEffect, useState } from 'react'

export type Route =
  | { page: 'live' }
  | { page: 'issues'; issue: number | null }
  | { page: 'queries' }
  | { page: 'settings' }

export function parse(pathname: string): Route {
  const [first, second] = pathname.split('/').filter(Boolean)
  if (first === 'issues') {
    const n = Number(second)
    return { page: 'issues', issue: Number.isInteger(n) && n > 0 ? n : null }
  }
  if (first === 'queries') return { page: 'queries' }
  if (first === 'settings') return { page: 'settings' }
  return { page: 'live' }
}

export function href(route: Route): string {
  if (route.page === 'issues') return route.issue ? `/issues/${route.issue}` : '/issues'
  return route.page === 'live' ? '/' : `/${route.page}`
}

export function navigate(to: Route | string) {
  const path = typeof to === 'string' ? to : href(to)
  if (path === location.pathname) return
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
