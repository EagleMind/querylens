// What a coding agent can do through QueryLens's MCP server: find the issues worth fixing,
// get one as a fix brief (the same prompt the dashboard copies), check regressions, and mark
// an issue resolved once its fix is in. Written against `McpBackend`, so tests need no Worker.
import type { Issue } from '../../bindings/Issue'
import type { IssueStatus } from '../../bindings/IssueStatus'
import type { Project as ProjectInfo } from '../../bindings/Project'
import type { RegressionReport } from '../../shared/api'
import { fmtCount, fmtMs } from '../../shared/format.ts'
import { FINDING_KINDS, ORMS } from '../../shared/labels.ts'
import { type ServerInfo, type Tool, ToolError, text } from './protocol.ts'

export type IssueSort = 'impact' | 'last_seen' | 'first_seen' | 'times_seen'

/** The backend as the tools see it. Failures throw `ToolError` with a message for the agent. */
export interface McpBackend {
  projects(): Promise<ProjectInfo[]>
  issues(
    projectId: string,
    q: { status?: IssueStatus; backend?: string; environment?: string; sort: IssueSort; limit: number },
  ): Promise<Issue[]>
  issuePrompt(projectId: string, issueId: number): Promise<string>
  setStatus(projectId: string, issueId: number, status: IssueStatus): Promise<Issue>
  regressions(projectId: string, q: { backend?: string; environment?: string }): Promise<RegressionReport[]>
}

export const SERVER_INSTRUCTIONS = `QueryLens monitors the SQL an application sends to its database in production and groups problems into issues (N+1 queries, writes in a loop, slow, failing or duplicate statements), each with the line of code responsible and a fix for the ORM.
To fix issues: list_issues (sorted by time lost), then get_issue for a full brief (what happens, where in the code, the request's statements, the suggested fix), change the code in this repository, run the tests, and after the fix is deployed call set_issue_status with "resolved". list_regressions shows statements that got slower or started failing since the latest release.`

const PROJECT_ARG = {
  type: 'string',
  description: 'Project id or name. Optional when there is only one project.',
}

const BACKEND_ARG = {
  type: 'string',
  description: 'Only this backend (service) of the project, by name or id. Default: all of them.',
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new ToolError(`"${key}" must be a string.`)
  return v.trim()
}

function int(args: Record<string, unknown>, key: string, fallback?: number): number {
  const v = args[key] ?? fallback
  const n = typeof v === 'string' ? Number(v.replace(/^#/, '')) : v
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ToolError(`"${key}" must be a whole number.`)
  return n
}

function oneOf<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const v = str(args, key) ?? fallback
  if (!allowed.includes(v as T)) throw new ToolError(`"${key}" must be one of: ${allowed.join(', ')}.`)
  return v as T
}

/** The project an agent means: by id or name, or the only one there is. */
export async function resolveProject(backend: McpBackend, ref: string | undefined): Promise<ProjectInfo> {
  const projects = await backend.projects()
  const names = projects.map((p) => `${p.name} (${p.id})`).join(', ') || 'none yet'
  if (!ref) {
    if (projects.length === 1) return projects[0]
    throw new ToolError(`Say which project: ${names}.`)
  }
  const wanted = ref.toLowerCase()
  const found = projects.find((p) => p.id === ref) ?? projects.find((p) => p.name.toLowerCase() === wanted)
  if (!found) throw new ToolError(`No project "${ref}". Projects: ${names}.`)
  return found
}

/** The backend an agent means, by id or name, within a project; `undefined` for all of them. */
export function resolveBackend(p: ProjectInfo, ref: string | undefined): string | undefined {
  if (!ref) return undefined
  const wanted = ref.toLowerCase()
  const found = p.backends.find((b) => b.id === ref) ?? p.backends.find((b) => b.name.toLowerCase() === wanted)
  if (!found) throw new ToolError(`No backend "${ref}" in ${p.name}. Backends: ${p.backends.map((b) => b.name).join(', ') || 'none yet'}.`)
  return found.id
}

function backendName(p: ProjectInfo, id: string): string {
  return p.backends.find((b) => b.id === id)?.name ?? id
}

function issueLine(p: ProjectInfo, i: Issue): string {
  const flags = [i.regressed ? 'REGRESSED' : null, i.status !== 'unresolved' ? i.status : null].filter(Boolean)
  return [
    `#${i.id} [${i.severity}] ${FINDING_KINDS[i.kind]}: ${i.title}${flags.length ? ` (${flags.join(', ')})` : ''}`,
    `   ${i.culprit ?? 'no code location'} · ${i.transaction ?? 'background'} · ${backendName(p, i.backend)}, ${i.environment} · ` +
      `${fmtCount(i.timesSeen)} ${i.timesSeen === 1 ? 'request' : 'requests'}, ${fmtMs(i.impactMs)} lost · last seen ${i.lastSeen}`,
  ].join('\n')
}

function regressionText(p: ProjectInfo, r: RegressionReport): string {
  const base =
    r.baseline.kind === 'release'
      ? `since release ${r.baseline.release} (first seen ${r.baseline.since})${r.baseline.previous ? `, compared with ${r.baseline.previous} and earlier` : ''}`
      : `in the last 24 hours, compared with the 7 days before`
  const where = `${backendName(p, r.backend)}, ${r.environment}`
  if (r.regressions.length === 0) return `${where}: nothing got slower or started failing ${base}.`
  const lines = r.regressions.map((g) =>
    g.regression === 'slower'
      ? `- SLOWER ${fmtMs(g.before.meanMs)} → ${fmtMs(g.after.meanMs)} per call (${fmtCount(g.after.calls)} calls, +${fmtMs(g.costPerHour)}/hour): ${g.sampleSql}`
      : `- FAILING ${(g.before.errorRate * 100).toFixed(1)}% → ${(g.after.errorRate * 100).toFixed(1)}% of ${fmtCount(g.after.calls)} calls: ${g.sampleSql}`,
  )
  return `${where}, ${base}:\n${lines.join('\n')}`
}

export const SERVER_INFO = (version: string): ServerInfo => ({ name: 'querylens', version, instructions: SERVER_INSTRUCTIONS })

export function tools(backend: McpBackend): Tool[] {
  return [
    {
      name: 'list_projects',
      title: 'List projects',
      description: 'The applications QueryLens monitors, each with its backends (services) and the ORM recognised in their traffic.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run() {
        const projects = await backend.projects()
        const lines = projects.map((p) =>
          [
            `- ${p.name} (id ${p.id})`,
            ...p.backends.map((b) => `  - backend ${b.name} (id ${b.id})${b.orm ? `, ${ORMS[b.orm]}` : ''}${b.dsn ? '' : ', disconnected'}`),
          ].join('\n'),
        )
        const summary = projects.map(({ id, name, backends }) => ({
          id,
          name,
          backends: backends.map(({ id, name, orm }) => ({ id, name, orm })),
        }))
        return text(lines.length ? lines.join('\n') : 'No projects yet.', { projects: summary })
      },
    },
    {
      name: 'list_issues',
      title: 'List issues',
      description:
        'Database issues found in production traffic, most costly first by default: N+1 queries, writes in a loop, slow, failing, duplicate or large statements. Each has an id for get_issue.',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_ARG,
          backend: BACKEND_ARG,
          status: { type: 'string', enum: ['unresolved', 'resolved', 'ignored'], description: 'Default: unresolved.' },
          environment: { type: 'string', description: 'Only this environment, e.g. "production".' },
          sort: { type: 'string', enum: ['impact', 'last_seen', 'first_seen', 'times_seen'], description: 'Default: impact (statement time lost).' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default: 20.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        const p = await resolveProject(backend, str(args, 'project'))
        const issues = await backend.issues(p.id, {
          status: oneOf(args, 'status', ['unresolved', 'resolved', 'ignored'] as const, 'unresolved'),
          backend: resolveBackend(p, str(args, 'backend')),
          environment: str(args, 'environment'),
          sort: oneOf(args, 'sort', ['impact', 'last_seen', 'first_seen', 'times_seen'] as const, 'impact'),
          limit: Math.min(50, Math.max(1, int(args, 'limit', 20))),
        })
        const body = issues.length ? issues.map((i) => issueLine(p, i)).join('\n') : 'No issues match.'
        return text(`${p.name}:\n${body}`, { project: p.id, issues })
      },
    },
    {
      name: 'get_issue',
      title: 'Get an issue as a fix brief',
      description:
        'One issue as a Markdown brief for fixing it in this repository: what happens, the lines of code responsible, the SQL, every statement of the request it was last seen in, the code around it when the app sends source context, and the fix QueryLens suggests for the ORM.',
      inputSchema: {
        type: 'object',
        properties: { project: PROJECT_ARG, issue: { type: 'integer', description: 'The issue id, from list_issues.' } },
        required: ['issue'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        const p = await resolveProject(backend, str(args, 'project'))
        return text(await backend.issuePrompt(p.id, int(args, 'issue')))
      },
    },
    {
      name: 'list_regressions',
      title: 'List regressions',
      description:
        'Statements that got slower or started failing since the latest release (or, without releases, over the last day), from statistics of every statement the app ran. Each backend is judged against its own releases.',
      inputSchema: {
        type: 'object',
        properties: { project: PROJECT_ARG, backend: BACKEND_ARG, environment: { type: 'string', description: 'Default: every environment.' } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(args) {
        const p = await resolveProject(backend, str(args, 'project'))
        const reports = await backend.regressions(p.id, { backend: resolveBackend(p, str(args, 'backend')), environment: str(args, 'environment') })
        const body = reports.length ? reports.map((r) => regressionText(p, r)).join('\n\n') : 'No statistics yet.'
        return text(body, { project: p.id, reports })
      },
    },
    {
      name: 'set_issue_status',
      title: 'Resolve, ignore or reopen an issue',
      description:
        'Mark an issue resolved once its fix is deployed (it comes back flagged as regressed if the problem returns), ignored to stop tracking it, or unresolved to reopen it.',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT_ARG,
          issue: { type: 'integer', description: 'The issue id.' },
          status: { type: 'string', enum: ['resolved', 'ignored', 'unresolved'] },
        },
        required: ['issue', 'status'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(args) {
        const p = await resolveProject(backend, str(args, 'project'))
        const status = oneOf(args, 'status', ['resolved', 'ignored', 'unresolved'] as const, 'resolved')
        const issue = await backend.setStatus(p.id, int(args, 'issue'), status)
        return text(`Issue #${issue.id} is now ${issue.status}.`, { issue })
      },
    },
  ]
}
