// What the dashboard is looking at: one project or all, one environment or all. Chosen in
// the sidebar, remembered in this browser, read by the Live page.
import { useState } from 'react'

import type { Project } from '../../bindings/Project'

export const ALL = 'all'

export interface Scope {
  project: string
  environment: string
}

const SCOPE_KEY = 'querylens.scope'
/** Where the Live page kept the scope before the sidebar did. */
const OLD_VIEW_KEY = 'querylens.live'

function load(): Scope {
  try {
    const saved = JSON.parse(localStorage.getItem(SCOPE_KEY) ?? localStorage.getItem(OLD_VIEW_KEY) ?? '{}')
    return { project: saved.project ?? ALL, environment: saved.environment ?? ALL }
  } catch {
    return { project: ALL, environment: ALL }
  }
}

export function useScope(): [Scope, (patch: Partial<Scope>) => void] {
  const [scope, setScope] = useState(load)
  const update = (patch: Partial<Scope>) =>
    setScope((s) => {
      const next = { ...s, ...patch }
      try {
        localStorage.setItem(SCOPE_KEY, JSON.stringify(next))
      } catch {
        // Not remembered: fine.
      }
      return next
    })
  return [scope, update]
}

/** The scope's project id, or `all` when it names one that no longer exists. */
export function scopedProject(scope: Scope, projects: Project[]): string {
  return scope.project !== ALL && projects.some((p) => p.id === scope.project) ? scope.project : ALL
}
