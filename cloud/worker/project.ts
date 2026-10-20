// One monitored application. Its Durable Object owns everything about it: the DSN key,
// settings, issues with their latest events, the query history (every request the SDKs
// send, one row each), hourly statement statistics (SQLite), and the dashboards watching it
// live (hibernating WebSockets). The Worker only routes here.
//
// Evaluation (what's wrong in a request) is querylens-core's job (`digest`); this class
// decides what to remember: issues are keyed by the finding's stable id per environment,
// a resolved issue seen again comes back flagged as regressed, an ignored one stays ignored.
// It also keeps what fixing an issue takes (`issueContext`: the code around it when the SDK
// sends source context, the request it was last seen in), the releases each environment
// reported (for `regressions`), and the latest AI suggestion per issue.
import { DurableObject } from 'cloudflare:workers'

import type { CaptureFinding } from '../bindings/CaptureFinding'
import type { CapturedStatement } from '../bindings/CapturedStatement'
import type { Digest } from '../bindings/Digest'
import type { DigestedTransaction } from '../bindings/DigestedTransaction'
import type { Found } from '../bindings/Found'
import type { Issue } from '../bindings/Issue'
import type { IssueDetail } from '../bindings/IssueDetail'
import type { IssueEvent } from '../bindings/IssueEvent'
import type { IssueStatus } from '../bindings/IssueStatus'
import type { LiveEvent } from '../bindings/LiveEvent'
import type { LiveFinding } from '../bindings/LiveFinding'
import type { OriginCount } from '../bindings/OriginCount'
import type { Orm } from '../bindings/Orm'
import type { Project as ProjectInfo } from '../bindings/Project'
import type { ProjectSettings } from '../bindings/ProjectSettings'
import type { QueryShape } from '../bindings/QueryShape'
import type { SourceSnippet } from '../bindings/SourceSnippet'
import type { StoredRequest } from '../bindings/StoredRequest'
import type { IssueContext, Regression, RegressionReport, Suggestion } from '../shared/api'
import { type ReleaseSeen, type ShapeTotals, comparison, judge } from './analysis/regressions'
import { digest } from './core'
import { sameSecret } from './http'

export const DEFAULT_SETTINGS: ProjectSettings = {
  slowMs: 100,
  loopMin: 5,
  chatty: 50,
  largeRows: 1000,
  liveSampleRate: 0.05,
}

/** Latest events kept per issue. */
const EVENTS_PER_ISSUE = 10
/** Statements kept per stored event, and SQL characters per statement. */
const EVENT_STATEMENTS = 200
const STORED_SQL = 4000
/** Statements and SQL characters kept per request in the query history (and sent live). */
const HISTORY_STATEMENTS = 100
const HISTORY_SQL = 2000
/** Query history: the latest requests, and for at most this long. */
const HISTORY_REQUESTS = 20_000
const HISTORY_DAYS = 7
/** Requests between two trims of the history by count. */
const HISTORY_TRIM_EVERY = 500
const ORIGINS = 5
const STATS_RETENTION_HOURS = 24 * 30
const HOUR_MS = 3_600_000
/** Source snippets kept (one per line of code), and given with an issue. */
const SOURCES_KEPT = 5000
const SOURCES_PER_ISSUE = 3
/** Regressions reported, and how many recent requests are searched for a run to link to. */
const REGRESSIONS = 20
const REGRESSION_LINKS = 10
const LINK_SEARCH_REQUESTS = 2000

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY,
    environment TEXT NOT NULL,
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    sample_sql TEXT NOT NULL,
    parent_sql TEXT,
    transaction_name TEXT,
    origins_json TEXT NOT NULL,
    fix_json TEXT,
    status TEXT NOT NULL,
    regressed INTEGER NOT NULL DEFAULT 0,
    times_seen INTEGER NOT NULL,
    occurrences INTEGER NOT NULL,
    impact_ms REAL NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    first_release TEXT,
    last_release TEXT,
    resolved_at TEXT,
    UNIQUE (environment, key)
  );
  CREATE INDEX IF NOT EXISTS issues_recent ON issues (status, last_seen DESC);
  CREATE TABLE IF NOT EXISTS issue_events (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL,
    at TEXT NOT NULL,
    release TEXT,
    transaction_name TEXT,
    duration_ms REAL NOT NULL,
    finding_json TEXT NOT NULL,
    statements_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS issue_events_latest ON issue_events (issue_id, id DESC);
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    environment TEXT NOT NULL,
    release TEXT,
    name TEXT NOT NULL,
    at TEXT NOT NULL,
    duration_ms REAL NOT NULL,
    db_ms REAL NOT NULL,
    statements_json TEXT NOT NULL,
    findings_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS query_shapes (
    environment TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    sample_sql TEXT NOT NULL,
    kind TEXT NOT NULL,
    tables_json TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (environment, fingerprint)
  );
  CREATE TABLE IF NOT EXISTS sources (
    origin TEXT PRIMARY KEY,
    first_line INTEGER NOT NULL,
    lines_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS releases (
    environment TEXT NOT NULL,
    release TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    PRIMARY KEY (environment, release)
  );
  CREATE TABLE IF NOT EXISTS suggestions (
    issue_id INTEGER PRIMARY KEY,
    input_hash TEXT NOT NULL,
    suggestion_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS query_stats (
    environment TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    hour INTEGER NOT NULL,
    calls INTEGER NOT NULL,
    total_ms REAL NOT NULL,
    max_ms REAL NOT NULL,
    errors INTEGER NOT NULL,
    rows REAL NOT NULL,
    PRIMARY KEY (environment, fingerprint, hour)
  );
`

export type IngestResult = { ok: true; config: ProjectSettings } | { ok: false; status: 401 | 400; message: string }

export interface IssueQuery {
  environment?: string
  status?: IssueStatus
  sort?: 'last_seen' | 'first_seen' | 'times_seen' | 'impact'
  search?: string
  limit?: number
}

type Row = Record<string, SqlStorageValue>

const SEVERITY_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 }

function iso(epochMs: number): string {
  const now = Date.now()
  // A clock far in the future (or nonsense) reads as now.
  const ms = Number.isFinite(epochMs) && epochMs > 0 && epochMs <= now + 300_000 ? epochMs : now
  return new Date(ms).toISOString()
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function trimStatements(statements: CapturedStatement[], count: number, sql: number): CapturedStatement[] {
  return statements.slice(0, count).map((s) => ({ ...s, sql: clip(s.sql, sql) }))
}

function mergeOrigins(a: OriginCount[], b: OriginCount[]): OriginCount[] {
  const counts = new Map(a.map((o) => [o.origin, o.count]))
  for (const o of b) counts.set(o.origin, (counts.get(o.origin) ?? 0) + o.count)
  return [...counts]
    .map(([origin, count]) => ({ origin, count }))
    .sort((x, y) => y.count - x.count || x.origin.localeCompare(y.origin))
    .slice(0, ORIGINS)
}

function requestFromRow(r: Row): StoredRequest {
  return {
    id: Number(r.id),
    environment: String(r.environment),
    release: (r.release as string | null) ?? null,
    name: String(r.name),
    at: String(r.at),
    durationMs: Number(r.duration_ms),
    dbMs: Number(r.db_ms),
    statements: JSON.parse(String(r.statements_json)) as CapturedStatement[],
    findings: JSON.parse(String(r.findings_json)) as LiveFinding[],
  }
}

function issueFromRow(r: Row): Issue {
  const origins = JSON.parse(String(r.origins_json)) as OriginCount[]
  return {
    id: Number(r.id),
    environment: String(r.environment),
    kind: r.kind as Issue['kind'],
    severity: r.severity as Issue['severity'],
    title: String(r.title),
    detail: String(r.detail),
    culprit: origins[0]?.origin ?? null,
    transaction: (r.transaction_name as string | null) ?? null,
    status: r.status as IssueStatus,
    regressed: Boolean(r.regressed),
    timesSeen: Number(r.times_seen),
    occurrences: Number(r.occurrences),
    impactMs: Number(r.impact_ms),
    firstSeen: String(r.first_seen),
    lastSeen: String(r.last_seen),
    firstRelease: (r.first_release as string | null) ?? null,
    lastRelease: (r.last_release as string | null) ?? null,
  }
}

export class Project extends DurableObject<Env> {
  private readonly sql: SqlStorage
  /** Environment and release pairs already recorded, so most envelopes skip the write. */
  private readonly knownReleases = new Set<string>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA)
    })
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  // ───────────────────────────── identity and settings ─────────────────────────────

  private meta(key: string): string | null {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0]
    return row?.value ?? null
  }

  private setMeta(key: string, value: string) {
    this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value)
  }

  private settings(): ProjectSettings {
    const raw = this.meta('settings')
    return { ...DEFAULT_SETTINGS, ...(raw ? (JSON.parse(raw) as Partial<ProjectSettings>) : {}) }
  }

  /** Set up a new project. Fails if this object already is one. */
  async create(id: string, name: string, key: string): Promise<void> {
    if (this.meta('id')) throw new Error('Project already exists')
    this.ctx.storage.transactionSync(() => {
      this.setMeta('id', id)
      this.setMeta('name', name)
      this.setMeta('key', key)
      this.setMeta('created_at', new Date().toISOString())
    })
    // Daily housekeeping (old statistics).
    await this.ctx.storage.setAlarm(Date.now() + 24 * HOUR_MS)
  }

  /** `null` when this object isn't a project. `origin` is the backend's public URL, for the DSN. */
  async info(origin: string): Promise<ProjectInfo | null> {
    const id = this.meta('id')
    const key = this.meta('key')
    if (!id || !key) return null
    const url = new URL(origin)
    return {
      id,
      name: this.meta('name') ?? id,
      dsn: `${url.protocol}//${key}@${url.host}/${id}`,
      orm: (this.meta('orm') as Orm | null) ?? null,
      settings: this.settings(),
      createdAt: this.meta('created_at') ?? '',
    }
  }

  /** Replace the DSN key: SDKs still using the old one are refused from now on. */
  async setKey(key: string): Promise<void> {
    if (!this.meta('id')) throw new Error('No such project')
    this.setMeta('key', key)
  }

  async rename(name: string): Promise<void> {
    if (!this.meta('id')) throw new Error('No such project')
    this.setMeta('name', name)
  }

  async updateSettings(patch: Partial<ProjectSettings>): Promise<ProjectSettings> {
    if (!this.meta('id')) throw new Error('No such project')
    const next = { ...this.settings() }
    const num = (v: unknown, min: number, max: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined
    next.slowMs = num(patch.slowMs, 1, 600_000) ?? next.slowMs
    next.loopMin = Math.round(num(patch.loopMin, 2, 1000) ?? next.loopMin)
    next.chatty = Math.round(num(patch.chatty, 2, 100_000) ?? next.chatty)
    next.largeRows = num(patch.largeRows, 1, 1e9) ?? next.largeRows
    next.liveSampleRate = num(patch.liveSampleRate, 0, 1) ?? next.liveSampleRate
    this.setMeta('settings', JSON.stringify(next))
    return next
  }

  // ───────────────────────────── ingest ─────────────────────────────

  /** One SDK envelope: evaluate, remember, broadcast. Answers with the settings the SDK filters by. */
  async ingest(key: string, body: string): Promise<IngestResult> {
    const expected = this.meta('key')
    if (!expected || !sameSecret(key, expected)) {
      return { ok: false, status: 401, message: 'Unknown project or key: check the SDK’s DSN.' }
    }
    const settings = this.settings()
    let d: Digest
    try {
      d = digest(body, (this.meta('orm') as Orm | null) ?? null, settings)
    } catch (e) {
      return { ok: false, status: 400, message: String(e) }
    }
    if (d.orm) this.setMeta('orm', d.orm)

    const live: LiveEvent[] = []
    this.ctx.storage.transactionSync(() => {
      for (const txn of d.transactions) {
        const at = iso(txn.start)
        const findings = this.recordFindings(d, txn, at, live)
        live.push({ type: 'transaction', ...this.recordRequest(d, txn, at, findings) })
      }
      this.recordStats(d)
      this.recordRelease(d)
      this.recordSources(d.sources)
    })
    // One throughput event per reported period (an envelope may carry several).
    const periods = new Map<number, typeof d.stats>()
    for (const s of d.stats) periods.set(s.start, [...(periods.get(s.start) ?? []), s])
    for (const [start, rows] of periods) {
      live.push({
        type: 'throughput',
        environment: d.environment,
        at: iso(start),
        periodMs: rows[0].periodMs,
        calls: rows.reduce((n, s) => n + s.calls, 0),
        totalMs: rows.reduce((n, s) => n + s.totalMs, 0),
        errors: rows.reduce((n, s) => n + s.errors, 0),
      })
    }
    this.broadcast(live)
    return { ok: true, config: settings }
  }

  /** Fold one request's findings into their issues; returns them for the live feed. */
  private recordFindings(d: Digest, txn: DigestedTransaction, at: string, live: LiveEvent[]): LiveFinding[] {
    if (txn.findings.length === 0) return []
    const statements = JSON.stringify(trimStatements(txn.statements, EVENT_STATEMENTS, STORED_SQL))
    return txn.findings.map((f) => {
      const { issue, isNew, regressed } = this.upsertIssue(d, txn, at, f)
      this.sql.exec(
        `INSERT INTO issue_events (issue_id, at, release, transaction_name, duration_ms, finding_json, statements_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        issue.id,
        at,
        d.release,
        txn.name,
        txn.durationMs,
        JSON.stringify(f.finding),
        statements,
      )
      this.sql.exec(
        `DELETE FROM issue_events WHERE issue_id = ?1 AND id NOT IN
           (SELECT id FROM issue_events WHERE issue_id = ?1 ORDER BY id DESC LIMIT ?2)`,
        issue.id,
        EVENTS_PER_ISSUE,
      )
      if (isNew || regressed) live.push({ type: 'issue', issue, regressed })
      return { issueId: issue.id, fingerprint: f.finding.fingerprint, kind: f.finding.kind, severity: f.finding.severity, title: f.finding.title }
    })
  }

  private upsertIssue(d: Digest, txn: DigestedTransaction, at: string, f: Found): { issue: Issue; isNew: boolean; regressed: boolean } {
    const finding: CaptureFinding = f.finding
    const fix = finding.fix ? JSON.stringify(finding.fix) : null
    const current = this.sql
      .exec('SELECT id, status, severity, origins_json FROM issues WHERE environment = ? AND key = ?', d.environment, finding.id)
      .toArray()[0]
    if (!current) {
      const row = this.sql
        .exec(
          `INSERT INTO issues (environment, key, kind, severity, title, detail, fingerprint, sample_sql, parent_sql,
             transaction_name, origins_json, fix_json, status, regressed, times_seen, occurrences, impact_ms,
             first_seen, last_seen, first_release, last_release)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', 0, 1, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
          d.environment,
          finding.id,
          finding.kind,
          finding.severity,
          finding.title,
          finding.detail,
          finding.fingerprint,
          f.sampleSql,
          f.parentSql,
          txn.name,
          JSON.stringify(mergeOrigins([], finding.origins)),
          fix,
          finding.occurrences,
          finding.impactMs,
          at,
          at,
          d.release,
          d.release,
        )
        .one()
      return { issue: issueFromRow(row), isNew: true, regressed: false }
    }
    const regressed = current.status === 'resolved'
    const severity =
      SEVERITY_RANK[finding.severity] > SEVERITY_RANK[String(current.severity)] ? finding.severity : String(current.severity)
    const origins = mergeOrigins(JSON.parse(String(current.origins_json)) as OriginCount[], finding.origins)
    const row = this.sql
      .exec(
        `UPDATE issues SET severity = ?, title = ?, detail = ?, sample_sql = ?, parent_sql = ?, transaction_name = ?,
           origins_json = ?, fix_json = ?,
           status = CASE WHEN status = 'resolved' THEN 'unresolved' ELSE status END,
           regressed = CASE WHEN status = 'resolved' THEN 1 ELSE regressed END,
           resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END,
           times_seen = times_seen + 1, occurrences = occurrences + ?, impact_ms = impact_ms + ?,
           last_seen = MAX(last_seen, ?), first_release = COALESCE(first_release, ?), last_release = COALESCE(?, last_release)
         WHERE id = ? RETURNING *`,
        severity,
        finding.title,
        finding.detail,
        f.sampleSql,
        f.parentSql,
        txn.name,
        JSON.stringify(origins),
        fix,
        finding.occurrences,
        finding.impactMs,
        at,
        d.release,
        d.release,
        current.id,
      )
      .one()
    return { issue: issueFromRow(row), isNew: false, regressed }
  }

  /** One row per request: the query history the dashboard lists and reports on. */
  private recordRequest(d: Digest, txn: DigestedTransaction, at: string, findings: LiveFinding[]): StoredRequest {
    const statements = trimStatements(txn.statements, HISTORY_STATEMENTS, HISTORY_SQL)
    const { id } = this.sql
      .exec<{ id: number }>(
        `INSERT INTO requests (environment, release, name, at, duration_ms, db_ms, statements_json, findings_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        d.environment,
        d.release,
        txn.name,
        at,
        txn.durationMs,
        txn.dbMs,
        JSON.stringify(statements),
        JSON.stringify(findings),
      )
      .one()
    if (id % HISTORY_TRIM_EVERY === 0) this.sql.exec('DELETE FROM requests WHERE id <= ?', id - HISTORY_REQUESTS)
    return {
      id,
      environment: d.environment,
      release: d.release,
      name: txn.name,
      at,
      durationMs: txn.durationMs,
      dbMs: txn.dbMs,
      statements,
      findings,
    }
  }

  private recordStats(d: Digest) {
    const now = new Date().toISOString()
    // Rows written are the free plan's scarcest resource: a known shape's `last_seen`
    // is refreshed at most hourly (a skipped upsert writes nothing).
    const stale = new Date(Date.now() - HOUR_MS).toISOString()
    for (const s of d.stats) {
      this.sql.exec(
        `INSERT INTO query_shapes (environment, fingerprint, sample_sql, kind, tables_json, last_seen) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (environment, fingerprint) DO UPDATE SET last_seen = excluded.last_seen
         WHERE query_shapes.last_seen < ?`,
        d.environment,
        s.fingerprint,
        clip(s.sampleSql, STORED_SQL),
        s.kind,
        JSON.stringify(s.tables),
        now,
        stale,
      )
      this.sql.exec(
        `INSERT INTO query_stats (environment, fingerprint, hour, calls, total_ms, max_ms, errors, rows)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (environment, fingerprint, hour) DO UPDATE SET
           calls = calls + excluded.calls, total_ms = total_ms + excluded.total_ms,
           max_ms = MAX(max_ms, excluded.max_ms), errors = errors + excluded.errors, rows = rows + excluded.rows`,
        d.environment,
        s.fingerprint,
        Math.floor(s.start / HOUR_MS),
        s.calls,
        s.totalMs,
        s.maxMs,
        s.errors,
        s.rows,
      )
    }
  }

  /** When each environment first reported each release: the baselines of `regressions`. */
  private recordRelease(d: Digest) {
    if (!d.release) return
    const key = JSON.stringify([d.environment, d.release])
    if (this.knownReleases.has(key)) return
    this.sql.exec('INSERT OR IGNORE INTO releases (environment, release, first_seen) VALUES (?, ?, ?)', d.environment, d.release, Date.now())
    this.knownReleases.add(key)
  }

  /** The latest code around each origin; unchanged code writes nothing. */
  private recordSources(sources: SourceSnippet[]) {
    const now = new Date().toISOString()
    for (const s of sources) {
      this.sql.exec(
        `INSERT INTO sources (origin, first_line, lines_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (origin) DO UPDATE SET first_line = excluded.first_line, lines_json = excluded.lines_json,
           updated_at = excluded.updated_at
         WHERE sources.lines_json != excluded.lines_json OR sources.first_line != excluded.first_line`,
        s.origin,
        s.firstLine,
        JSON.stringify(s.lines),
        now,
      )
    }
  }

  async alarm(): Promise<void> {
    const cutoff = Math.floor(Date.now() / HOUR_MS) - STATS_RETENTION_HOURS
    this.sql.exec('DELETE FROM query_stats WHERE hour < ?', cutoff)
    this.sql.exec('DELETE FROM sources WHERE origin NOT IN (SELECT origin FROM sources ORDER BY updated_at DESC LIMIT ?)', SOURCES_KEPT)
    this.sql.exec('DELETE FROM requests WHERE at < ?', new Date(Date.now() - HISTORY_DAYS * 24 * HOUR_MS).toISOString())
    await this.ctx.storage.setAlarm(Date.now() + 24 * HOUR_MS)
  }

  // ───────────────────────────── reading ─────────────────────────────

  async issues(q: IssueQuery): Promise<Issue[]> {
    const order = {
      last_seen: 'last_seen DESC',
      first_seen: 'first_seen DESC',
      times_seen: 'times_seen DESC, last_seen DESC',
      impact: 'impact_ms DESC, last_seen DESC',
    }[q.sort ?? 'last_seen']
    const search = q.search?.trim() ? `%${q.search.trim()}%` : null
    return this.sql
      .exec(
        `SELECT * FROM issues
         WHERE (?1 IS NULL OR environment = ?1) AND (?2 IS NULL OR status = ?2)
           AND (?3 IS NULL OR title LIKE ?3 OR sample_sql LIKE ?3 OR origins_json LIKE ?3 OR transaction_name LIKE ?3)
         ORDER BY ${order} LIMIT ?4`,
        q.environment ?? null,
        q.status ?? null,
        search,
        Math.min(Math.max(q.limit ?? 100, 1), 500),
      )
      .toArray()
      .map(issueFromRow)
  }

  async issue(id: number): Promise<IssueDetail | null> {
    const r = this.sql.exec('SELECT * FROM issues WHERE id = ?', id).toArray()[0]
    if (!r) return null
    return {
      issue: issueFromRow(r),
      fingerprint: String(r.fingerprint),
      sampleSql: String(r.sample_sql),
      parentSql: (r.parent_sql as string | null) ?? null,
      origins: JSON.parse(String(r.origins_json)) as OriginCount[],
      fix: r.fix_json ? JSON.parse(String(r.fix_json)) : null,
      resolvedAt: (r.resolved_at as string | null) ?? null,
    }
  }

  async setStatus(id: number, status: IssueStatus): Promise<IssueDetail | null> {
    this.sql.exec(
      `UPDATE issues SET status = ?2, resolved_at = CASE WHEN ?2 = 'resolved' THEN ?3 ELSE NULL END,
         regressed = CASE WHEN ?2 = 'unresolved' THEN regressed ELSE 0 END
       WHERE id = ?1`,
      id,
      status,
      new Date().toISOString(),
    )
    return this.issue(id)
  }

  /** The query history, newest first; `before` (a request id) pages back. */
  async requests(before: number | null, limit: number): Promise<StoredRequest[]> {
    return this.sql
      .exec('SELECT * FROM requests WHERE (?1 IS NULL OR id < ?1) ORDER BY id DESC LIMIT ?2', before, Math.min(Math.max(limit, 1), 500))
      .toArray()
      .map(requestFromRow)
  }

  async request(id: number): Promise<StoredRequest | null> {
    const r = this.sql.exec('SELECT * FROM requests WHERE id = ?', id).toArray()[0]
    return r ? requestFromRow(r) : null
  }

  async events(id: number, limit = EVENTS_PER_ISSUE): Promise<IssueEvent[]> {
    return this.sql
      .exec('SELECT * FROM issue_events WHERE issue_id = ? ORDER BY id DESC LIMIT ?', id, Math.min(Math.max(limit, 1), EVENTS_PER_ISSUE))
      .toArray()
      .map((r) => ({
        id: Number(r.id),
        at: String(r.at),
        release: (r.release as string | null) ?? null,
        transaction: (r.transaction_name as string | null) ?? null,
        durationMs: Number(r.duration_ms),
        finding: JSON.parse(String(r.finding_json)) as CaptureFinding,
        statements: JSON.parse(String(r.statements_json)) as CapturedStatement[],
      }))
  }

  /** Statement shapes by total time over the last `hours`, or one shape when `fingerprint` is set. */
  async queries(environment: string | null, hours: number, limit = 50, fingerprint: string | null = null): Promise<QueryShape[]> {
    const since = Math.floor(Date.now() / HOUR_MS) - Math.min(Math.max(hours, 1), STATS_RETENTION_HOURS) + 1
    return this.sql
      .exec(
        `SELECT s.fingerprint, MIN(q.sample_sql) AS sample_sql, MIN(q.kind) AS kind, MIN(q.tables_json) AS tables_json,
                SUM(s.calls) AS calls, SUM(s.total_ms) AS total_ms, MAX(s.max_ms) AS max_ms, SUM(s.errors) AS errors,
                SUM(s.rows) AS rows, MAX(q.last_seen) AS last_seen
         FROM query_stats s JOIN query_shapes q USING (environment, fingerprint)
         WHERE (?1 IS NULL OR s.environment = ?1) AND s.hour >= ?2 AND (?4 IS NULL OR s.fingerprint = ?4)
         GROUP BY s.fingerprint ORDER BY SUM(s.total_ms) DESC LIMIT ?3`,
        environment,
        since,
        Math.min(Math.max(limit, 1), 500),
        fingerprint,
      )
      .toArray()
      .map((r) => {
        const calls = Number(r.calls)
        const totalMs = Number(r.total_ms)
        return {
          fingerprint: String(r.fingerprint),
          sampleSql: String(r.sample_sql),
          kind: r.kind as QueryShape['kind'],
          tables: JSON.parse(String(r.tables_json)) as string[],
          calls,
          totalMs,
          meanMs: calls > 0 ? totalMs / calls : 0,
          maxMs: Number(r.max_ms),
          errors: Number(r.errors),
          rows: Number(r.rows),
          lastSeen: String(r.last_seen),
        }
      })
  }

  // ───────────────────────────── fixing ─────────────────────────────

  /** What a coding agent or a model needs to fix an issue. */
  async issueContext(id: number): Promise<IssueContext | null> {
    const detail = await this.issue(id)
    const projectId = this.meta('id')
    if (!detail || !projectId) return null
    const [latest] = await this.events(id, 1)
    return {
      project: { id: projectId, name: this.meta('name') ?? projectId, orm: (this.meta('orm') as Orm | null) ?? null },
      detail,
      latest: latest ?? null,
      sources: this.sourcesFor(detail.origins.slice(0, SOURCES_PER_ISSUE).map((o) => o.origin)),
    }
  }

  /** The code around one line, when the SDK sent it. */
  async source(origin: string): Promise<SourceSnippet | null> {
    return this.sourcesFor([origin])[0] ?? null
  }

  private sourcesFor(origins: string[]): SourceSnippet[] {
    if (origins.length === 0) return []
    return this.sql
      .exec(`SELECT * FROM sources WHERE origin IN (${origins.map(() => '?').join(', ')})`, ...origins)
      .toArray()
      .map((r) => ({ origin: String(r.origin), firstLine: Number(r.first_line), lines: JSON.parse(String(r.lines_json)) as string[] }))
      .sort((a, b) => origins.indexOf(a.origin) - origins.indexOf(b.origin))
  }

  /** The stored suggestion for an issue, and the hash of the context it was written from. */
  async storedSuggestion(issueId: number): Promise<{ inputHash: string; suggestion: Suggestion } | null> {
    const r = this.sql.exec('SELECT input_hash, suggestion_json FROM suggestions WHERE issue_id = ?', issueId).toArray()[0]
    return r ? { inputHash: String(r.input_hash), suggestion: JSON.parse(String(r.suggestion_json)) as Suggestion } : null
  }

  async saveSuggestion(suggestion: Suggestion, inputHash: string): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO suggestions (issue_id, input_hash, suggestion_json) VALUES (?, ?, ?)',
      suggestion.issueId,
      inputHash,
      JSON.stringify(suggestion),
    )
  }

  // ───────────────────────────── regressions ─────────────────────────────

  /** Statement shapes that got slower or started failing in `environment` (see analysis/regressions.ts). */
  async regressions(environment: string, nowMs = Date.now()): Promise<RegressionReport> {
    const releases = this.sql
      .exec('SELECT release, first_seen FROM releases WHERE environment = ? ORDER BY first_seen DESC LIMIT 2', environment)
      .toArray()
      .map((r): ReleaseSeen => ({ release: String(r.release), firstSeenMs: Number(r.first_seen) }))
    const c = comparison(releases, nowMs)
    const shapes = this.sql
      .exec(
        `SELECT s.fingerprint, MIN(q.sample_sql) AS sample_sql, MIN(q.kind) AS kind, MIN(q.tables_json) AS tables_json,
           SUM(CASE WHEN s.hour < ?3 THEN s.calls ELSE 0 END) AS b_calls,
           SUM(CASE WHEN s.hour < ?3 THEN s.total_ms ELSE 0 END) AS b_ms,
           SUM(CASE WHEN s.hour < ?3 THEN s.errors ELSE 0 END) AS b_errors,
           SUM(CASE WHEN s.hour < ?3 THEN 1 ELSE 0 END) AS b_hours,
           SUM(CASE WHEN s.hour >= ?4 THEN s.calls ELSE 0 END) AS a_calls,
           SUM(CASE WHEN s.hour >= ?4 THEN s.total_ms ELSE 0 END) AS a_ms,
           SUM(CASE WHEN s.hour >= ?4 THEN s.errors ELSE 0 END) AS a_errors,
           SUM(CASE WHEN s.hour >= ?4 THEN 1 ELSE 0 END) AS a_hours
         FROM query_stats s JOIN query_shapes q USING (environment, fingerprint)
         WHERE s.environment = ?1 AND s.hour >= ?2 AND (s.hour < ?3 OR s.hour >= ?4)
         GROUP BY s.fingerprint`,
        environment,
        c.beforeFrom,
        c.beforeTo,
        c.afterFrom,
      )
      .toArray()
      .map(
        (r): ShapeTotals => ({
          fingerprint: String(r.fingerprint),
          sampleSql: String(r.sample_sql),
          kind: r.kind as ShapeTotals['kind'],
          tables: JSON.parse(String(r.tables_json)) as string[],
          before: { calls: Number(r.b_calls), totalMs: Number(r.b_ms), errors: Number(r.b_errors), hours: Number(r.b_hours) },
          after: { calls: Number(r.a_calls), totalMs: Number(r.a_ms), errors: Number(r.a_errors), hours: Number(r.a_hours) },
        }),
      )
    const regressions: Regression[] = judge(shapes)
      .slice(0, REGRESSIONS)
      .map((r, i) => ({ ...r, latest: i < REGRESSION_LINKS ? this.latestRun(environment, r.fingerprint) : null }))
    return { environment, baseline: c.baseline, regressions }
  }

  /** The newest stored run of a statement shape among the latest requests, to link to. */
  private latestRun(environment: string, fingerprint: string): { request: number; seq: number } | null {
    const r = this.sql
      .exec(
        `SELECT id, statements_json FROM requests
         WHERE environment = ? AND id > (SELECT COALESCE(MAX(id), 0) - ? FROM requests) AND instr(statements_json, ?) > 0
         ORDER BY id DESC LIMIT 1`,
        environment,
        LINK_SEARCH_REQUESTS,
        `"fingerprint":${JSON.stringify(fingerprint)}`,
      )
      .toArray()[0]
    if (!r) return null
    const statements = JSON.parse(String(r.statements_json)) as CapturedStatement[]
    const run = statements.findLast((s) => s.fingerprint === fingerprint)
    return run ? { request: Number(r.id), seq: run.seq } : null
  }

  async environments(): Promise<string[]> {
    return this.sql
      .exec<{ environment: string }>(
        'SELECT environment FROM issues UNION SELECT environment FROM query_shapes ORDER BY 1',
      )
      .toArray()
      .map((r) => r.environment)
  }

  // ───────────────────────────── live feed ─────────────────────────────

  /** A dashboard's WebSocket (the Worker has checked its token). */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 })
    }
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.send(JSON.stringify({ type: 'hello', connections: this.ctx.getWebSockets().length }))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(): Promise<void> {
    // Dashboards only listen; pings are auto-answered.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }

  private broadcast(events: LiveEvent[]) {
    if (events.length === 0) return
    const sockets = this.ctx.getWebSockets()
    if (sockets.length === 0) return
    const message = JSON.stringify({ type: 'batch', events })
    for (const ws of sockets) {
      try {
        ws.send(message)
      } catch {
        // A closing socket; the runtime will call webSocketClose.
      }
    }
  }
}
