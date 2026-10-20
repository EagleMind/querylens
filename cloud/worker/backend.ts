// The Worker's way to its Durable Objects, shared by the dashboard API and the MCP server:
// finding a project's object, the registry, and a project's public description.
import type { Project as ProjectInfo } from '../bindings/Project'
import { HttpError } from './http'

const PROJECT_ID = /^[0-9a-f]{12}$/

/** The Worker's own Durable Objects, set per request. */
export type Exports = ExecutionContext['exports']

export function isProjectId(id: string): boolean {
  return PROJECT_ID.test(id)
}

export function project(ns: Exports, id: string) {
  if (!isProjectId(id)) throw new HttpError(404, 'No such project.')
  return ns.Project.getByName(id)
}

export function registry(ns: Exports) {
  return ns.Registry.getByName('registry')
}

/** The address DSNs carry: the configured public URL, else the one the request came to. */
export async function publicOrigin(ns: Exports, requestOrigin: string): Promise<string> {
  return (await registry(ns).publicUrl()) ?? requestOrigin
}

/** A project's description; 404 when there's no such project. */
export async function info(ns: Exports, id: string, origin: string): Promise<ProjectInfo> {
  const p = await project(ns, id).info(origin)
  if (!p) throw new HttpError(404, 'No such project.')
  return p
}

export async function allProjects(ns: Exports, origin: string): Promise<ProjectInfo[]> {
  const entries = await registry(ns).list()
  const all = await Promise.all(entries.map((e) => project(ns, e.id).info(origin)))
  return all.filter((p) => p !== null)
}
