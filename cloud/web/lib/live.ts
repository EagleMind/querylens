// The query history and its live tail. For each project: the latest stored requests from the
// API, then one WebSocket to its Durable Object for new ones (reconnecting with backoff and
// reloading the latest page on every reconnect, so a gap is filled). Older pages on demand.
import { useCallback, useEffect, useRef, useState } from 'react'

import type { LiveEvent } from '../../bindings/LiveEvent'
import { api, liveUrl } from './api'
import { type LiveRequest, mergeRequests, withProject } from './queries'

export type Connection = 'connecting' | 'live' | 'offline'

export interface LiveFeed {
  /** The worst state among the project connections. */
  connection: Connection
  /** Newest first, across projects. */
  requests: LiveRequest[]
  /** Statements held, across `requests`. */
  size: number
  /** Every project's latest page has arrived (or failed to). */
  loaded: boolean
  /** Whether any of these projects has older requests than those loaded. */
  hasOlder: (projectIds: string[]) => boolean
  /** Load the page before the oldest loaded request of each of these projects. */
  loadOlder: (projectIds: string[]) => Promise<LiveRequest[]>
}

/** Statements kept while new ones arrive; loading older pages raises it. */
const KEEP_STATEMENTS = 2000
/** Requests per project per page of history. */
const PAGE = 100

type Transaction = Extract<LiveEvent, { type: 'transaction' }>

function statementCount(requests: LiveRequest[]): number {
  return requests.reduce((n, r) => n + r.statements.length, 0)
}

/** The newest requests that fit in `cap` statements. */
function keepLatest(requests: LiveRequest[], cap: number): LiveRequest[] {
  let size = 0
  let n = 0
  while (n < requests.length && size + requests[n].statements.length <= cap) size += requests[n++].statements.length
  return n === requests.length ? requests : requests.slice(0, n)
}

interface Callbacks {
  onRequests: (requests: LiveRequest[]) => void
  onLatestPage: (requests: LiveRequest[] | null) => void
  onState: (c: Connection) => void
}

/** Open one project's feed. Returns a function that closes it for good. */
function openFeed(projectId: string, cb: Callbacks): () => void {
  let ws: WebSocket | null = null
  let retry = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let ping: ReturnType<typeof setInterval> | undefined
  let closed = false

  const connect = () => {
    cb.onState('connecting')
    ws = new WebSocket(liveUrl(projectId))
    ws.onopen = () => {
      retry = 0
      cb.onState('live')
      ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 30_000)
      api.requests(projectId, { limit: PAGE }).then(
        (page) => !closed && cb.onLatestPage(page.map((r) => withProject(projectId, r))),
        () => !closed && cb.onLatestPage(null),
      )
    }
    ws.onmessage = (m) => {
      if (typeof m.data !== 'string' || m.data === 'pong') return
      try {
        const msg = JSON.parse(m.data)
        if (msg.type !== 'batch') return
        const fresh = (msg.events as LiveEvent[])
          .filter((e): e is Transaction => e.type === 'transaction' && e.statements.length > 0)
          .map(({ type: _, ...r }) => ({ ...withProject(projectId, r), arrivedAt: Date.now() }))
        if (fresh.length) cb.onRequests(fresh)
      } catch {
        // Not ours.
      }
    }
    ws.onclose = () => {
      clearInterval(ping)
      if (closed) return
      cb.onState('offline')
      timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++))
    }
  }
  connect()
  return () => {
    closed = true
    clearTimeout(timer)
    clearInterval(ping)
    ws?.close()
  }
}

const RANK: Record<Connection, number> = { live: 0, connecting: 1, offline: 2 }

export function useLiveFeed(projectIds: string[]): LiveFeed {
  const [requests, setRequests] = useState<LiveRequest[]>([])
  const [states, setStates] = useState<Record<string, Connection>>({})
  const [loadedIds, setLoadedIds] = useState<Set<string>>(new Set())
  /** Projects whose oldest request is loaded. */
  const [exhausted, setExhausted] = useState<Set<string>>(new Set())
  const cap = useRef(KEEP_STATEMENTS)
  const current = useRef(requests)
  current.current = requests
  const key = projectIds.join(',')

  useEffect(() => {
    const ids = key ? key.split(',') : []
    cap.current = KEEP_STATEMENTS
    setRequests([])
    setLoadedIds(new Set())
    setExhausted(new Set())
    const add = (fresh: LiveRequest[]) => setRequests((all) => keepLatest(mergeRequests(all, fresh), cap.current))
    const closers = ids.map((id) =>
      openFeed(id, {
        onRequests: add,
        onLatestPage: (page) => {
          if (page) {
            add(page)
            if (page.length < PAGE) setExhausted((s) => new Set(s).add(id))
          }
          setLoadedIds((s) => new Set(s).add(id))
        },
        onState: (state) => setStates((s) => ({ ...s, [id]: state })),
      }),
    )
    return () => closers.forEach((close) => close())
  }, [key])

  const hasOlder = useCallback((ids: string[]) => ids.some((id) => !exhausted.has(id)), [exhausted])

  const loadOlder = useCallback(
    async (ids: string[]) => {
      const pages = await Promise.all(
        ids
          .filter((id) => !exhausted.has(id))
          .map(async (id) => {
            const loaded = current.current.filter((r) => r.projectId === id)
            const before = loaded.length ? Math.min(...loaded.map((r) => r.id)) : undefined
            const page = (await api.requests(id, { before, limit: PAGE })).map((r) => withProject(id, r))
            if (page.length < PAGE) setExhausted((s) => new Set(s).add(id))
            return page
          }),
      )
      const older = pages.flat()
      const merged = mergeRequests(current.current, older)
      cap.current = Math.max(cap.current, statementCount(merged))
      setRequests(merged)
      return older
    },
    [exhausted],
  )

  const ids = key ? key.split(',') : []
  const connection = Object.values(states).reduce<Connection>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'live')
  return {
    connection: Object.keys(states).length ? connection : 'connecting',
    requests,
    size: statementCount(requests),
    loaded: ids.every((id) => loadedIds.has(id)),
    hasOlder,
    loadOlder,
  }
}
