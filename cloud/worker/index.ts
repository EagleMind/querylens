// The Worker: routes SDK envelopes and dashboard API calls to the right Durable Object.
// It does no analysis itself (the free plan gives a Worker 10 ms of CPU per request; the
// project's Durable Object gets 30 s).
//
//   POST  /api/<project>/envelope              SDK events (DSN key in `x-querylens-key`)
//   GET   /api/0/info                           version, whether the token is set (no auth)
//   GET   /api/0/live?project=<id>&token=…      the live feed (WebSocket)
//   GET   /api/0/projects                       ┐
//   POST  /api/0/projects             {name}    │
//   PATCH /api/0/projects/<id>        {name}    │
//   PUT   /api/0/projects/<id>/settings         │ `Authorization: Bearer <ADMIN_TOKEN>`
//   GET   /api/0/projects/<id>/issues           │
//   GET   /api/0/projects/<id>/issues/<n>       │
//   PATCH /api/0/projects/<id>/issues/<n>       │
//   GET   /api/0/projects/<id>/issues/<n>/events│
//   GET   /api/0/projects/<id>/requests?before= │
//   GET   /api/0/projects/<id>/requests/<n>     │
//   GET   /api/0/projects/<id>/queries?fingerprint│
//   GET   /api/0/projects/<id>/environments     ┘
//   anything else                              the dashboard (static assets, SPA fallback)
import type { IssueStatus } from '../bindings/IssueStatus'
import type { Project as ProjectInfo } from '../bindings/Project'
import { type IssueQuery, Project, sameSecret } from './project'
import { Registry } from './registry'

export { Project, Registry }

const VERSION = '0.2.0'
/** Request bodies, compressed or not, and after decompression. */
const MAX_BODY = 4 * 1024 * 1024
const MAX_INFLATED = 16 * 1024 * 1024
const PROJECT_ID = /^[0-9a-f]{12}$/
const STATUSES: IssueStatus[] = ['unresolved', 'resolved', 'ignored']

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

function fail(status: number, message: string): Response {
  return json({ kind: status === 404 ? 'not_found' : 'validation', message }, status)
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The body as text, gunzipped when the SDK compressed it, never more than the limits. */
async function readBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY) throw new HttpError(413, 'Body too large.')
  if (!request.body) return ''
  let stream: ReadableStream<Uint8Array> = request.body
  const gzip = request.headers.get('content-encoding')?.toLowerCase() === 'gzip'
  if (gzip) stream = stream.pipeThrough(new DecompressionStream('gzip'))
  const limit = gzip ? MAX_INFLATED : MAX_BODY
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new HttpError(413, 'Body too large.')
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    all.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(all)
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return JSON.parse(await readBody(request)) as T
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError(400, 'Invalid JSON.')
  }
}

/** The Worker's own Durable Objects, set per request. */
type Exports = ExecutionContext['exports']

function project(ns: Exports, id: string) {
  if (!PROJECT_ID.test(id)) throw new HttpError(404, 'No such project.')
  return ns.Project.getByName(id)
}

function registry(ns: Exports) {
  return ns.Registry.getByName('registry')
}

async function info(ns: Exports, id: string, origin: string): Promise<ProjectInfo> {
  const p = await project(ns, id).info(origin)
  if (!p) throw new HttpError(404, 'No such project.')
  return p
}

function authorized(request: Request, env: Env, url: URL): boolean {
  if (!env.ADMIN_TOKEN) return false
  const header = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  // Browsers can't set headers on a WebSocket, so the live feed takes the token in the URL.
  const token = header || url.searchParams.get('token') || ''
  return sameSecret(token, env.ADMIN_TOKEN)
}

async function envelope(request: Request, ns: Exports, id: string): Promise<Response> {
  const key = request.headers.get('x-querylens-key')
  if (!key) return fail(401, 'Missing x-querylens-key: check the SDK’s DSN.')
  if (!PROJECT_ID.test(id)) return fail(401, 'Unknown project or key: check the SDK’s DSN.')
  const body = await readBody(request)
  const result = await ns.Project.getByName(id).ingest(key, body)
  if (!result.ok) return fail(result.status, result.message)
  return json({ accepted: true, config: result.config }, 202)
}

async function api(request: Request, env: Env, ns: Exports, url: URL, path: string[]): Promise<Response> {
  const method = request.method
  if (method === 'GET' && path[0] === 'info' && path.length === 1) {
    return json({ version: VERSION, configured: Boolean(env.ADMIN_TOKEN) })
  }
  if (!env.ADMIN_TOKEN) return fail(503, 'Set the ADMIN_TOKEN secret on the Worker to use the dashboard.')
  if (!authorized(request, env, url)) return fail(401, 'Sign in with the admin token.')

  const origin = url.origin
  const q = url.searchParams

  if (path[0] === 'live' && path.length === 1) {
    return project(ns, q.get('project') ?? '').fetch(request)
  }
  if (path[0] !== 'projects') return fail(404, 'No such endpoint.')

  const [, id, section, sub, tail] = path
  if (!id) {
    if (method === 'GET') {
      const entries = await registry(ns).list()
      const all = await Promise.all(entries.map((e) => project(ns, e.id).info(origin)))
      return json(all.filter((p) => p !== null))
    }
    if (method === 'POST') {
      const { name } = await readJson<{ name?: string }>(request)
      const clean = (name ?? '').trim().slice(0, 100)
      if (!clean) return fail(400, 'A project needs a name.')
      const newId = randomHex(6)
      await project(ns, newId).create(newId, clean, randomHex(16))
      await registry(ns).add(newId, clean)
      return json(await info(ns, newId, origin), 201)
    }
    return fail(405, 'Method not allowed.')
  }

  const stub = project(ns, id)
  if (!section) {
    if (method === 'GET') return json(await info(ns, id, origin))
    if (method === 'PATCH') {
      const { name } = await readJson<{ name?: string }>(request)
      const clean = (name ?? '').trim().slice(0, 100)
      if (!clean) return fail(400, 'A project needs a name.')
      await info(ns, id, origin)
      await stub.rename(clean)
      await registry(ns).rename(id, clean)
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
    case 'requests': {
      if (method !== 'GET') return fail(405, 'Method not allowed.')
      if (!sub) {
        const before = Number(q.get('before'))
        return json(await stub.requests(Number.isInteger(before) && before > 0 ? before : null, Number(q.get('limit') ?? 100) || 100))
      }
      const n = Number(sub)
      const request = Number.isInteger(n) && !tail ? await stub.request(n) : null
      return request ? json(request) : fail(404, 'No such request.')
    }
    case 'queries': {
      const hours = Number(q.get('hours') ?? 24) || 24
      return json(await stub.queries(q.get('environment'), hours, Number(q.get('limit') ?? 50) || 50, q.get('fingerprint')))
    }
    case 'issues': {
      if (!sub) {
        const status = q.get('status') as IssueStatus | null
        const query: IssueQuery = {
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
      if (tail === 'events') return json(await stub.events(n, Number(q.get('limit') ?? 10) || 10))
      if (tail) return fail(404, 'No such endpoint.')
      if (method === 'PATCH') {
        const { status } = await readJson<{ status?: IssueStatus }>(request)
        if (!status || !STATUSES.includes(status)) return fail(400, 'status must be unresolved, resolved or ignored.')
        const detail = await stub.setStatus(n, status)
        return detail ? json(detail) : fail(404, 'No such issue.')
      }
      const detail = await stub.issue(n)
      return detail ? json(detail) : fail(404, 'No such issue.')
    }
  }
  return fail(404, 'No such endpoint.')
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.split('/').filter(Boolean)
    try {
      if (path[0] === 'api') {
        if (path[1] === '0') return await api(request, env, ctx.exports, url, path.slice(2))
        if (path.length === 3 && path[2] === 'envelope' && request.method === 'POST') {
          return await envelope(request, ctx.exports, path[1])
        }
        return fail(404, 'No such endpoint.')
      }
      return env.ASSETS.fetch(request)
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message)
      console.error(e)
      return json({ kind: 'internal', message: 'Internal error.' }, 500)
    }
  },
} satisfies ExportedHandler<Env>
