// Shared test data: an N+1 issue as the backend stores it.
import type { CapturedStatement } from '../bindings/CapturedStatement'
import type { IssueContext } from '../shared/api'
import type { JsonModel, JsonRequest } from '../worker/ai/model.ts'

export function statement(seq: number, sql: string, extra: Partial<CapturedStatement> = {}): CapturedStatement {
  return {
    seq,
    conn: 1,
    atMs: seq,
    durationMs: 1,
    fingerprint: sql.includes('order_items') ? 'fp-items' : 'fp-orders',
    sql,
    params: ['#ab'],
    rows: 1,
    bytes: 0,
    error: null,
    unit: 'transaction',
    origin: 'src/routes/orders.js:42',
    route: 'GET /orders',
    ...extra,
  }
}

export const ITEMS_SQL = 'SELECT "id" FROM "order_items" WHERE "order_id" = ?'

export const SOURCE_LINES = [
  "router.get('/orders', async (req, res) => {",
  '  const orders = await Order.findAll()',
  '  for (const order of orders) {',
  '    order.items = await OrderItem.findAll({ where: { orderId: order.id } })',
  '  }',
  '  res.json(orders)',
  '})',
]

export function context(overrides: Partial<IssueContext> = {}): IssueContext {
  return {
    project: { id: '0123456789ab', name: 'Shop API', orm: 'sequelize' },
    detail: {
      issue: {
        id: 7,
        environment: 'production',
        kind: 'n_plus_one',
        severity: 'high',
        title: 'N+1: order_items loaded once per order',
        detail: 'The same SELECT ran 8 times, once per row of the previous query.',
        culprit: 'src/routes/orders.js:42',
        transaction: 'GET /orders',
        status: 'unresolved',
        regressed: false,
        timesSeen: 40,
        occurrences: 320,
        impactMs: 1250,
        firstSeen: '2026-10-19T10:00:00.000Z',
        lastSeen: '2026-10-20T10:00:00.000Z',
        firstRelease: 'r1',
        lastRelease: 'r2',
      },
      fingerprint: 'fp-items',
      sampleSql: ITEMS_SQL,
      parentSql: 'SELECT "id" FROM "orders"',
      origins: [{ origin: 'src/routes/orders.js:42', count: 37 }],
      fix: { orm: 'sequelize', text: 'Load the items with the orders: `include`.', code: 'Order.findAll({ include: OrderItem })', ddl: null },
      resolvedAt: null,
    },
    latest: {
      id: 1,
      at: '2026-10-20T10:00:00.000Z',
      release: 'r2',
      transaction: 'GET /orders',
      durationMs: 40,
      finding: {
        id: 'n_plus_one:fp-items',
        kind: 'n_plus_one',
        severity: 'high',
        title: 'N+1',
        detail: '',
        fingerprint: 'fp-items',
        parentFingerprint: 'fp-orders',
        impactMs: 8,
        occurrences: 8,
        origins: [],
        fix: null,
      },
      statements: [statement(1, 'SELECT "id" FROM "orders"'), ...Array.from({ length: 8 }, (_, i) => statement(i + 2, ITEMS_SQL))],
    },
    sources: [{ origin: 'src/routes/orders.js:42', firstLine: 39, lines: SOURCE_LINES }],
    ...overrides,
  }
}

/** A model that answers with `reply` and remembers what it was asked. */
export function fakeModel(reply: unknown): JsonModel & { asked: JsonRequest[] } {
  const asked: JsonRequest[] = []
  return {
    name: '@cf/test/model',
    asked,
    async json(request) {
      asked.push(request)
      return reply
    },
  }
}
