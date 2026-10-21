// What the Live page lists: every statement of every request in the query history.
// Pure: no React, no I/O.
import type { CapturedStatement } from '../../bindings/CapturedStatement'
import type { LiveFinding } from '../../bindings/LiveFinding'
import type { StoredRequest } from '../../bindings/StoredRequest'
import { STATEMENT_TYPES, type StatementType } from '../../shared/labels.ts'
import type { QueryRef } from './router'

/** A stored request and the project it belongs to (request ids are per project). */
export interface LiveRequest extends StoredRequest {
  projectId: string
  /** `<project>:<id>`, unique across projects. */
  key: string
  /** When it came in over the live feed (epoch ms); unset for history pages. */
  arrivedAt?: number
}

export { STATEMENT_TYPES, type StatementType }

/** What a statement does, the one thing colour encodes about it (`--read` / `--write`). */
export type StatementAction = 'read' | 'write' | 'other'

export const STATEMENT_ACTION: Record<StatementType, StatementAction> = {
  select: 'read',
  insert: 'write',
  update: 'write',
  delete: 'write',
  other: 'other',
}

/** One statement execution: the row on the Live page, the subject of the report. */
export interface LiveQuery {
  /** Unique across projects; the list's React key. */
  id: string
  ref: QueryRef
  request: LiveRequest
  statement: CapturedStatement
  /** Start, epoch ms. */
  at: number
  type: StatementType
  /** What it does, as shown: `SELECT`…, or a MongoDB command (`find`, `aggregate`…). */
  verb: string
  /** The request's findings about this statement's shape (muted ones left out when hidden). */
  findings: LiveFinding[]
  /** Issue ids among its findings that are muted. */
  muted: number[]
}

/** Whether muted issues are left out of the list's findings, or shown (marked as muted). */
export type MutedMode = 'hide' | 'show'

/** The backend keeps at most this many statements per request (see worker/project.ts). */
export const STORED_STATEMENT_LIMIT = 100

export function withProject(projectId: string, r: StoredRequest): LiveRequest {
  return { ...r, projectId, key: `${projectId}:${r.id}` }
}

/** A MongoDB operation as the SDK writes it (`db.orders.find(…)`, `Order.find(…)`): its command. */
const MONGO = /^(?:db\.[\w.$-]+|[A-Z][\w$]*)\.(\w+)\(/

const MONGO_TYPES: Record<string, StatementType> = {
  find: 'select',
  aggregate: 'select',
  count: 'select',
  distinct: 'select',
  insert: 'insert',
  update: 'update',
  findAndModify: 'update',
  delete: 'delete',
}

export function mongoCommand(sql: string): string | null {
  return MONGO.exec(sql)?.[1] ?? null
}

export function statementType(sql: string): StatementType {
  const command = mongoCommand(sql)
  if (command) return MONGO_TYPES[command] ?? 'other'
  const word = /^\s*(\w+)/.exec(sql)?.[1]?.toLowerCase()
  return word === 'select' || word === 'insert' || word === 'update' || word === 'delete' ? word : 'other'
}

export function queriesOf(request: LiveRequest): LiveQuery[] {
  const start = Date.parse(request.at)
  return request.statements.map((statement) => ({
    id: `${request.key}:${statement.seq}`,
    ref: { project: request.projectId, request: request.id, seq: statement.seq },
    request,
    statement,
    at: start + statement.atMs,
    type: statementType(statement.sql),
    verb: mongoCommand(statement.sql) ?? STATEMENT_TYPES[statementType(statement.sql)],
    findings: request.findings.filter((f) => f.fingerprint === statement.fingerprint),
    muted: [],
  }))
}

/** Mark muted findings, and drop them in `hide` mode, so views and filters ignore them. */
export function applyMuted(q: LiveQuery, isMuted: (projectId: string, issueId: number) => boolean, mode: MutedMode): LiveQuery {
  const muted = q.findings.filter((f) => isMuted(q.request.projectId, f.issueId)).map((f) => f.issueId)
  if (muted.length === 0) return q
  return { ...q, muted, findings: mode === 'hide' ? q.findings.filter((f) => !muted.includes(f.issueId)) : q.findings }
}

/** Newest first: requests are newest first, and so are the statements within one. */
export function flatten(requests: LiveRequest[]): LiveQuery[] {
  return requests.flatMap((r) => queriesOf(r).reverse())
}

/** Requests from both lists once each, newest first. */
export function mergeRequests(a: LiveRequest[], b: LiveRequest[]): LiveRequest[] {
  const byKey = new Map(a.map((r) => [r.key, r]))
  for (const r of b) byKey.set(r.key, r)
  return [...byKey.values()].sort((x, y) => (x.at === y.at ? y.id - x.id : x.at < y.at ? 1 : -1))
}

/** Without `sendValues`, the SDK sends one opaque value hash instead of the parameters. */
export function valuesSent(statement: CapturedStatement): boolean {
  return !(statement.params.length === 1 && statement.params[0]?.startsWith('#'))
}
