// What the Live page lists: every statement of every request in the query history.
// Pure: no React, no I/O.
import type { CapturedStatement } from '../../bindings/CapturedStatement'
import type { LiveFinding } from '../../bindings/LiveFinding'
import type { StoredRequest } from '../../bindings/StoredRequest'
import type { QueryRef } from './router'

/** A stored request and the project it belongs to (request ids are per project). */
export interface LiveRequest extends StoredRequest {
  projectId: string
  /** `<project>:<id>`, unique across projects. */
  key: string
  /** When it came in over the live feed (epoch ms); unset for history pages. */
  arrivedAt?: number
}

export type StatementType = 'select' | 'insert' | 'update' | 'delete' | 'other'

export const STATEMENT_TYPES: Record<StatementType, string> = {
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
  other: 'Other',
}

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
  /** The request's findings about this statement's shape. */
  findings: LiveFinding[]
}

/** The backend keeps at most this many statements per request (see worker/project.ts). */
export const STORED_STATEMENT_LIMIT = 100

export function withProject(projectId: string, r: StoredRequest): LiveRequest {
  return { ...r, projectId, key: `${projectId}:${r.id}` }
}

export function statementType(sql: string): StatementType {
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
    findings: request.findings.filter((f) => f.fingerprint === statement.fingerprint),
  }))
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
