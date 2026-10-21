// What the query report says about one query, worked out before anything is drawn: its
// problems in the order to read them, the verdict, its request as an event log, and what
// the page can't show (and why). The cards in components/report only lay this out. Pure.
import type { FindingKind } from '../../bindings/FindingKind'
import type { IssueDetail } from '../../bindings/IssueDetail'
import type { LiveFinding } from '../../bindings/LiveFinding'
import type { ProjectSettings } from '../../bindings/ProjectSettings'
import type { SuggestionSeverity } from '../../bindings/SuggestionSeverity'
import type { SuggestionState } from '../../shared/api'
import { fmtCount, fmtExact, fmtMs } from '../../shared/format.ts'
import { type LiveQuery, type LiveRequest, mongoCommand, valuesSent } from './queries.ts'

const SEVERITY_RANK: Record<SuggestionSeverity, number> = { high: 2, medium: 1, low: 0 }

// ───────────────────────────── problems ─────────────────────────────

export interface Problem {
  /** The issue's id, or `error` for a failure no issue was made for. */
  key: string
  kind: FindingKind
  severity: SuggestionSeverity
  /** What happens, in this run's terms: "Loads 1,100 rows at once". */
  headline: string
  finding: LiveFinding | null
  /** The issue across requests, once loaded. */
  detail: IssueDetail | null
  /** Another problem on this page that likely explains this one. */
  causedBy: Problem | null
}

/** Runs of this query's statement in its request (an N+1 or a loop runs it many times). */
function runs(q: LiveQuery, siblings: LiveQuery[]): LiveQuery[] {
  return siblings.filter((s) => s.statement.fingerprint === q.statement.fingerprint)
}

function plural(n: number, word: string): string {
  return `${fmtCount(n)} ${n === 1 ? word : `${word}s`}`
}

/** One plain sentence for a problem, from this run and the request it's in. */
export function headline(kind: FindingKind, q: LiveQuery, siblings: LiveQuery[], settings: ProjectSettings | undefined): string {
  const mine = runs(q, siblings)
  const n = mine.length
  switch (kind) {
    case 'n_plus_one':
      return `Runs once per row of an earlier query: ${plural(n, 'time')} in this request`
    case 'duplicate_query':
      return `Runs ${plural(n, 'time')} in this request with the same values`
    case 'looped_writes':
      return `Writes one row at a time: ${plural(n, 'statement')} in this request`
    case 'large_result':
      return `Loads ${fmtExact(Math.max(...mine.map((r) => r.statement.rows)))} rows at once`
    case 'slow_query': {
      const slowest = Math.max(...mine.map((r) => r.statement.durationMs))
      return settings ? `Takes ${fmtMs(slowest)}, over your ${fmtMs(settings.slowMs)} limit` : `Takes ${fmtMs(slowest)}`
    }
    case 'query_errors': {
      const failed = mine.filter((r) => r.statement.error)
      return failed.length > 1 ? `Fails: ${plural(failed.length, 'time')} in this request` : 'Fails with a database error'
    }
    case 'chatty_request':
      return `Part of a request that runs ${plural(siblings.length, 'statement')}`
    case 'plan_issue':
      return 'Uses an inefficient query plan'
  }
}

/** Why QueryLens flagged it, in terms of the project's settings. */
export function whyFlagged(kind: FindingKind, s: ProjectSettings | undefined): string {
  const setting = (v: string) => (s ? `${v} (your project’s setting)` : v)
  switch (kind) {
    case 'n_plus_one':
      return setting(`${s?.loopMin ?? 5} or more runs in a row with different values, right after a query that returned rows`)
    case 'duplicate_query':
      return setting(`${s?.loopMin ?? 5} or more runs in a row with the same values`)
    case 'looped_writes':
      return setting(`${s?.loopMin ?? 5} or more single-row writes in a row`)
    case 'large_result':
      return setting(`${fmtExact(s?.largeRows ?? 1000)} rows or more, with no LIMIT`)
    case 'slow_query':
      return setting(`A run took ${fmtMs(s?.slowMs ?? 100)} or more`)
    case 'query_errors':
      return 'The database returned an error'
    case 'chatty_request':
      return setting(`${s?.chatty ?? 50} or more statements in one request`)
    case 'plan_issue':
      return 'The database’s plan for it scans more than it needs'
  }
}

/**
 * The query's problems, the order to read them in: failures first (something is broken),
 * then by severity, then by the time they cost.
 */
export function problemsOf(q: LiveQuery, siblings: LiveQuery[], details: Map<number, IssueDetail>, settings: ProjectSettings | undefined): Problem[] {
  const out: Problem[] = q.findings.map((f) => ({
    key: String(f.issueId),
    kind: f.kind,
    severity: f.severity,
    headline: headline(f.kind, q, siblings, settings),
    finding: f,
    detail: details.get(f.issueId) ?? null,
    causedBy: null,
  }))
  if (q.statement.error && !out.some((p) => p.kind === 'query_errors')) {
    out.push({ key: 'error', kind: 'query_errors', severity: 'medium', headline: 'Fails with a database error', finding: null, detail: null, causedBy: null })
  }
  out.sort(
    (a, b) =>
      Number(b.kind === 'query_errors') - Number(a.kind === 'query_errors') ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (b.detail?.issue.impactMs ?? 0) - (a.detail?.issue.impactMs ?? 0),
  )
  // Loading thousands of rows takes time: that's the likely cause of the slowness.
  const large = out.find((p) => p.kind === 'large_result')
  for (const p of out) if (p.kind === 'slow_query' && large) p.causedBy = large
  return out
}

/** The problem whose fix the page shows: the first, in reading order, that has one. */
export function primaryFix(problems: Problem[]): Problem | null {
  return problems.find((p) => p.detail?.fix) ?? null
}

/** Problems that fix also deals with: itself, and those it explains. */
export function coveredBy(problems: Problem[], primary: Problem): Problem[] {
  return problems.filter((p) => p === primary || p.causedBy === primary)
}

/** The next step for a slow query nothing else on the page explains. */
export function slowNextStep(q: LiveQuery): { text: string; code: string } {
  if (mongoCommand(q.statement.sql)) {
    return {
      text: 'Ask MongoDB how it runs this query. A COLLSCAN stage means no index covers the filter: add one on the fields it filters and sorts on.',
      code: `db.collection.find(…).explain('executionStats')`,
    }
  }
  return {
    text: 'Ask the database how it runs this query, in a console against production-like data. A sequential scan on a large table means no index covers the WHERE columns: add one with a migration.',
    code: `EXPLAIN ANALYZE ${q.statement.sql}`,
  }
}

// ───────────────────────────── verdict ─────────────────────────────

export interface Verdict {
  tone: 'ok' | 'warning' | 'danger'
  title: string
}

export function verdict(q: LiveQuery, problems: Problem[]): Verdict {
  if (q.statement.error) {
    const more = problems.length - 1
    return { tone: 'danger', title: more > 0 ? `This query failed, and has ${plural(more, 'more problem')}` : 'This query failed' }
  }
  if (problems.length === 0) return { tone: 'ok', title: 'No problems in this run' }
  const high = problems.some((p) => p.severity === 'high')
  return { tone: high ? 'danger' : 'warning', title: `${plural(problems.length, 'problem')} with this query` }
}

// ───────────────────────────── the request, as an event log ─────────────────────────────

/** Gaps shorter than this between statements aren't shown as time in the app's code. */
const MIN_GAP_MS = 0.5

export type LogLine =
  | { type: 'start'; at: number }
  | { type: 'code'; at: number; durationMs: number }
  /** One statement, or consecutive runs of the same one (an N+1, a loop), folded. */
  | { type: 'statement'; at: number; runs: LiveQuery[]; durationMs: number; rows: number; kinds: FindingKind[] }
  | { type: 'end'; at: number }

export interface EventLog {
  lines: LogLine[]
  totalMs: number
  /** Time with at least one statement running (overlaps counted once). */
  dbMs: number
  codeMs: number
  connections: number
}

export function eventLog(request: LiveRequest, siblings: LiveQuery[]): EventLog {
  const ordered = [...siblings].sort((a, b) => a.statement.atMs - b.statement.atMs || a.statement.seq - b.statement.seq)
  const lines: LogLine[] = [{ type: 'start', at: 0 }]
  let cursor = 0
  let dbMs = 0
  for (let i = 0; i < ordered.length; ) {
    let j = i + 1
    while (j < ordered.length && ordered[j].statement.fingerprint === ordered[i].statement.fingerprint) j++
    const group = ordered.slice(i, j)
    const start = group[0].statement.atMs
    const end = Math.max(...group.map((g) => g.statement.atMs + g.statement.durationMs))
    if (start - cursor >= MIN_GAP_MS) lines.push({ type: 'code', at: cursor, durationMs: start - cursor })
    // Database time is each run's own, overlaps counted once (the gaps between runs are the app's).
    let busy = cursor
    for (const g of group) {
      const runEnd = g.statement.atMs + g.statement.durationMs
      dbMs += Math.max(0, runEnd - Math.max(g.statement.atMs, busy))
      busy = Math.max(busy, runEnd)
    }
    const kinds = [...new Set(request.findings.filter((f) => f.fingerprint === group[0].statement.fingerprint).map((f) => f.kind))]
    lines.push({
      type: 'statement',
      at: start,
      runs: group,
      durationMs: group.reduce((n, g) => n + g.statement.durationMs, 0),
      rows: group.reduce((n, g) => n + g.statement.rows, 0),
      kinds,
    })
    cursor = Math.max(cursor, end)
    i = j
  }
  const totalMs = Math.max(request.durationMs, cursor)
  if (totalMs - cursor >= MIN_GAP_MS) lines.push({ type: 'code', at: cursor, durationMs: totalMs - cursor })
  lines.push({ type: 'end', at: totalMs })
  return {
    lines,
    totalMs,
    dbMs,
    codeMs: Math.max(0, totalMs - dbMs),
    connections: new Set(siblings.map((s) => s.statement.conn)).size,
  }
}

// ───────────────────────────── what the page can't show ─────────────────────────────

export type MissingKey = 'line-of-code' | 'source-context' | 'values' | 'releases' | 'ai'

export interface Missing {
  key: MissingKey
  /** What isn't shown. */
  what: string
  /** Why, and what it changes. */
  why: string
}

/**
 * Parts of the report left out because something isn't set up. `source`: the code around
 * the line, `undefined` while loading; `ai`: the fix's suggestion state, when there's a fix.
 */
export function missingParts(q: LiveQuery, source: unknown, ai: SuggestionState | undefined): Missing[] {
  const out: Missing[] = []
  if (!q.statement.origin) {
    out.push({
      key: 'line-of-code',
      what: 'The line of your code',
      why: 'none of your code was on the stack when it ran (a library, a timer, or code outside the project directory).',
    })
  } else if (source === null) {
    out.push({ key: 'source-context', what: 'Your code around that line', why: 'source context is off in the SDK.' })
  }
  if (!valuesSent(q.statement)) {
    out.push({ key: 'values', what: 'Parameter values', why: 'they stay in your app; the SDK sends the query without them.' })
  }
  if (!q.request.release) {
    out.push({ key: 'releases', what: 'The release', why: 'your app doesn’t report one, so regressions compare the last day with the week before.' })
  }
  if (ai?.unavailable === 'ai_unavailable') {
    out.push({ key: 'ai', what: 'AI-written changes', why: 'Workers AI isn’t connected to your QueryLens backend.' })
  }
  return out
}
