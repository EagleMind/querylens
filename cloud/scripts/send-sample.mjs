// Send the backend a few requests the way querylens-node would, to try the dashboard
// without an app:
//
//   node scripts/send-sample.mjs <DSN> [rounds]
//
// Each round sends an envelope with an N+1 (GET /orders), a request writing rows one by
// one (POST /events), a clean request (GET /health) and a minute of statistics.
const [dsn, roundsArg] = process.argv.slice(2)
if (!dsn) {
  console.error('usage: node scripts/send-sample.mjs <DSN> [rounds]')
  process.exit(2)
}
const url = new URL(dsn)
const key = decodeURIComponent(url.username)
const project = url.pathname.replace(/^\/+|\/+$/g, '')
const endpoint = `${url.protocol}//${url.host}/api/${project}/envelope`
const rounds = Number(roundsArg ?? 1)

const ORDERS = 'SELECT "id", "user_id", "total" FROM "orders" AS "Order" WHERE "Order"."user_id" = ?;'
const ITEMS = 'SELECT "id", "order_id", "product_id" FROM "order_items" AS "OrderItem" WHERE "OrderItem"."order_id" = ?;'
const EVENT = 'INSERT INTO "events" ("id","kind","created_at") VALUES (DEFAULT,?,?) RETURNING "id","kind","created_at";'
const HEALTH = 'SELECT ?+? AS result'

function nPlusOne(start) {
  const n = 8 + Math.floor(Math.random() * 10)
  const queries = [{ at: 0, durationMs: 2.4, sql: ORDERS, vh: 'u1', rows: n, origin: 'src/routes/orders.js:12' }]
  for (let i = 0; i < n; i++) {
    queries.push({ at: 3 + i * 1.3, durationMs: 0.9 + Math.random(), sql: ITEMS, vh: `o${i}`, rows: 3, origin: 'src/routes/orders.js:16' })
  }
  return { type: 'transaction', name: 'GET /orders', start, durationMs: 5 + n * 1.4, queries }
}

function loopedWrites(start) {
  const queries = []
  for (let i = 0; i < 25; i++) {
    queries.push({ at: i * 1.1, durationMs: 0.8, sql: EVENT, vh: `e${i}`, rows: 1, origin: 'src/routes/events.js:31' })
  }
  return { type: 'transaction', name: 'POST /events', start, durationMs: 32, queries }
}

function clean(start) {
  return { type: 'transaction', name: 'GET /health', start, durationMs: 1.2, queries: [{ at: 0, durationMs: 0.3, sql: HEALTH, vh: 'h', rows: 1, origin: 'src/routes/health.js:4' }] }
}

for (let r = 0; r < rounds; r++) {
  const now = Date.now()
  const lines = [
    { type: 'header', sdk: 'querylens-sample/1', environment: 'production', release: 'sample-1' },
    nPlusOne(now - 900),
    loopedWrites(now - 500),
    clean(now - 100),
    {
      type: 'stats',
      start: now - 60_000,
      queries: [
        { sql: ITEMS, calls: 480, totalMs: 610, maxMs: 7.5, errors: 0, rows: 1440 },
        { sql: ORDERS, calls: 40, totalMs: 96, maxMs: 4.1, errors: 0, rows: 480 },
        { sql: EVENT, calls: 250, totalMs: 220, maxMs: 2.2, errors: 1, rows: 250 },
        { sql: HEALTH, calls: 60, totalMs: 18, maxMs: 0.6, errors: 0, rows: 60 },
      ],
    },
  ]
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson', 'x-querylens-key': key },
    body: lines.map((l) => JSON.stringify(l)).join('\n'),
  })
  console.log(`round ${r + 1}: ${res.status} ${await res.text()}`)
  if (r + 1 < rounds) await new Promise((ok) => setTimeout(ok, 1500))
}
