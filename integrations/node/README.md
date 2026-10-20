# querylens-node

The QueryLens SDK for Node.js. It monitors the queries your app sends to PostgreSQL (through
[`pg`](https://node-postgres.com/)) and MySQL (through [`mysql2`](https://sidorares.github.io/node-mysql2/)),
whether via Sequelize, Knex, TypeORM, MikroORM, Drizzle or the drivers directly, in production too, and reports them to your
[QueryLens backend](../../cloud). The backend finds N+1 queries, writes in a loop, slow,
failing and large statements and chatty requests, and shows how to fix them in your ORM,
down to the line.

## Setup

```bash
npm install querylens-node
```

Give the app your project's DSN (from the dashboard's Settings):

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

## Guarantees

- **No values leave the process.** Literals in the SQL become `?`, bound parameters are
  dropped, and quoted values are removed from error messages. Each statement carries only a
  hash of its values, which is how the backend tells an N+1 (different values) from a
  repeated query. `sendValues: true` sends them anyway, for example in development.
- **Your queries are never changed**, and nothing waits on QueryLens. Sending happens in the
  background, batched every few seconds and gzipped. If anything goes wrong inside the SDK,
  the query runs as if it weren't there.
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
require('querylens-node').init({ dsn, environment, release, sampleRate, sendValues })
```

(as the first line, instead of `register`)

| Variable | Effect |
|---|---|
| `QUERYLENS_DSN` | Where to report. Without it the SDK does nothing. |
| `QUERYLENS_ENVIRONMENT` | Environment name (default: `NODE_ENV`, else `production`) |
| `QUERYLENS_RELEASE` | Release (default: the commit from Vercel, Render, Railway, Heroku, Cloudflare Pages, GitHub Actions…) |
| `QUERYLENS_SAMPLE_RATE` | Share of problem-free requests sent to the live feed |
| `QUERYLENS_SEND_VALUES=1` | Send SQL literals and parameters too |
| `QUERYLENS_DISABLED=1` | Turn it off |
