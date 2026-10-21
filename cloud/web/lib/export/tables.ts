// What each screen exports, as tables: the Live list (runs or shapes), one request's statements,
// the regressions. Plus a request as a runnable SQL file.
// Pure: no React, no I/O.
import type { LiveFinding } from '../../../bindings/LiveFinding'
import type { Project } from '../../../bindings/Project'
import type { StoredRequest } from '../../../bindings/StoredRequest'
import type { RegressionReport } from '../../../shared/api'
import { FINDING_KINDS, STATEMENT_TYPES } from '../../../shared/labels.ts'
import { type LiveQuery, type QueryGroup, mongoCommand, statementType } from '../queries.ts'
import type { ExportTable } from './formats.ts'

/** Milliseconds kept to the microsecond: enough, and no float noise. */
function ms(n: number): number {
  return Math.round(n * 1000) / 1000
}

function serviceName(project: Project, id: string): string {
  return project.backends.find((b) => b.id === id)?.name ?? id
}

function verb(sql: string): string {
  return mongoCommand(sql) ?? STATEMENT_TYPES[statementType(sql)]
}

function issues(kinds: LiveFinding[]): string {
  return [...new Set(kinds.map((f) => FINDING_KINDS[f.kind]))].join(', ')
}

/** Every run in the Live list, as shown (filtered and sorted). */
export function runsTable(project: Project, queries: LiveQuery[]): ExportTable {
  return {
    title: `${project.name}: live queries`,
    columns: [
      { key: 'time', label: 'Time' },
      { key: 'service', label: 'Service' },
      { key: 'environment', label: 'Environment' },
      { key: 'release', label: 'Release' },
      { key: 'request', label: 'Request' },
      { key: 'code', label: 'Code' },
      { key: 'type', label: 'Type' },
      { key: 'sql', label: 'SQL' },
      { key: 'durationMs', label: 'Duration (ms)' },
      { key: 'rows', label: 'Rows' },
      { key: 'error', label: 'Error' },
      { key: 'issues', label: 'Issues' },
      { key: 'fingerprint', label: 'Fingerprint' },
    ],
    rows: queries.map((q) => ({
      time: new Date(q.at).toISOString(),
      service: serviceName(project, q.request.backend),
      environment: q.request.environment,
      release: q.request.release,
      request: q.request.name,
      code: q.statement.origin,
      type: q.verb,
      sql: q.statement.sql,
      durationMs: ms(q.statement.durationMs),
      rows: q.statement.rows,
      error: q.statement.error,
      issues: issues(q.findings),
      fingerprint: q.statement.fingerprint,
    })),
  }
}

/** Every query shape in the Live list, as shown (filtered and sorted). */
export function shapesTable(project: Project, groups: QueryGroup[]): ExportTable {
  return {
    title: `${project.name}: query shapes`,
    columns: [
      { key: 'lastRun', label: 'Last run' },
      { key: 'service', label: 'Service' },
      { key: 'code', label: 'Code' },
      { key: 'type', label: 'Type' },
      { key: 'sql', label: 'SQL' },
      { key: 'runs', label: 'Runs' },
      { key: 'averageMs', label: 'Average (ms)' },
      { key: 'totalMs', label: 'Total (ms)' },
      { key: 'maxMs', label: 'Slowest (ms)' },
      { key: 'failed', label: 'Failed runs' },
      { key: 'issues', label: 'Issues' },
      { key: 'requests', label: 'Requests' },
      { key: 'fingerprint', label: 'Fingerprint' },
    ],
    rows: groups.map((g) => ({
      lastRun: new Date(g.latest.at).toISOString(),
      service: serviceName(project, g.latest.request.backend),
      code: g.latest.statement.origin,
      type: g.latest.verb,
      sql: g.latest.statement.sql,
      runs: g.runs,
      averageMs: ms(g.totalMs / g.runs),
      totalMs: ms(g.totalMs),
      maxMs: ms(g.maxMs),
      failed: g.failed,
      issues: issues(g.findings),
      requests: g.requests.join(', '),
      fingerprint: g.latest.statement.fingerprint,
    })),
  }
}

/** One stored request's statements, in the order they ran. */
export function requestTable(project: Project, r: StoredRequest): ExportTable {
  return {
    title: `${r.name} at ${r.at}`,
    columns: [
      { key: 'seq', label: '#' },
      { key: 'startMs', label: 'Start (ms)' },
      { key: 'durationMs', label: 'Duration (ms)' },
      { key: 'code', label: 'Code' },
      { key: 'type', label: 'Type' },
      { key: 'sql', label: 'SQL' },
      { key: 'rows', label: 'Rows' },
      { key: 'error', label: 'Error' },
      { key: 'connection', label: 'Connection' },
      { key: 'issues', label: 'Issues' },
      { key: 'service', label: 'Service' },
      { key: 'environment', label: 'Environment' },
      { key: 'release', label: 'Release' },
      { key: 'fingerprint', label: 'Fingerprint' },
    ],
    rows: [...r.statements]
      .sort((a, b) => a.atMs - b.atMs || a.seq - b.seq)
      .map((s) => ({
        seq: s.seq,
        startMs: ms(s.atMs),
        durationMs: ms(s.durationMs),
        code: s.origin,
        type: verb(s.sql),
        sql: s.sql,
        rows: s.rows,
        error: s.error,
        connection: s.conn,
        issues: issues(r.findings.filter((f) => f.fingerprint === s.fingerprint)),
        service: serviceName(project, r.backend),
        environment: r.environment,
        release: r.release,
        fingerprint: s.fingerprint,
      })),
  }
}

/** The request as a SQL file: each statement with where it ran and how long it took. */
export function requestSql(project: Project, r: StoredRequest): string {
  const head = [
    `-- QueryLens: ${r.name}, ${serviceName(project, r.backend)}, ${r.environment}${r.release ? `, release ${r.release}` : ''}`,
    `-- ${r.at}, ${r.statements.length} statements, ${ms(r.dbMs)} ms in the database of ${ms(r.durationMs)} ms`,
    '',
  ]
  const body = [...r.statements]
    .sort((a, b) => a.atMs - b.atMs || a.seq - b.seq)
    .map((s) => {
      const notes = [`#${s.seq}`, `${ms(s.durationMs)} ms`, `${s.rows} rows`, s.origin, s.error ? `failed: ${s.error.replace(/\s+/g, ' ')}` : null]
      const sql = s.sql.trim().replace(/;\s*$/, '')
      return `-- ${notes.filter(Boolean).join(', ')}\n${sql};\n`
    })
  return `${[...head, ...body].join('\n')}`
}

/** Regressions, one row per statement shape, for each service and environment. */
export function regressionsTable(project: Project, reports: RegressionReport[]): ExportTable {
  return {
    title: `${project.name}: regressions`,
    columns: [
      { key: 'service', label: 'Service' },
      { key: 'environment', label: 'Environment' },
      { key: 'since', label: 'Since' },
      { key: 'change', label: 'Change' },
      { key: 'sql', label: 'SQL' },
      { key: 'callsBefore', label: 'Calls before' },
      { key: 'callsAfter', label: 'Calls after' },
      { key: 'meanBeforeMs', label: 'Mean before (ms)' },
      { key: 'meanAfterMs', label: 'Mean after (ms)' },
      { key: 'errorRateBefore', label: 'Failing before' },
      { key: 'errorRateAfter', label: 'Failing after' },
      { key: 'costPerHour', label: 'Cost per hour' },
      { key: 'fingerprint', label: 'Fingerprint' },
    ],
    rows: reports.flatMap((r) =>
      r.regressions.map((g) => ({
        service: serviceName(project, r.backend),
        environment: r.environment,
        since: r.baseline.kind === 'release' ? `release ${r.baseline.release}` : 'last 24 hours vs the week before',
        change: g.regression,
        sql: g.sampleSql,
        callsBefore: g.before.calls,
        callsAfter: g.after.calls,
        meanBeforeMs: ms(g.before.meanMs),
        meanAfterMs: ms(g.after.meanMs),
        errorRateBefore: ms(g.before.errorRate),
        errorRateAfter: ms(g.after.errorRate),
        costPerHour: ms(g.costPerHour),
        fingerprint: g.fingerprint,
      })),
    ),
  }
}
