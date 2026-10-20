// The Worker: routes SDK envelopes, dashboard API calls and MCP requests to the right
// Durable Object. It does no analysis itself (the free plan gives a Worker 10 ms of CPU per
// request; the project's Durable Object gets 30 s).
//
//   POST  /api/<project>/envelope   SDK events (DSN key in `x-querylens-key`)
//   *     /api/0/…                  the dashboard's API (api.ts)
//   POST  /mcp                      the MCP server for coding agents (mcp/server.ts)
//   anything else                   the dashboard (static assets, SPA fallback)
import { api } from './api'
import { type Exports, isProjectId } from './backend'
import { HttpError, fail, json, readBody } from './http'
import { mcp } from './mcp/server'
import { Project } from './project'
import { Registry } from './registry'

export { Project, Registry }

async function envelope(request: Request, ns: Exports, id: string): Promise<Response> {
  const key = request.headers.get('x-querylens-key')
  if (!key) return fail(401, 'Missing x-querylens-key: check the SDK’s DSN.')
  if (!isProjectId(id)) return fail(401, 'Unknown project or key: check the SDK’s DSN.')
  const body = await readBody(request)
  const result = await ns.Project.getByName(id).ingest(key, body)
  if (!result.ok) return fail(result.status, result.message)
  return json({ accepted: true, config: result.config }, 202)
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.split('/').filter(Boolean)
    try {
      if (path[0] === 'mcp' && path.length === 1) return await mcp(request, env, ctx.exports, url)
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
