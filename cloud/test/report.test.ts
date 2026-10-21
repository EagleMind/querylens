import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { IssueDetail } from '../bindings/IssueDetail'
import type { LiveFinding } from '../bindings/LiveFinding'
import type { ProjectSettings } from '../bindings/ProjectSettings'
import { type LiveRequest, queriesOf, withProject } from '../web/lib/queries.ts'
import { eventLog, missingParts, primaryFix, problemsOf, verdict } from '../web/lib/report.ts'
import { context, statement } from './fixtures.ts'

const SETTINGS: ProjectSettings = { slowMs: 100, loopMin: 5, chatty: 50, largeRows: 1000, liveSampleRate: 0.05 }

const EVENTS = 'SELECT "id", "kind" FROM "events" WHERE "user_id" = ?'

function request(findings: LiveFinding[], statements = [statement(1, 'SELECT "id" FROM "users" WHERE "id" = ?', { atMs: 0.4, durationMs: 1.1 }), statement(2, EVENTS, { atMs: 5.4, durationMs: 132, rows: 1100, fingerprint: 'fp-events' })]): LiveRequest {
  return withProject('0123456789ab', { id: 9, environment: 'production', release: 'r2', name: 'GET /events', at: '2026-10-21T10:00:00.000Z', durationMs: 161.1, dbMs: 133.1, statements, findings })
}

const finding = (issueId: number, kind: LiveFinding['kind'], severity: LiveFinding['severity']): LiveFinding => ({ issueId, fingerprint: 'fp-events', kind, severity, title: '' })

function detail(id: number, withFix: boolean): IssueDetail {
  const d = context().detail
  return { ...d, issue: { ...d.issue, id, impactMs: id * 10 }, fix: withFix ? d.fix : null }
}

test('problems read most serious first, and a slow query is tied to the rows it loads', () => {
  const r = request([finding(2, 'slow_query', 'low'), finding(1, 'large_result', 'medium')])
  const qs = queriesOf(r)
  const q = qs[1]
  const problems = problemsOf(q, qs, new Map([[1, detail(1, true)], [2, detail(2, false)]]), SETTINGS)
  assert.deepEqual(problems.map((p) => p.headline), ['Loads 1,100 rows at once', 'Takes 132 ms, over your 100 ms limit'])
  assert.equal(problems[1].causedBy, problems[0], 'the slowness is put down to the rows')
  assert.equal(primaryFix(problems), problems[0])
  assert.deepEqual(verdict(q, problems), { tone: 'warning', title: '2 problems with this query' })
  assert.deepEqual(verdict(qs[0], []), { tone: 'ok', title: 'No problems in this run' })
})

test('a failure comes first and makes the verdict', () => {
  const r = request([finding(1, 'large_result', 'medium')], [statement(1, EVENTS, { fingerprint: 'fp-events', rows: 1100, error: 'ERROR: canceling statement due to statement timeout (57014)' })])
  const [q] = queriesOf(r)
  const problems = problemsOf(q, [q], new Map(), SETTINGS)
  assert.deepEqual(problems.map((p) => p.kind), ['query_errors', 'large_result'], 'a failure without an issue still shows')
  assert.deepEqual(verdict(q, problems), { tone: 'danger', title: 'This query failed, and has 1 more problem' })
})

test('the request reads as an event log: gaps are time in your code, runs fold', () => {
  const statements = [
    statement(1, 'SELECT "id" FROM "orders"', { atMs: 1, durationMs: 2, rows: 8, fingerprint: 'fp-orders', conn: 1 }),
    ...[0, 1, 2].map((i) => statement(2 + i, 'SELECT "id" FROM "order_items" WHERE "order_id" = ?', { atMs: 5 + i * 1.5, durationMs: 1, rows: 2, fingerprint: 'fp-items', conn: 2 })),
  ]
  const r = request([{ issueId: 3, fingerprint: 'fp-items', kind: 'n_plus_one', severity: 'medium', title: '' }], statements)
  const log = eventLog(r, queriesOf(r))
  assert.deepEqual(
    log.lines.map((l) => (l.type === 'statement' ? `${l.type} ×${l.runs.length} ${l.kinds.join(',')}` : `${l.type} +${l.at}`)),
    ['start +0', 'code +0', 'statement ×1 ', 'code +3', 'statement ×3 n_plus_one', 'code +9', 'end +161.1'],
  )
  assert.equal(log.dbMs, 5)
  assert.equal(log.codeMs, 156.1)
  assert.equal(log.connections, 2)
})

test('what the page can’t show, and why', () => {
  const sent = request([])
  const q = queriesOf(sent)[1]
  assert.deepEqual(missingParts(q, null, undefined).map((m) => m.key), ['source-context', 'values'], 'no code from the SDK, values hashed')
  assert.deepEqual(missingParts(q, undefined, undefined).map((m) => m.key), ['values'], 'nothing claimed while the code is still loading')
  const bare = withProject('0123456789ab', { ...sent, release: null, statements: [statement(1, EVENTS, { origin: null, params: ['42'] })] })
  const ai = { suggestion: null, stale: false, unavailable: 'ai_unavailable' as const }
  assert.deepEqual(missingParts(queriesOf(bare)[0], null, ai).map((m) => m.key), ['line-of-code', 'releases', 'ai'])
})
