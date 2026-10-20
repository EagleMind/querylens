// Muted issues: an issue set to `ignored` keeps being counted but stops being shown as a
// problem. Loaded once per project, changed from the query report.
import { useCallback, useEffect, useState } from 'react'

import { api } from './api'

export interface Muted {
  isMuted: (projectId: string, issueId: number) => boolean
  setMuted: (projectId: string, issueId: number, muted: boolean) => Promise<void>
}

const keyOf = (projectId: string, issueId: number) => `${projectId}:${issueId}`

/** Issues kept muted per project (the API's page limit). */
const LIMIT = 500

export function useMuted(projectIds: string[]): Muted {
  const [keys, setKeys] = useState<Set<string>>(new Set())
  const ids = projectIds.join(',')

  useEffect(() => {
    let live = true
    Promise.all(
      (ids ? ids.split(',') : []).map((id) =>
        api.issues(id, { status: 'ignored', limit: LIMIT }).then(
          (issues) => issues.map((i) => keyOf(id, i.id)),
          () => [],
        ),
      ),
    ).then((all) => live && setKeys(new Set(all.flat())))
    return () => {
      live = false
    }
  }, [ids])

  const isMuted = useCallback((projectId: string, issueId: number) => keys.has(keyOf(projectId, issueId)), [keys])

  const setMuted = useCallback(async (projectId: string, issueId: number, muted: boolean) => {
    await api.setIssueStatus(projectId, issueId, muted ? 'ignored' : 'unresolved')
    setKeys((s) => {
      const next = new Set(s)
      if (muted) next.add(keyOf(projectId, issueId))
      else next.delete(keyOf(projectId, issueId))
      return next
    })
  }, [])

  return { isMuted, setMuted }
}
