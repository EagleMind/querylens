# querylens-node

The QueryLens SDK for Node.js. It records the queries your app sends to PostgreSQL through
[`pg`](https://node-postgres.com/) (Sequelize, Knex, TypeORM, MikroORM, Drizzle on node-postgres,
or plain `pg`), so [QueryLens](https://github.com/EagleMind/querylens) can find N+1 queries,
missing indexes and the like, and tell you how to fix them in your ORM, down to the line.

## Setup

```bash
npx querylens-cli init
```

That installs this package and adds one line at the top of your app. To do it by hand:

```bash
npm install querylens-node
```

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

Then run your app as usual, and record with the QueryLens desktop app (Capture → Start capture)
or from a terminal (`npx querylens-cli capture`). Queries show up as the app runs them.

## Monitoring

Set a DSN and the SDK monitors all the time, production included, reporting to your
[QueryLens backend on Cloudflare](../../cloud) (live feed, issues with fixes, top statements):

```bash
QUERYLENS_DSN=https://<key>@querylens.<you>.workers.dev/<project>
```

The setup line is the same (`require('querylens-node/register')`). What it does:

- **Per request**, it buffers the queries in memory. When the request ends, it sends the
  request with all its statements if it shows a problem: a statement repeated (N+1, loops),
  a slow, failing or large one, or too many statements. The same problem on the same route
  is sent at most once every 30 seconds. A sample of the other requests is sent for the
  live feed: the project's setting in production, and all of them elsewhere.
- **Every statement** is counted into per-shape totals, sent every 5 minutes in production
  and every minute elsewhere.
- **No values leave the process.** Literals in the SQL become `?`, bound parameters are
  dropped, and quoted values are removed from error messages. Each statement carries only a
  hash of its values, which is how the backend tells an N+1 (different values) from a
  repeated query. Set `sendValues: true` (or `QUERYLENS_SEND_VALUES=1`) to send them anyway,
  for example in development.
- **Your queries are never changed** in this mode, and nothing blocks them: sending happens in
  the background, gzipped, every few seconds. When the backend is unreachable, the SDK backs
  off and drops the oldest data rather than holding more than about 4 MB.

Work outside HTTP requests (queue jobs, cron tasks, scripts) can be grouped the same way:

```js
const { withTransaction, flush } = require('querylens-node')

await withTransaction('job:send-invoices', () => sendInvoices())
await flush() // before a serverless handler returns, or on shutdown
```

| Variable | Effect |
|---|---|
| `QUERYLENS_DSN` | Turns monitoring on and says where to report |
| `QUERYLENS_ENVIRONMENT` | Environment name (default: `NODE_ENV`, else `production`) |
| `QUERYLENS_RELEASE` | Release (default: the commit from Vercel, Render, Railway, Heroku, Cloudflare Pages, GitHub Actions…) |
| `QUERYLENS_SAMPLE_RATE` | Share of problem-free requests sent to the live feed (default: the project's setting in production, 1 elsewhere) |
| `QUERYLENS_SEND_VALUES=1` | Send SQL literals and parameters too |

Or in code: `require('querylens-node').init({ dsn, environment, release, sampleRate, sendValues })`
as the first line, instead of `register`.

## What it records

For each query: the SQL, its values, duration, rows, error, the first line of your code in the
call stack (outside `node_modules`), and the HTTP request being served (method and route, ids
replaced by `:id`), so QueryLens can group a request's queries even across a connection pool.

## Guarantees

These are for local capture (no DSN set). For monitoring, see above.

- **Local only.** Events go to QueryLens on `127.0.0.1` (default port 7343, or `QUERYLENS_URL`),
  never anywhere else.
- **Idle unless capturing.** It checks every few seconds whether QueryLens is recording, and
  sends nothing otherwise. With nothing listening, the per-query cost is a boolean check.
- **Off in production.** Disabled when `NODE_ENV=production` (override with
  `QUERYLENS_ENABLED=1`), or anywhere with `QUERYLENS_DISABLED=1`.
- **Your queries don't change.** While capturing, a trailing comment is added (call site, request,
  and a marker so the QueryLens proxy doesn't record the query twice). Named prepared statements
  are left untouched. If anything goes wrong in the SDK, the query runs as if it weren't there.
- **No dependencies.** Plain Node.js, a few small files.

## Options

```js
require('querylens-node').init({ url: 'http://127.0.0.1:7343', enabled: true })
```

| Variable | Effect |
|---|---|
| `QUERYLENS_URL` | Where to report (default `http://127.0.0.1:7343`) |
| `QUERYLENS_DISABLED=1` | Turn it off |
| `QUERYLENS_ENABLED=1` | Turn it on even with `NODE_ENV=production` |
| `QUERYLENS_SPOOL` | Write events to files in this directory instead (set by `querylens capture -- <command>`) |
