/**
 * Browser-only stand-in for the Rust backend, used when the UI runs outside Tauri
 * (`pnpm dev` in a normal browser). Lets the UI be developed and reviewed without a
 * database or LLM. Never bundled into the desktop app's code path: `ipc.ts` only
 * imports it when `isTauri()` is false.
 *
 * The plan fixture is real output, captured from the dev Postgres by
 * `QUERYLENS_WRITE_FIXTURE=1 cargo test --test live_postgres`.
 */
import type { AnalysisResult } from '@/bindings/AnalysisResult'
import type { DiffNode } from '@/bindings/DiffNode'
import type { DiffSide } from '@/bindings/DiffSide'
import type { PlanDiff } from '@/bindings/PlanDiff'
import type { PlanNode } from '@/bindings/PlanNode'
import type { Connection } from '@/bindings/Connection'
import type { ConnectionInput } from '@/bindings/ConnectionInput'
import type { HistoryEntry } from '@/bindings/HistoryEntry'
import type { Settings } from '@/bindings/Settings'
import type { SuggestionEvent } from '@/bindings/SuggestionEvent'
import type { SuggestionSet } from '@/bindings/SuggestionSet'
import type { WhatIfEvent } from '@/bindings/WhatIfEvent'
import type { WhatIfResult } from '@/bindings/WhatIfResult'

import fixture from './fixtures/postgres-analysis.json'

const now = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const connections: Connection[] = [
  {
    id: 'demo-pg',
    name: 'dev-shop',
    engine: 'postgres',
    color: '#2dd4bf',
    host: 'localhost',
    port: 54329,
    database: 'shop',
    username: 'querylens',
    sslMode: 'disable',
    filePath: null,
    hasPassword: true,
    createdAt: now(),
    lastUsedAt: now(),
  },
  {
    id: 'demo-duck',
    name: 'analytics',
    engine: 'duckdb',
    color: '#a78bfa',
    host: null,
    port: null,
    database: null,
    username: null,
    sslMode: 'disable',
    filePath: ':memory:',
    hasPassword: false,
    createdAt: now(),
    lastUsedAt: null,
  },
]

let settings: Settings = {
  llm: {
    provider: 'claude_code',
    baseUrl: '',
    model: '',
    temperature: 0.2,
    claudePath: '',
    verifyWithTools: true,
    hasApiKey: false,
  },
  analysis: { defaultMode: 'analyze', statementTimeoutMs: 30000, lockTimeoutMs: 5000, repeatRuns: 3 },
}

const analyses = new Map<string, AnalysisResult>()
/** Unsaved analyses (fix previews, what-if scenarios). */
const scratch = new Map<string, AnalysisResult>()

function toEntry(a: AnalysisResult): HistoryEntry {
  return {
    id: a.id,
    connectionId: a.connectionId,
    connectionName: a.connectionName,
    engine: a.engine,
    mode: a.mode,
    sqlPreview: a.sql.slice(0, 400),
    executionTimeMs: a.executionTimeMs,
    totalCost: a.totalCost,
    warningsCount: a.warningsCount,
    hasSuggestions: !!a.suggestions,
    createdAt: a.analyzedAt,
  }
}

function fail(kind: string, message: string): never {
  throw { kind, message }
}

export async function mockInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  await sleep(command === 'analyze_query' ? 900 : 60)
  const result = ((): unknown => {
    switch (command) {
      case 'list_connections':
        return connections
      case 'save_connection': {
        const input = args.input as ConnectionInput
        const id = input.id ?? crypto.randomUUID()
        const existing = connections.find((c) => c.id === id)
        const { password, ...rest } = input
        const conn: Connection = {
          ...rest,
          id,
          hasPassword: password == null ? !!existing?.hasPassword : password !== '',
          createdAt: existing?.createdAt ?? now(),
          lastUsedAt: existing?.lastUsedAt ?? null,
        }
        if (existing) Object.assign(existing, conn)
        else connections.push(conn)
        return conn
      }
      case 'delete_connection':
        connections.splice(
          connections.findIndex((c) => c.id === args.id),
          1,
        )
        return null
      case 'test_connection':
        return { latencyMs: 4.2, serverVersion: 'PostgreSQL 17.6 (mock)' }
      case 'analyze_query': {
        const sql = String(args.sql).trim()
        if (/^\s*$/.test(sql)) fail('validation', 'Enter a SQL statement to analyze.')
        if (/\bnope\b/i.test(sql)) fail('database', 'relation "nope" does not exist')
        const conn = connections.find((c) => c.id === args.connectionId)!
        const prev = [...analyses.values()].reverse().find((p) => p.sql === sql && p.connectionId === conn.id)
        const a = {
          ...(fixture as unknown as AnalysisResult),
          id: crypto.randomUUID(),
          connectionId: conn.id,
          connectionName: conn.name,
          sql,
          analyzedAt: now(),
          suggestions: null,
          baseline: prev
            ? { previousId: prev.id, previousAt: prev.analyzedAt, planChanged: false, timeRatio: 1.6 }
            : null,
        } satisfies AnalysisResult
        analyses.set(a.id, a)
        conn.lastUsedAt = now()
        return a
      }
      case 'compare_analyses': {
        const find = (id: unknown) => analyses.get(String(id)) ?? scratch.get(String(id))!
        return mockDiff(find(args.beforeId), find(args.afterId))
      }
      case 'preview_fix': {
        const base = analyses.get(String(args.analysisId))!
        const after = { ...base, id: crypto.randomUUID(), analyzedAt: now() }
        scratch.set(after.id, after)
        return after
      }
      case 'list_history': {
        const q = String(args.search ?? '').toLowerCase()
        return [...analyses.values()]
          .reverse()
          .filter((a) => !q || a.sql.toLowerCase().includes(q) || a.connectionName.toLowerCase().includes(q))
          .map(toEntry)
      }
      case 'get_analysis':
        return analyses.get(String(args.id)) ?? fail('not_found', 'Analysis not found in history')
      case 'delete_analysis':
        analyses.delete(String(args.id))
        return null
      case 'clear_history':
        analyses.clear()
        return null
      case 'get_settings':
        return settings
      case 'save_settings':
        settings = args.settings as Settings
        if (typeof args.apiKey === 'string') settings.llm.hasApiKey = args.apiKey !== ''
        return settings
      case 'list_llm_models':
        return ['sonnet', 'opus', 'haiku']
      case 'test_llm':
        return { latencyMs: 812, reply: 'QueryLens OK' }
      default:
        return fail('internal', `mock: unknown command ${command}`)
    }
  })()
  return structuredClone(result) as T
}

const CANNED: Omit<SuggestionSet, 'createdAt'> = {
  provider: 'Claude Code',
  model: 'mock',
  summary:
    'Most of the time goes into a parallel full scan of orders that keeps only paid orders and then hash-joins them against users from one country.',
  suggestions: [
    {
      severity: 'high',
      title: 'Index orders by (user_id, status) for the join',
      explanation:
        'Only ~17k users match the country filter, so a nested loop with an index probe per user beats scanning all 1M orders. Measured with a test index: 63 ms → 9 ms.',
      sqlFix:
        "CREATE INDEX CONCURRENTLY orders_user_id_status_idx\n  ON orders (user_id) INCLUDE (total)\n  WHERE status = 'paid';",
      nodeId: '0.0.0.0.0.0.0',
      verified: true,
      evidence: 'measured',
    },
    {
      severity: 'medium',
      title: 'Index users.country to avoid scanning every user',
      explanation:
        'Each worker scans all 100k users to build its hash table. A small index on country makes the build side about 6× cheaper.',
      sqlFix: 'CREATE INDEX CONCURRENTLY users_country_idx ON users (country);',
      nodeId: '0.0.0.0.0.0.1.0',
      verified: false,
      evidence: null,
    },
    {
      severity: 'low',
      title: 'The sort and aggregate are already cheap',
      explanation: 'Top-N heapsort over 3.3k groups takes under 1 ms. No action needed.',
      sqlFix: null,
      nodeId: '0.0',
      verified: false,
      evidence: null,
    },
  ],
}

export async function mockSuggestions(analysisId: string, onEvent: (e: SuggestionEvent) => void): Promise<string> {
  const requestId = crypto.randomUUID()
  ;(async () => {
    onEvent({ type: 'started', provider: 'Claude Code', model: 'mock' })
    await sleep(400)
    onEvent({ type: 'activity', label: 'Claude Code session started', detail: 'mock' })
    await sleep(700)
    onEvent({
      type: 'activity',
      label: 'Testing a fix with EXPLAIN',
      detail: "CREATE INDEX ON orders (user_id) WHERE status = 'paid'\n\nSELECT u.email, count(*) …",
    })
    await sleep(1100)
    const text = JSON.stringify({ summary: CANNED.summary, suggestions: CANNED.suggestions }, null, 1)
    for (let i = 0; i < text.length; i += 18) {
      onEvent({ type: 'delta', text: text.slice(i, i + 18) })
      await sleep(16)
    }
    const set: SuggestionSet = { ...CANNED, createdAt: now() }
    const a = analyses.get(analysisId)
    if (a) a.suggestions = set
    onEvent({ type: 'done', result: set })
  })()
  return requestId
}

/** A plausible "after adding an index" comparison built from the fixture plan. */
function mockDiff(before: AnalysisResult, after: AnalysisResult): PlanDiff {
  const side = (n: PlanNode, faster: boolean): DiffSide => ({
    id: n.id,
    nodeType: n.nodeType,
    indexName: n.indexName,
    selfTimeMs: n.selfTimeMs == null ? null : faster ? n.selfTimeMs / 8 : n.selfTimeMs,
    selfCost: n.selfCost,
    actualRows: n.actualRows,
    estimatedRows: n.estimatedRows,
    loops: n.loops,
    heat: n.heat,
  })
  const walk = (n: PlanNode): DiffNode => {
    const swapped = n.nodeType.includes('Seq Scan') && n.relation === 'orders'
    return {
      status: swapped ? 'changed' : 'same',
      relation: n.relation,
      detail: n.detail,
      before: side(n, false),
      after: swapped
        ? { ...side(n, true), nodeType: 'Index Scan', indexName: 'orders_user_id_status_idx', heat: 'low' }
        : side(n, true),
      children: n.children.map(walk),
    }
  }
  return {
    beforeId: before.id,
    afterId: after.id,
    beforeSql: before.sql,
    afterSql: after.sql,
    beforeLabel: before.analyzedAt,
    afterLabel: after.analyzedAt,
    beforeMs: before.executionTimeMs,
    afterMs: (after.executionTimeMs ?? 0) / 8,
    beforeCost: before.totalCost,
    afterCost: after.totalCost,
    timed: true,
    planChanged: true,
    root: walk(before.root),
  }
}

const WHATIF: WhatIfResult[] = [
  {
    scenario: {
      kind: 'nestloop_off',
      label: 'Hash/merge joins instead of nested loops',
      setup: ['SET enable_nestloop = off'],
      rationale: '',
    },
    outcome: 'faster',
    planChanged: true,
    before: 103,
    after: 31,
    speedup: 3.3,
    timed: true,
    analysisId: null,
    verdict:
      "3.3× faster without nested loops. The planner's row estimates are wrong (cost model), not the schema. Fix the estimates (ANALYZE, extended statistics) rather than disabling nested loops globally.",
  },
  {
    scenario: { kind: 'work_mem', label: 'work_mem × 4 (16 MB)', setup: ["SET work_mem = '16384kB'"], rationale: '' },
    outcome: 'no_change',
    planChanged: false,
    before: 103,
    after: 103,
    speedup: 1,
    timed: true,
    analysisId: null,
    verdict: "Same plan. This lever doesn't matter for this query.",
  },
  {
    scenario: {
      kind: 'random_page_cost',
      label: 'SSD cost model (random_page_cost = 1.1)',
      setup: ['SET random_page_cost = 1.1'],
      rationale: '',
    },
    outcome: 'slower',
    planChanged: true,
    before: 103,
    after: 160,
    speedup: 0.64,
    timed: true,
    analysisId: null,
    verdict: "1.6× slower. The planner's current choice is right here.",
  },
]

export async function mockWhatif(analysisId: string, onEvent: (e: WhatIfEvent) => void): Promise<string> {
  ;(async () => {
    onEvent({ type: 'started', scenarios: WHATIF.map((r) => r.scenario) })
    for (const r of WHATIF) {
      onEvent({ type: 'running', kind: r.scenario.kind, phase: 'planning' })
      await sleep(500)
      if (r.planChanged) {
        onEvent({ type: 'running', kind: r.scenario.kind, phase: 'profiling' })
        await sleep(900)
      }
      onEvent({ type: 'result', result: r })
    }
    const report = { results: WHATIF, summary: WHATIF[0].verdict, createdAt: now() }
    const a = analyses.get(analysisId)
    if (a) a.whatif = report
    onEvent({ type: 'done', report })
  })()
  return crypto.randomUUID()
}
