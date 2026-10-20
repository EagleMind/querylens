# QueryLens monitoring on Cloudflare

The backend and dashboard for always-on query monitoring (PostgreSQL and MySQL apps). Your app runs the
[`querylens-node`](../integrations/node) SDK with a DSN. The SDK sends requests that look
problematic, a sample of the others, and per-minute totals for every statement. This Worker
evaluates them with QueryLens's Rust analysis and shows the results in a web dashboard:

- **Live**: every statement of the requests the SDKs send, as they arrive, across projects.
  Built-in views (all, slow, failed, with issues), project and environment filters, search,
  and custom filters saved in the browser.
- **Query report**: one statement's SQL and parameters, the line of code that ran it, the
  issue it belongs to (N+1 queries, duplicate queries, writes in a loop, slow, failing and
  large statements, chatty requests) with the fix for your ORM (full code for Sequelize), the
  rest of its request, and its totals over the last 24 hours.

Projects, thresholds and sampling are managed through the API (`/api/0/projects`).

Everything runs on Cloudflare's Workers Free plan.

## How it works

```
app + querylens-node ──POST /api/<project>/envelope──▶ Worker ──RPC──▶ Project Durable Object
   (gzipped NDJSON, values removed)                     │                 ├─ querylens-core (WebAssembly): evaluate
                                                        │                 ├─ SQLite: issues, events, requests, hourly stats
dashboard (static assets) ──/api/0/*──────────────────▶ │                 └─ WebSockets: live feed (hibernating)
                         ──/api/0/live (WebSocket)────▶ ┘
                                                        Registry Durable Object: the project list
```

- **The Worker** (`worker/index.ts`) only routes requests. A Worker on the free plan gets 10 ms of CPU per request.
- **One `Project` Durable Object per app** (`worker/project.ts`) does the work. It checks the
  DSN key, runs `querylens-core` compiled to WebAssembly on each envelope, folds findings into
  issues (keyed by the finding's stable id per environment), keeps the latest 10 requests per
  issue, the query history (every request the SDKs send, 7 days, the latest 20,000) and
  hourly per-shape statistics (30 days), and pushes everything to open dashboards
  over hibernating WebSockets. A resolved issue that shows up again comes back as *regressed*.
- **`querylens-core`** (`../crates/core`) is the Rust analysis: SQL fingerprints, pattern
  detection, ORM advice. It's built as `core/querylens_core.wasm` by `../crates/wasm`, a small
  C ABI with no generated glue.
- **The dashboard** (`web/`) is a React app served as static assets from the same Worker.

## Run it locally

```bash
pnpm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
pnpm dev
```

Open http://localhost:5173 and sign in with the token from `.dev.vars`. Create a project, copy
its DSN from Settings, then either run an app with it or send sample traffic:

```bash
node scripts/send-sample.mjs "<DSN>" 5
```

## Deploy

```bash
pnpm exec cf auth login
```

```bash
pnpm run deploy
```

Then set the dashboard's sign-in token (a long random string) as a secret:

```bash
npx wrangler secret put ADMIN_TOKEN --name querylens
```

`cf deploy --secrets-file <file>` works too, with an `.env`-style file you keep out of git.
The Worker is served at `https://querylens.<your-subdomain>.workers.dev`, and DSNs use that host.

## In your app

```bash
npm install querylens-node
```

```bash
QUERYLENS_DSN=https://<key>@querylens.<your-subdomain>.workers.dev/<project>
```

```js
require('querylens-node/register') // first line of your entry file (or: import 'querylens-node/register')
```

See the [SDK's README](../integrations/node#monitoring) for environments, releases, jobs and
what is sent.

## Free plan budget

Free-plan limits as of October 2026: 100,000 Worker requests a day, plus 100,000 Durable
Object requests and 100,000 SQLite rows written a day.

- **Requests.** Each SDK process sends at most one envelope every 5 seconds, and only when it
  has something to send. That's up to about 17,000 requests a day for a process that's busy
  all day; idle processes send nothing.
- **Writes.** Every request sent writes 1 row to the query history. A request with findings
  also writes 3 rows per finding: the issue, the event, and pruning old events. The SDK sends the same problem on the same route at most once every
  30 seconds. Statistics add one row per statement shape per minute (an upsert into the hour).
- **Live sampling** (`liveSampleRate` in the project settings) sends that share of
  problem-free production requests. They're stored in the query history like flagged ones.
  Development and other environments send them all.

## Rebuild the core

After changing the Rust analysis:

```bash
pnpm build:core
```

This needs Rust with the `wasm32-unknown-unknown` target. The built module is committed, so
deploying doesn't need Rust.

## Layout

```
worker/index.ts      routing, auth, body limits (gzip)
worker/project.ts    the Project Durable Object: ingest, issues, stats, live feed
worker/registry.ts   the project list
worker/core.ts       loads querylens_core.wasm and calls it
web/                 the dashboard (React, Tailwind, shadcn/ui)
scripts/             build-core.mjs, send-sample.mjs
```

API types come from `bindings/` (generated from the Rust core with ts-rs:
`cargo test -p querylens-core export_bindings` at the repo root, into `bindings/`).
