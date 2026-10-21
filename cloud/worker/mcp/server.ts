// The MCP endpoint (POST /mcp): authentication and HTTP around protocol.ts, and the tools'
// backend on the Durable Objects. Agents connect with the admin token as a Bearer header:
//
//   claude mcp add --transport http querylens https://<worker>/mcp --header "Authorization: Bearer <token>"
import { VERSION } from '../api'
import { type Exports, allProjects, project, publicOrigin } from '../backend'
import { issuePrompt } from '../fixing'
import { HttpError, authorized, json, readBody } from '../http'
import { PROTOCOL_VERSIONS, ToolError, handleBody } from './protocol'
import { type McpBackend, SERVER_INFO, tools } from './tools'

/** HTTP errors from the backend become messages the agent can act on. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof HttpError && e.status < 500) throw new ToolError(e.message)
    throw e
  }
}

function backendFor(ns: Exports, origin: string): McpBackend {
  return {
    projects: () => guarded(async () => allProjects(ns, await publicOrigin(ns, origin))),
    issues: (id, q) => guarded(() => project(ns, id).issues(q)),
    issuePrompt: (id, n) => guarded(() => issuePrompt(ns, id, n)),
    setStatus: (id, n, status) =>
      guarded(async () => {
        const detail = await project(ns, id).setStatus(n, status)
        if (!detail) throw new ToolError(`No issue #${n}.`)
        return detail.issue
      }),
    regressions: (id, q) =>
      guarded(async () => {
        const stub = project(ns, id)
        const streams = (await stub.streams()).filter(
          (s) => (!q.environment || s.environment === q.environment) && (!q.backend || s.backend === q.backend),
        )
        return Promise.all(streams.map((s) => stub.regressions(s.backend, s.environment)))
      }),
  }
}

function rpcError(status: number, message: string): Response {
  return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message } }, status)
}

export async function mcp(request: Request, env: Env, ns: Exports, url: URL): Promise<Response> {
  // Browsers send an Origin; agents don't. A page elsewhere must not drive the server.
  const origin = request.headers.get('origin')
  if (origin && origin !== url.origin) return rpcError(403, 'Cross-origin requests are not allowed.')
  if (!env.ADMIN_TOKEN) return rpcError(503, 'Set the ADMIN_TOKEN secret on the Worker to use the MCP server.')
  if (!authorized(request, env, url)) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send the admin token: Authorization: Bearer <token>.' } }, 401, {
      'www-authenticate': 'Bearer realm="querylens"',
    })
  }
  // Stateless: no server-sent event stream to open, no session to end.
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const version = request.headers.get('mcp-protocol-version')
  if (version && !PROTOCOL_VERSIONS.includes(version)) return rpcError(400, `Unsupported MCP protocol version ${version}.`)

  const answer = await handleBody(await readBody(request), SERVER_INFO(VERSION), tools(backendFor(ns, url.origin)))
  return answer === null ? new Response(null, { status: 202 }) : json(answer)
}
