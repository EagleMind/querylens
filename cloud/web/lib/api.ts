// The dashboard's only way to the backend: typed calls to the Worker's /api/0 routes.
import type { Issue } from '../../bindings/Issue'
import type { IssueDetail } from '../../bindings/IssueDetail'
import type { IssueStatus } from '../../bindings/IssueStatus'
import type { Project } from '../../bindings/Project'
import type { ProjectSettings } from '../../bindings/ProjectSettings'
import type { QueryShape } from '../../bindings/QueryShape'
import type { SourceSnippet } from '../../bindings/SourceSnippet'
import type { StoredRequest } from '../../bindings/StoredRequest'
import type { DraftFilterReply, DraftFilterRequest, FixPrompt, RegressionReport, SuggestionState } from '../../shared/api'

const TOKEN_KEY = 'querylens.token'

export interface BackendSettings {
  publicUrl: string | null
  /** The address this dashboard was reached at, the default public URL. */
  dashboardUrl: string
}

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

  /** Backend-wide: the public URL that goes into DSNs (`null`: the dashboard's own address). */
  settings: () => call<BackendSettings>('GET', 'settings'),
  savePublicUrl: (publicUrl: string | null) => call<BackendSettings>('PUT', 'settings', { publicUrl }),

  projects: () => call<Project[]>('GET', 'projects'),
  renameProject: (id: string, name: string) => call<Project>('PATCH', `projects/${id}`, { name }),
  /** The limits that decide what gets flagged; the backend clamps each to its range. */
  updateSettings: (id: string, settings: Partial<ProjectSettings>) => call<ProjectSettings>('PUT', `projects/${id}/settings`, settings),
  /** Connect a backend to a project: it gets its own DSN. */
  addBackend: (id: string, name: string) => call<Project>('POST', `projects/${id}/backends`, { name }),
  renameBackend: (id: string, backend: string, name: string) => call<Project>('PATCH', `projects/${id}/backends/${backend}`, { name }),
  /** A new DSN key for a backend: the one given, or a generated one. Reconnects a disconnected backend. */
  setBackendKey: (id: string, backend: string, key?: string) =>
    call<Project>('PUT', `projects/${id}/backends/${backend}/key`, key ? { key } : {}),
  /** Refuse a backend's SDKs from now on; its history stays. */
  disconnectBackend: (id: string, backend: string) => call<Project>('DELETE', `projects/${id}/backends/${backend}/key`),
  issues: (id: string, p: { status: IssueStatus; limit: number }) => call<Issue[]>('GET', `projects/${id}/issues${query(p)}`),
  setIssueStatus: (id: string, issue: number, status: IssueStatus) => call<IssueDetail>('PATCH', `projects/${id}/issues/${issue}`, { status }),
  createProject: (name: string) => call<Project>('POST', 'projects', { name }),
  /** The query history, newest first; `before` (a request id) pages back. */
  requests: (id: string, p: { before?: number; limit: number }) => call<StoredRequest[]>('GET', `projects/${id}/requests${query(p)}`),
  request: (id: string, request: number) => call<StoredRequest>('GET', `projects/${id}/requests/${request}`),
  issue: (id: string, issue: number) => call<IssueDetail>('GET', `projects/${id}/issues/${issue}`),
  /** The issue as a Markdown brief for a coding agent. */
  fixPrompt: (id: string, issue: number) => call<FixPrompt>('GET', `projects/${id}/issues/${issue}/prompt`),
  /** The stored AI rewrite for an issue, and whether one can be written. */
  suggestion: (id: string, issue: number) => call<SuggestionState>('GET', `projects/${id}/issues/${issue}/suggestion`),
  /** Write the AI rewrite (reused while the issue and its code are unchanged, unless `refresh`). */
  suggest: (id: string, issue: number, refresh = false) =>
    call<SuggestionState>('POST', `projects/${id}/issues/${issue}/suggestion${query({ refresh: refresh ? 1 : undefined })}`),
  /** Statements that got slower or started failing, per backend and environment (or in one). */
  regressions: (id: string, p: { backend?: string; environment?: string }) =>
    call<RegressionReport[]>('GET', `projects/${id}/regressions${query(p)}`),
  /** The code around `origin` (`file:line`) when the backend's SDK sends source context; `null` otherwise. */
  source: (id: string, backend: string, origin: string) =>
    call<SourceSnippet | null>('GET', `projects/${id}/source${query({ backend, origin })}`),
  /** A Live filter drafted from a description. */
  draftFilter: (req: DraftFilterRequest) => call<DraftFilterReply>('POST', 'filters/draft', req),
  /** One statement shape's totals in one backend over the last `hours`; `null` when it has none. */
  shape: (id: string, p: { backend: string; fingerprint: string; environment: string; hours: number }) =>
    call<QueryShape[]>('GET', `projects/${id}/queries${query({ ...p, limit: 1 })}`).then((rows) => rows[0] ?? null),
}

/** The live feed's WebSocket URL (browsers can't send headers on a WebSocket). */
export function liveUrl(projectId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/api/0/live${query({ project: projectId, token: getToken() })}`
}
