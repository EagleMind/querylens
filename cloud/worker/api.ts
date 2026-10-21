// The dashboard's API, under /api/0. Every route but `info` takes the admin token
// (`Authorization: Bearer <ADMIN_TOKEN>`).
//
//   GET    /api/0/info                          version, whether the token is set (no auth)
//   GET    /api/0/live?project=<id>&token=…     the live feed (WebSocket)
//   GET    /api/0/settings                      the public URL (goes into DSNs)
//   PUT    /api/0/settings  {publicUrl}
//   POST   /api/0/filters/draft  {text}         a Live filter from a description (AI)
//   GET    /api/0/projects
//   POST   /api/0/projects  {name}
//   PATCH  /api/0/projects/<id>  {name}
//   PUT    /api/0/projects/<id>/settings
//
// A project's backends, each with its own DSN:
//
//   POST   …/<id>/backends  {name, key?}        connect one
//   PATCH  …/<id>/backends/<b>  {name}
//   PUT    …/<id>/backends/<b>/key  {key?}      new DSN key (generated when absent); reconnects
//   DELETE …/<id>/backends/<b>/key              disconnect: its SDKs are refused, its history kept
//
// What the project's SDKs sent. `?backend=<b>` narrows issues, regressions and queries to one
// backend; source context is per backend, so `source` needs it.
//
//   GET    …/<id>/issues?backend=&environment=&status=&sort=&query=
//   GET    …/<id>/issues/<n>
//   PATCH  …/<id>/issues/<n>  {status}
//   GET    …/<id>/issues/<n>/events
//   GET    …/<id>/issues/<n>/prompt             a fix brief for a coding agent
//   GET    …/<id>/issues/<n>/suggestion         the stored AI rewrite
//   POST   …/<id>/issues/<n>/suggestion         write one (?refresh=1: anew)
//   GET    …/<id>/regressions?backend=&environment=
//   GET    …/<id>/source?backend=&origin=       code around a line (source context)
//   GET    …/<id>/requests?before=
//   GET    …/<id>/requests/<n>
//   GET    …/<id>/queries?backend=&environment=&fingerprint=&hours=
//   GET    …/<id>/environments
import type { IssueStatus } from '../bindings/IssueStatus'
import type { DraftFilterRequest } from '../shared/api'
import { type Exports, allProjects, info, project, publicOrigin, registry } from './backend'
import { draft, issuePrompt, suggest, suggestionState } from './fixing'
import { HttpError, authorized, fail, json, randomHex, readJson } from './http'
import { type BackendChange, type IssueQuery, isBackendId } from './project'

export const VERSION = '0.5.3'
export const STATUSES: IssueStatus[] = ['unresolved', 'resolved', 'ignored']
const DSN_KEY = /^[A-Za-z0-9_-]{16,64}$/

/** `https://host[:port]` from what the user typed; throws on anything else. */
function publicUrl(input: string): string {
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`)
  } catch {
    throw new HttpError(400, 'The host must be a URL like https://querylens.example.com.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'The host must use http or https.')
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username) {
    throw new HttpError(400, 'The host is an address only: no path, query or credentials.')
  }
  return url.origin
}

function projectName(name: string | undefined): string {
  const clean = (name ?? '').trim().slice(0, 100)
  if (!clean) throw new HttpError(400, 'A project needs a name.')
  return clean
}

function backendName(name: string | undefined): string {
  const clean = (name ?? '').trim().slice(0, 64)
  if (!clean) throw new HttpError(400, 'A backend needs a name, like "orders" or "api".')
  return clean
}

/** A DSN key the user typed, or a new one. */
function dsnKey(key: string | undefined): string {
  const next = key?.trim() || randomHex(16)
  if (!DSN_KEY.test(next)) throw new HttpError(400, 'A key is 16 to 64 letters, digits, - or _.')
  return next
}

function changed(result: BackendChange) {
  if (!result.ok) throw new HttpError(result.status, result.message)
}

/** `?backend=`, checked; `null` when absent. */
function backendParam(q: URLSearchParams): string | null {
  const b = q.get('backend')
  if (b === null || b === '') return null
  if (!isBackendId(b)) throw new HttpError(400, 'No such backend.')
  return b
}

export async function api(request: Request, env: Env, ns: Exports, url: URL, path: string[]): Promise<Response> {
  const method = request.method
  if (method === 'GET' && path[0] === 'info' && path.length === 1) {
    return json({ version: VERSION, configured: Boolean(env.ADMIN_TOKEN) })
  }
  if (!env.ADMIN_TOKEN) return fail(503, 'Set the ADMIN_TOKEN secret on the Worker to use the dashboard.')
  // Browsers can't set headers on a WebSocket, so the live feed takes the token in the URL.
  if (!authorized(request, env, url, path[0] === 'live')) return fail(401, 'Sign in with the admin token.')

  const q = url.searchParams
  if (path[0] === 'settings' && path.length === 1) {
    if (method === 'PUT') {
      const body = await readJson<{ publicUrl?: string | null }>(request)
      await registry(ns).setPublicUrl(body.publicUrl?.trim() ? publicUrl(body.publicUrl.trim()) : null)
    } else if (method !== 'GET') return fail(405, 'Method not allowed.')
    return json({ publicUrl: await registry(ns).publicUrl(), dashboardUrl: url.origin })
  }
  if (path[0] === 'live' && path.length === 1) {
    return project(ns, q.get('project') ?? '').fetch(request)
  }
  if (path[0] === 'filters' && path[1] === 'draft' && path.length === 2) {
    if (method !== 'POST') return fail(405, 'Method not allowed.')
    return json(await draft(env, ns, await readJson<DraftFilterRequest>(request)))
  }
  if (path[0] !== 'projects') return fail(404, 'No such endpoint.')
  const origin = await publicOrigin(ns, url.origin)

  const [, id, section, sub, tail] = path
  if (!id) {
    if (method === 'GET') return json(await allProjects(ns, origin))
    if (method === 'POST') {
      const name = projectName((await readJson<{ name?: string }>(request)).name)
      const newId = randomHex(6)
      await project(ns, newId).create(newId, name)
      await registry(ns).add(newId, name)
      return json(await info(ns, newId, origin), 201)
    }
    return fail(405, 'Method not allowed.')
  }

  const stub = project(ns, id)
  if (!section) {
    if (method === 'GET') return json(await info(ns, id, origin))
    if (method === 'PATCH') {
      const name = projectName((await readJson<{ name?: string }>(request)).name)
      await info(ns, id, origin)
      await stub.rename(name)
      await registry(ns).rename(id, name)
      return json(await info(ns, id, origin))
    }
    return fail(405, 'Method not allowed.')
  }
  await info(ns, id, origin)

  switch (section) {
    case 'settings':
      if (method !== 'PUT') return fail(405, 'Method not allowed.')
      return json(await stub.updateSettings(await readJson(request)))
    case 'environments':
      return json(await stub.environments())
    case 'backends': {
      if (!sub) {
        if (method !== 'POST') return fail(405, 'Method not allowed.')
        const body = await readJson<{ name?: string; key?: string }>(request)
        changed(await stub.addBackend(backendName(body.name), dsnKey(body.key)))
      } else if (!isBackendId(sub)) {
        return fail(404, 'No such backend.')
      } else if (!tail) {
        if (method !== 'PATCH') return fail(405, 'Method not allowed.')
        changed(await stub.renameBackend(sub, backendName((await readJson<{ name?: string }>(request)).name)))
      } else if (tail === 'key') {
        if (method === 'PUT') changed(await stub.setBackendKey(sub, dsnKey((await readJson<{ key?: string }>(request)).key)))
        else if (method === 'DELETE') changed(await stub.setBackendKey(sub, null))
        else return fail(405, 'Method not allowed.')
      } else {
        return fail(404, 'No such endpoint.')
      }
      return json(await info(ns, id, origin))
    }
    case 'regressions': {
      const environment = q.get('environment')
      const backend = backendParam(q)
      const streams = (await stub.streams()).filter(
        (s) => (!environment || s.environment === environment) && (!backend || s.backend === backend),
      )
      return json(await Promise.all(streams.map((s) => stub.regressions(s.backend, s.environment))))
    }
    case 'source': {
      const origin = q.get('origin')
      const backend = backendParam(q)
      return json(origin && backend ? await stub.source(backend, origin) : null)
    }
    case 'requests': {
      if (method !== 'GET') return fail(405, 'Method not allowed.')
      if (!sub) {
        const before = Number(q.get('before'))
        return json(await stub.requests(Number.isInteger(before) && before > 0 ? before : null, Number(q.get('limit') ?? 100) || 100))
      }
      const n = Number(sub)
      const stored = Number.isInteger(n) && !tail ? await stub.request(n) : null
      return stored ? json(stored) : fail(404, 'No such request.')
    }
    case 'queries': {
      const hours = Number(q.get('hours') ?? 24) || 24
      const filter = { backend: backendParam(q), environment: q.get('environment'), fingerprint: q.get('fingerprint') }
      return json(await stub.queries(filter, hours, Number(q.get('limit') ?? 50) || 50))
    }
    case 'issues':
      return issues(request, env, ns, id, sub, tail, q)
  }
  return fail(404, 'No such endpoint.')
}

async function issues(
  request: Request,
  env: Env,
  ns: Exports,
  id: string,
  sub: string | undefined,
  tail: string | undefined,
  q: URLSearchParams,
): Promise<Response> {
  const method = request.method
  const stub = project(ns, id)
  if (!sub) {
    const status = q.get('status') as IssueStatus | null
    const query: IssueQuery = {
      backend: backendParam(q) ?? undefined,
      environment: q.get('environment') ?? undefined,
      status: status && STATUSES.includes(status) ? status : undefined,
      sort: (q.get('sort') as IssueQuery['sort']) ?? undefined,
      search: q.get('query') ?? undefined,
      limit: Number(q.get('limit') ?? 100) || 100,
    }
    return json(await stub.issues(query))
  }
  const n = Number(sub)
  if (!Number.isInteger(n)) return fail(404, 'No such issue.')
  switch (tail) {
    case undefined:
      break
    case 'events':
      return json(await stub.events(n, Number(q.get('limit') ?? 10) || 10))
    case 'prompt':
      return json({ prompt: await issuePrompt(ns, id, n) })
    case 'suggestion':
      if (method === 'POST') return json(await suggest(env, ns, id, n, q.get('refresh') === '1'))
      if (method !== 'GET') return fail(405, 'Method not allowed.')
      return json(await suggestionState(env, ns, id, n))
    default:
      return fail(404, 'No such endpoint.')
  }
  if (method === 'PATCH') {
    const { status } = await readJson<{ status?: IssueStatus }>(request)
    if (!status || !STATUSES.includes(status)) return fail(400, 'status must be unresolved, resolved or ignored.')
    const detail = await stub.setStatus(n, status)
    return detail ? json(detail) : fail(404, 'No such issue.')
  }
  const detail = await stub.issue(n)
  return detail ? json(detail) : fail(404, 'No such issue.')
}
