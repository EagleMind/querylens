// The dashboard's only way to the backend: typed calls to the Worker's /api/0 routes.
import type { IssueDetail } from '../../bindings/IssueDetail'
import type { Project } from '../../bindings/Project'
import type { QueryShape } from '../../bindings/QueryShape'
import type { StoredRequest } from '../../bindings/StoredRequest'

const TOKEN_KEY = 'querylens.token'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Private mode: the token lasts for this page only.
  }
}

async function call<T>(method: string, path: string, body?: unknown, token = getToken()): Promise<T> {
  const res = await fetch(`/api/0/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw new ApiError(res.status, data?.message ?? `HTTP ${res.status}`)
  return data as T
}

function query(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

export const api = {
  info: () => fetch('/api/0/info').then((r) => r.json() as Promise<{ version: string; configured: boolean }>),
  /** Checks a token without storing it. */
  verify: (token: string) => call<Project[]>('GET', 'projects', undefined, token),

  projects: () => call<Project[]>('GET', 'projects'),
  createProject: (name: string) => call<Project>('POST', 'projects', { name }),
  /** The query history, newest first; `before` (a request id) pages back. */
  requests: (id: string, p: { before?: number; limit: number }) => call<StoredRequest[]>('GET', `projects/${id}/requests${query(p)}`),
  request: (id: string, request: number) => call<StoredRequest>('GET', `projects/${id}/requests/${request}`),
  issue: (id: string, issue: number) => call<IssueDetail>('GET', `projects/${id}/issues/${issue}`),
  /** One statement shape's totals over the last `hours`; `null` when it has none. */
  shape: (id: string, p: { fingerprint: string; environment: string; hours: number }) =>
    call<QueryShape[]>('GET', `projects/${id}/queries${query({ ...p, limit: 1 })}`).then((rows) => rows[0] ?? null),
}

/** The live feed's WebSocket URL (browsers can't send headers on a WebSocket). */
export function liveUrl(projectId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/api/0/live${query({ project: projectId, token: getToken() })}`
}
