// What the dashboard is looking at: the project, one of its services (backends) or all of them,
// one environment or all. Chosen in the sidebar, remembered in this browser; every page shows only
// the chosen project's data.
import { useState } from 'react'

import type { Project } from '../../bindings/Project'

export const ALL = 'all'

export interface Scope {
  project: string
  /** A backend id of the project, or `all`. */
  backend: string
  environment: string
}

const SCOPE_KEY = 'querylens.scope'
/** Where the Live page kept the scope before the sidebar did. */
const OLD_VIEW_KEY = 'querylens.live'

function load(): Scope {
  try {
    const saved = JSON.parse(localStorage.getItem(SCOPE_KEY) ?? localStorage.getItem(OLD_VIEW_KEY) ?? '{}')
    return { project: saved.project ?? '', backend: saved.backend ?? ALL, environment: saved.environment ?? ALL }
  } catch {
    return { project: '', backend: ALL, environment: ALL }
  }
}

export function useScope(): [Scope, (patch: Partial<Scope>) => void] {
  const [scope, setScope] = useState(load)
  const update = (patch: Partial<Scope>) =>
    setScope((s) => {
      const next = { ...s, ...patch }
      // Backends belong to a project: another project starts with all of its own.
      if (patch.project !== undefined && s.project !== '' && patch.project !== s.project && patch.backend === undefined) next.backend = ALL
      try {
        localStorage.setItem(SCOPE_KEY, JSON.stringify(next))
      } catch {
        // Not remembered: fine.
      }
      return next
    })
  return [scope, update]
}

/** The chosen project, or the first one when the saved choice no longer exists; `null` with no projects. */
export function scopedProject(scope: Scope, projects: Project[]): Project | null {
  return projects.find((p) => p.id === scope.project) ?? projects[0] ?? null
}

/** The scope's backend id, or `all` when it names one the project doesn't have. */
export function scopedBackend(scope: Scope, project: Project | null): string {
  return scope.backend !== ALL && project?.backends.some((b) => b.id === scope.backend) ? scope.backend : ALL
}
