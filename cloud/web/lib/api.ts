// The dashboard's only way to the backend: typed calls to the Worker's /api/0 routes.
import type { Issue } from '../../bindings/Issue'
import type { IssueDetail } from '../../bindings/IssueDetail'
import type { IssueEvent } from '../../bindings/IssueEvent'
import type { IssueStatus } from '../../bindings/IssueStatus'
import type { Project } from '../../bindings/Project'
import type { ProjectSettings } from '../../bindings/ProjectSettings'
import type { QueryShape } from '../../bindings/QueryShape'

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

export type IssueSort = 'last_seen' | 'first_seen' | 'times_seen' | 'impact'

export const api = {
  info: () => fetch('/api/0/info').then((r) => r.json() as Promise<{ version: string; configured: boolean }>),
  /** Checks a token without storing it. */
  verify: (token: string) => call<Project[]>('GET', 'projects', undefined, token),

  projects: () => call<Project[]>('GET', 'projects'),
  createProject: (name: string) => call<Project>('POST', 'projects', { name }),
  renameProject: (id: string, name: string) => call<Project>('PATCH', `projects/${id}`, { name }),
  saveSettings: (id: string, settings: Partial<ProjectSettings>) => call<ProjectSettings>('PUT', `projects/${id}/settings`, settings),
  environments: (id: string) => call<string[]>('GET', `projects/${id}/environments`),

  issues: (id: string, p: { environment?: string; status?: IssueStatus; sort?: IssueSort; query?: string }) =>
    call<Issue[]>('GET', `projects/${id}/issues${query(p)}`),
  issue: (id: string, issue: number) => call<IssueDetail>('GET', `projects/${id}/issues/${issue}`),
  setStatus: (id: string, issue: number, status: IssueStatus) =>
    call<IssueDetail>('PATCH', `projects/${id}/issues/${issue}`, { status }),
  events: (id: string, issue: number) => call<IssueEvent[]>('GET', `projects/${id}/issues/${issue}/events`),
  queries: (id: string, p: { environment?: string; hours: number }) =>
    call<QueryShape[]>('GET', `projects/${id}/queries${query(p)}`),
}

/** The live feed's WebSocket URL (browsers can't send headers on a WebSocket). */
export function liveUrl(projectId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/api/0/live${query({ project: projectId, token: getToken() })}`
}
