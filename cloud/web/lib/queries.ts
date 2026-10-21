// What the Live page lists: every statement of every request in the query history, one row
// each or grouped by query shape.
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

/** The runs of one query shape (one fingerprint, in one backend): a row of the grouped Live list. */
export interface QueryGroup {
  /** `<project>:<backend>:<fingerprint>`. */
  id: string
  /** The newest run: what the row shows and opens. */
  latest: LiveQuery
  runs: number
  totalMs: number
  maxMs: number
  failed: number
  /** Each issue once, across the runs. */
  findings: LiveFinding[]
  /** Issue ids among `findings` that are muted. */
  muted: number[]
  /** Request names, most recent first. */
  requests: string[]
}

/** The same SQL in two backends is two shapes: different code runs it. */
export function groupKey(request: LiveRequest, fingerprint: string): string {
  return `${request.projectId}:${request.backend}:${fingerprint}`
}

/** Newest first in, newest first out: a shape is placed where its latest run was. */
export function groupByShape(queries: LiveQuery[]): QueryGroup[] {
  const groups = new Map<string, QueryGroup>()
  for (const q of queries) {
    const id = groupKey(q.request, q.statement.fingerprint)
    let g = groups.get(id)
    if (!g) {
      g = { id, latest: q, runs: 0, totalMs: 0, maxMs: 0, failed: 0, findings: [], muted: [], requests: [] }
      groups.set(id, g)
    }
    g.runs++
    g.totalMs += q.statement.durationMs
    g.maxMs = Math.max(g.maxMs, q.statement.durationMs)
    if (q.statement.error) g.failed++
    for (const f of q.findings) if (!g.findings.some((x) => x.issueId === f.issueId)) g.findings.push(f)
    for (const id of q.muted) if (!g.muted.includes(id)) g.muted.push(id)
    if (!g.requests.includes(q.request.name)) g.requests.push(q.request.name)
  }
  return [...groups.values()]
}

/** How the Live list is ordered: newest first, or slowest first (by duration, or a shape's average). */
export type SortOrder = 'recent' | 'latency'

/** Runs, slowest first; ties stay newest first. */
export function slowestRuns(queries: LiveQuery[]): LiveQuery[] {
  return [...queries].sort((a, b) => b.statement.durationMs - a.statement.durationMs)
}

/** Shapes, slowest on average first; ties stay where their latest run put them. */
export function slowestShapes(groups: QueryGroup[]): QueryGroup[] {
  return [...groups].sort((a, b) => b.totalMs / b.runs - a.totalMs / a.runs)
}

/** `src/routes/orders.js:16` → the directory and the file with its line, shown apart. */
export function splitOrigin(origin: string): { dir: string; file: string } {
  const slash = Math.max(origin.lastIndexOf('/'), origin.lastIndexOf('\\'))
  return { dir: origin.slice(0, slash + 1), file: origin.slice(slash + 1) }
}

/** Where a word (`FROM`, `WHERE`) first appears outside brackets and quotes, from `start`; -1 if it doesn't. */
function topLevel(sql: string, word: string, start: number): number {
  const re = new RegExp(String.raw`^${word}\b`, 'i')
  let depth = 0
  let quote: string | null = null
  for (let i = start; i < sql.length; i++) {
    const c = sql[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && /\s/.test(sql[i - 1] ?? ' ') && re.test(sql.slice(i))) return i
  }
  return -1
}

/** What the Live list shows of a statement: its verb and tables, with column lists folded to `…`. */
export function summarizeSql(sql: string): string {
  const s = sql.trim().replace(/\s+/g, ' ')
  const select = /^select\s+(?:distinct\s+)?/i.exec(s)
  if (select) {
    const from = topLevel(s, 'from', select[0].length)
    return from > select[0].length + 1 ? `${select[0]}… ${s.slice(from)}` : s
  }
  const insert = /^(insert\s+(?:ignore\s+)?into\s+\S+)\s*\(/i.exec(s)
  if (insert) return `${insert[1]} …`
  const update = /^update\s+\S+\s+set\s+/i.exec(s)
  if (update) {
    const where = topLevel(s, 'where', update[0].length)
    return `${update[0]}…${where === -1 ? '' : ` ${s.slice(where)}`}`
  }
  return s
}

/** Transactions and session settings: statements around the queries rather than queries. */
export function isHousekeeping(sql: string): boolean {
  return /^\s*(?:set|start|begin|commit|rollback|savepoint|release|show|use)\b/i.test(sql)
}
