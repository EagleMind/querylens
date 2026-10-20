# QueryLens — Architecture

QueryLens monitors the database traffic of a running application, like an error tracker:
an SDK in the app, a backend that evaluates what it sends and keeps issues, and a web
dashboard. (Until October 2026 QueryLens was also a desktop app and a CLI for local capture,
query plans and a CI gate. Both were removed; they're in git history before `monitor`.)

```
app + querylens-node ──gzipped NDJSON──▶ Worker ──RPC──▶ Project Durable Object
                                           │               ├ querylens-core (WebAssembly): evaluate
dashboard ──/api/0, WebSocket────────────▶ ┘               ├ SQLite: issues, events, requests, hourly stats
                                                           └ live feed (hibernating WebSockets)
```

## 1. The SDK (`integrations/node`)

`index.cjs` patches `pg.Client.prototype.query` and mysql2's base connection `query` /
`execute` (shared by connections, pools and the promise API; pools hand over ready `Query`
commands, whose `onResult` is wrapped). It does this through a `Module._load` hook and the
app's already-loaded copies for ESM. It times every query (promise and callback forms) and records
its rows, error, and the first stack frame outside `node_modules`. Async stack traces reach
the user's `await`. Stacks are captured cheaply and only formatted if the request is sent. An
`AsyncLocalStorage` context per HTTP request holds its *transaction*;
`withTransaction(name, fn)` does the same for jobs, and anything else goes into 5-second
"background" batches. Nothing happens without `QUERYLENS_DSN`.

`monitor.cjs` decides what to send. When a transaction ends, a cheap local check runs: a
shape repeated at least `loopMin` times, slow, failing or large statements, or at least
`chatty` statements. It's a superset of what the backend flags, so nothing is missed. Flagged
transactions are rate-limited to one per route and problem every 30 seconds. Clean ones are
sampled: the project's `liveSampleRate` in production, all of them elsewhere. Every statement
also goes into per-shape totals, reported every 5 minutes in production and every minute
elsewhere. Batches go out every 5 seconds, gzipped, with exponential backoff (or
`Retry-After`) and bounded queues that drop the oldest data first. A 401 stops sending. Each
reply carries the project's settings, so thresholds changed in the dashboard apply on the
next report.

`scrub.cjs` removes values, per dialect: PostgreSQL quotes identifiers with `"…"`, MySQL with
backticks, and MySQL strings may use `"…"` and backslash escapes. Literals become `?` by the
same rules as the core's `normalize_sql`, which reads both quoting styles, so scrubbed and full statements share a fingerprint; the cases in
`test/scrub-cases.json` are run by both the JS and the Rust tests. The literals and bound
parameters are reduced to a 32-bit FNV hash (`vh`). Quoted values are removed from error
messages.

## 2. The analysis (`crates/core`, `crates/wasm`)

`querylens-core` is pure Rust (no I/O):

| Module | Does |
|---|---|
| `fingerprint` | Normalizes SQL (literals, `$n`, comments, `IN (…)` lists, booleans) → stable FNV fingerprints |
| `capture::sql` | Comment tags (sqlcommenter), statement shape: kind, tables, aliases, filters, LIMIT |
| `capture::detect` | Per-fingerprint stats; loops (runs of one fingerprint within 8 statements and 500 ms → N+1 with its parent, duplicate, looped writes); slow, large, failing, chatty |
| `capture::orm` | Recognizes the ORM from SQL style; `OrmAdvisor` per ORM writes the fix (Sequelize with code, the rest generic) |
| `monitor::envelope` | The SDK's wire format. A scrubbed statement's `vh` becomes one opaque parameter, so loop detection still tells N+1 (varying) from duplicate (same). |
| `monitor::evaluate` / `digest` | One transaction → findings with fixes; a whole envelope → everything the backend stores |
| `model`, `monitor::model` | Shared types, exported to TypeScript (`cloud/bindings`) by ts-rs |

`querylens-wasm` builds it for `wasm32-unknown-unknown` with a small C ABI (`ql_alloc`,
`ql_digest`, `ql_result_ptr` / `ql_result_len`). The host writes a JSON `DigestRequest`
(envelope body, the ORM known so far, project settings) and reads back a JSON `Digest` (each
transaction's fingerprinted statements with findings and fixes, plus per-shape statistics).
It needs no imports and is about 340 KB.

## 3. The backend (`cloud/worker`)

Everything fits the Workers Free plan, which sets the shape:

- **The Worker** (`index.ts`) only routes and checks limits (4 MB bodies, 16 MB decompressed).
  A free-plan Worker gets 10 ms of CPU per request, so the evaluation runs in the Durable
  Object, which gets 30 s.
- **`Project` Durable Object, one per app** (`project.ts`, SQLite storage):
  - Checks the DSN key (constant-time comparison) and runs the digest.
  - Upserts issues keyed by `(environment, finding id)`. Severity only rises and origins merge.
    A resolved issue seen again reopens as regressed; an ignored one keeps counting.
  - Keeps the latest 10 events per issue (their statements, values scrubbed), the query
    history (one row per request sent: its first 100 statements and its findings; 7 days and
    the latest 20,000, trimmed every 500 requests and by the daily alarm) and hourly per-shape
    statistics for 30 days, pruned by the same alarm.
  - Broadcasts `LiveEvent`s (`transaction`, `issue`, `throughput`) to dashboards on
    hibernating WebSockets (pings auto-answered).
- **`Registry` Durable Object**: the project list, touched only by the dashboard.
- **Auth**: SDKs use the DSN key; the dashboard uses the `ADMIN_TOKEN` secret, sent as a
  Bearer token, or in the URL for the WebSocket.

Rows written are the free plan's scarcest resource (100,000 a day):
- A finding costs 3 rows: the issue, the event, and pruning old events.
- Statistics cost one upsert per shape per report.
- A known shape's `last_seen` is refreshed at most hourly.
- Every request sent costs 1 row in the query history (plus its share of the trims).

## 4. The dashboard (`cloud/web`)

React, Tailwind and shadcn/ui (`web/components/ui`), served as static assets by the same
Worker with a single-page-app fallback. Its own small router, with types from `cloud/bindings`.

- **Live** (`/`): for each project, the latest page of the query history
  (`GET …/requests`), then its WebSocket for new requests (the page is reloaded on every
  reconnect, so gaps fill), and older pages on demand (`?before=`). Every statement, newest
  first. Built-in views, project / environment / search filters, and custom filters
  (`web/lib/filters.ts`: one small strategy per field) saved in `localStorage`.
- **Query report** (`/queries/<project>/<request>/<seq>`): the stored request
  (`GET …/requests/<n>`, or the loaded copy). Adds the issue detail and fix
  (`GET …/issues/<n>`, matched through `LiveFinding.fingerprint`) and the shape's last 24
  hours (`GET …/queries?fingerprint=`).

## 5. Next

- AI-suggested optimizations on issues. Workers AI or Claude, given the scrubbed statement,
  the finding and the ORM.
- Alerts: Cloudflare Email Service or webhooks on new and regressed issues.
- Sign-in through Cloudflare Access instead of a shared token.
- More ORMs with code-level fixes (`OrmAdvisor`), and SDKs beyond Node.js.
