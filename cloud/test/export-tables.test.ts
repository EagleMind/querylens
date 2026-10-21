import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Project } from '../bindings/Project'
import type { StoredRequest } from '../bindings/StoredRequest'
import { runsTable, shapesTable, requestSql, requestTable } from '../web/lib/export/tables.ts'
import { flatten, groupByShape, withProject } from '../web/lib/queries.ts'
import { statement } from './fixtures.ts'

const project: Project = {
  id: '0123456789ab',
  name: 'Shop',
  backends: [{ id: '1a2b3c4d', name: 'orders', dsn: 'https://k@h/0123456789ab', orm: 'sequelize', createdAt: '', lastSeen: null }],
  settings: { slowMs: 100, loopMin: 5, chatty: 50, largeRows: 1000, liveSampleRate: 0.05 },
  createdAt: '',
}

const ITEMS = 'SELECT * FROM order_items WHERE order_id = ?'
const request: StoredRequest = {
  id: 9,
  backend: '1a2b3c4d',
  environment: 'production',
  release: 'r2',
  name: 'GET /orders',
  at: '2026-10-21T10:00:00.000Z',
  durationMs: 12.5,
  dbMs: 4.123456,
  statements: [
    statement(2, ITEMS, { atMs: 3, durationMs: 1.0004, origin: 'src/orders.js:16' }),
    statement(1, 'SELECT * FROM orders;', { atMs: 1, durationMs: 2, origin: 'src/orders.js:12', rows: 2 }),
    statement(3, ITEMS, { atMs: 4, durationMs: 1, origin: 'src/orders.js:16', error: 'deadlock\n detected' }),
  ],
  findings: [{ issueId: 7, fingerprint: 'fp-items', kind: 'n_plus_one', severity: 'high', title: '' }],
}

test('a request exports its statements in the order they ran, with service and issues', () => {
  const t = requestTable(project, request)
  assert.deepEqual(t.rows.map((r) => r.seq), [1, 2, 3])
  assert.deepEqual(t.rows[1], {
    seq: 2,
    startMs: 3,
    durationMs: 1,
    code: 'src/orders.js:16',
    type: 'SELECT',
    sql: ITEMS,
    rows: 1,
    error: null,
    connection: 1,
    issues: 'N+1 query',
    service: 'orders',
    environment: 'production',
    release: 'r2',
    fingerprint: 'fp-items',
  })
})

test('a request as SQL: one terminated statement each, with where and how long', () => {
  assert.equal(
    requestSql(project, request),
    [
      '-- QueryLens: GET /orders, orders, production, release r2',
      '-- 2026-10-21T10:00:00.000Z, 3 statements, 4.123 ms in the database of 12.5 ms',
      '',
      '-- #1, 2 ms, 2 rows, src/orders.js:12\nSELECT * FROM orders;\n',
      `-- #2, 1 ms, 1 rows, src/orders.js:16\n${ITEMS};\n`,
      `-- #3, 1 ms, 1 rows, src/orders.js:16, failed: deadlock detected\n${ITEMS};\n`,
    ].join('\n'),
  )
})

test('the Live list exports every run, or every shape with its totals', () => {
  const live = withProject(project.id, request)
  const runs = runsTable(project, flatten([live]))
  assert.equal(runs.rows.length, 3)
  assert.equal(runs.rows[0].service, 'orders')
  const shapes = shapesTable(project, groupByShape(flatten([live])))
  const items = shapes.rows.find((r) => r.fingerprint === 'fp-items')!
  assert.deepEqual([items.runs, items.failed, items.issues, items.requests], [2, 1, 'N+1 query', 'GET /orders'])
})
