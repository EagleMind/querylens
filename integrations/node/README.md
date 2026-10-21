# querylens-node

The QueryLens SDK for Node.js. It monitors the queries your app sends to PostgreSQL (through
[`pg`](https://node-postgres.com/), [`postgres`](https://github.com/porsager/postgres) or Neon's
serverless driver), MySQL (through [`mysql2`](https://sidorares.github.io/node-mysql2/) or
PlanetScale's serverless driver), SQLite (through `better-sqlite3`, `sqlite3`, `node:sqlite` or
libSQL / Turso) and MongoDB (through the `mongodb` driver or Mongoose), whether via Sequelize,
Knex, TypeORM, MikroORM, Drizzle, Mongoose or the drivers directly, in production too, and reports them to your
[QueryLens backend](../../cloud). The backend finds N+1 queries, writes in a loop, slow,
failing and large statements and chatty requests, and shows how to fix them in your ORM,
down to the line.

## Setup

```bash
npm install querylens-node
```

Give the app its backend's DSN. In the dashboard's Settings, connect each service of your app
to its project as a backend; each gets its own DSN:

```bash
QUERYLENS_DSN=https://<key>@querylens.<you>.workers.dev/<project>
```

Then load the SDK before anything else:

```js
require('querylens-node/register') // first line of your entry file
// or, in ESM / TypeScript:
import 'querylens-node/register'
```

For Next.js, in `instrumentation.ts`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('querylens-node/register')
}
```

## Drizzle

Nothing to add: with `register` loaded first, Drizzle's queries (on `pg`, postgres.js and
`mysql2`) carry the line of your code that awaited them. Drizzle starts a query only when
it's awaited, from a microtask where your code is no longer on the stack, so the SDK takes
the line where `await` (or `.then`, `.catch`, `Promise.all`) picks the query up. It does
that by turning `then` on Drizzle's `QueryPromise` into a getter that returns the same
function; queries run exactly as before. Recording a line costs a few microseconds per query.

In ESM apps on Node.js older than 20.19, `select` queries have no line: the SDK can patch
Drizzle's ESM build only after its select builders have copied `then`. Also without a
line: `db.$count()`.

## Prisma

Prisma 7 sends its SQL through a driver adapter, and so does Prisma 6 with an adapter and
`engineType = "client"` in its generator. With `@prisma/adapter-pg` that SQL goes through `pg`,
which the SDK records. Add the extension so each query carries the line of your Prisma
call (otherwise the driver sees only Prisma's internals):

```js
const { queryLens } = require('querylens-node/prisma')

const prisma = new PrismaClient({ adapter }).$extends(queryLens())
```

Prisma 6 on its default Rust engine runs SQL outside the drivers. Record it through Prisma's
tracing instead:

```js
const prisma = new PrismaClient().$extends(queryLens({ engine: true }))
```

This mode has a cost, which is why it's opt-in: Prisma's engine tracing adds about 0.3 ms per
query, and inside interactive transactions Prisma appends a `/* traceparent='…' */` comment to
the SQL it sends. It works alongside Sentry's or OpenTelemetry's Prisma instrumentation when
those are set up first. A statement's values are its Prisma operation's arguments, and rows
are known only for an operation's first statement. Clients with an adapter are left to the
driver hooks, so nothing is counted twice.

Not covered: Prisma 6 with an adapter but still on the Rust engine, which calls the driver
from native code, so its queries can't be tied to a request (add `engineType = "client"`).
The `BEGIN` and `COMMIT` of interactive transactions have no line of code.

## What it sends

- **Requests with problems.** Queries are buffered per HTTP request. When the request ends,
  it's sent with all its statements if it shows a problem: a statement repeated (N+1, loops),
  a slow, failing or large one, or too many statements. The same problem on the same route is
  sent at most once every 30 seconds.
- **A sample of the other requests**, for the live feed: the project's setting in production
  (5% by default), and all of them in other environments.
- **Totals for every statement**, per statement shape: every 5 minutes in production, every
  minute elsewhere.

Each statement carries its timing, rows, error, the first line of your code in the call stack
(outside `node_modules`), and the route (ids replaced by `:id`).

MongoDB commands are sent as value-free shapes: `db.orders.find({"userId": ?})`, or
`Order.find(…)` through a Mongoose model. A cursor read in batches counts as one query. The SDK
turns on the driver's command monitoring when a client connects; if your app listens to
`commandStarted` events itself, it receives them from then on too.

- **The code around those lines, if you turn it on** (`sourceContext: true` or
  `QUERYLENS_SOURCE_CONTEXT=1`): the 10 lines before and after each line of your code that ran
  a reported query, read in the background and sent once per line per process. The dashboard
  shows them, and the backend writes fixes against them. Only files inside the project
  directory are read. Assignments to keys, secrets, tokens and passwords, credentials in URLs
  and long key-like strings are masked before anything is sent. Off by default. With
  TypeScript, run Node with `--enable-source-maps` so lines point at your sources.

## Guarantees

- **No values leave the process.** Literals in the SQL become `?`, bound parameters are
  dropped, and quoted values are removed from error messages. Each statement carries only a
  hash of its values, which is how the backend tells an N+1 (different values) from a
  repeated query. `sendValues: true` sends them anyway, for example in development.
- **Your queries are never changed**, and nothing waits on QueryLens. Sending happens in the
  background, batched every few seconds and gzipped. If anything goes wrong inside the SDK,
  the query runs as if it weren't there. (The one exception is Prisma's opt-in
  [engine mode](#prisma).)
- **Bounded memory.** When the backend is unreachable, the SDK backs off and drops the oldest
  data rather than holding more than about 4 MB.
- **No dependencies.** Plain Node.js, a few small files.

## Jobs, scripts, serverless

Work outside HTTP requests is grouped into 5-second batches. Name it to evaluate it like a request:

```js
const { withTransaction, flush } = require('querylens-node')

await withTransaction('job:send-invoices', () => sendInvoices())
await flush() // before a serverless handler returns, or on shutdown
```

## Options

```js
require('querylens-node').init({ dsn, environment, release, sampleRate, sendValues, sourceContext })
```

(as the first line, instead of `register`)

| Variable | Effect |
|---|---|
| `QUERYLENS_DSN` | Where to report. Without it the SDK does nothing. |
| `QUERYLENS_ENVIRONMENT` | Environment name (default: `NODE_ENV`, else `production`) |
| `QUERYLENS_RELEASE` | Release (default: the commit from Vercel, Render, Railway, Heroku, Cloudflare Pages, GitHub Actions…) |
| `QUERYLENS_SAMPLE_RATE` | Share of problem-free requests sent to the live feed |
| `QUERYLENS_SEND_VALUES=1` | Send SQL literals and parameters too |
| `QUERYLENS_SOURCE_CONTEXT=1` | Send the code around the lines that ran reported queries, secrets masked |
| `QUERYLENS_DISABLED=1` | Turn it off |
