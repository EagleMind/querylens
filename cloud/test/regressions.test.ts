import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BEFORE_HOURS, HOUR_MS, type ShapeTotals, comparison, judge } from '../worker/analysis/regressions.ts'

const shape = (before: Partial<ShapeTotals['before']>, after: Partial<ShapeTotals['after']>, fingerprint = 'fp'): ShapeTotals => ({
  fingerprint,
  sampleSql: 'SELECT * FROM orders WHERE id = ?',
  kind: 'select',
  tables: ['orders'],
  before: { calls: 1000, totalMs: 2000, errors: 0, hours: 100, ...before },
  after: { calls: 100, totalMs: 200, errors: 0, hours: 10, ...after },
})

test('compares across the latest release, leaving the deploy hour out', () => {
  const deploy = Date.UTC(2026, 9, 20, 9, 30)
  const c = comparison([{ release: 'r2', firstSeenMs: deploy }, { release: 'r1', firstSeenMs: deploy - 86_400_000 }], deploy + 5 * HOUR_MS)
  const hour = Math.floor(deploy / HOUR_MS)
  assert.deepEqual(c.baseline, { kind: 'release', release: 'r2', previous: 'r1', since: new Date(deploy).toISOString() })
  assert.deepEqual([c.beforeFrom, c.beforeTo, c.afterFrom], [hour - BEFORE_HOURS, hour, hour + 1])
})

test('without releases, the last day against the week before', () => {
  const now = Date.UTC(2026, 9, 20, 12, 10)
  const c = comparison([], now)
  const split = Math.floor(now / HOUR_MS) - 23
  assert.equal(c.baseline.kind, 'window')
  assert.deepEqual([c.beforeFrom, c.beforeTo, c.afterFrom], [split - BEFORE_HOURS, split, split])
})

test('a statement twice as slow is a regression; noise and small changes are not', () => {
  const slower = judge([shape({}, { totalMs: 600 })])
  assert.equal(slower.length, 1)
  assert.equal(slower[0].regression, 'slower')
  assert.equal(slower[0].before.meanMs, 2)
  assert.equal(slower[0].after.meanMs, 6)
  assert.equal(slower[0].costPerHour, 4 * 10, '4 ms more × 10 calls an hour')
  assert.deepEqual(judge([shape({}, { totalMs: 260 })]), [], 'only 1.3× slower')
  assert.deepEqual(judge([shape({ totalMs: 500 }, { totalMs: 150 })]), [], '1 ms more is under the floor')
  assert.deepEqual(judge([shape({}, { calls: 10, totalMs: 600 })]), [], 'too few calls to tell')
})

test('a statement that starts failing is a regression, ranked first', () => {
  const found = judge([shape({}, { totalMs: 600 }, 'slow'), shape({ errors: 1 }, { errors: 9 }, 'failing')])
  assert.deepEqual(
    found.map((r) => [r.fingerprint, r.regression]),
    [
      ['failing', 'failing'],
      ['slow', 'slower'],
    ],
  )
  assert.deepEqual(judge([shape({ errors: 50 }, { errors: 6 })]), [], 'it failed as often before')
  assert.deepEqual(judge([shape({}, { errors: 3 })]), [], 'too few failures')
})
