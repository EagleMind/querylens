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

Each driver has its own module in `drivers/`, sharing `context.cjs` (the request, the ORM
operation, the line of code) and `record.cjs` (timing a statement or a batch). `index.cjs`
sets them up through a `Module._load` hook and the app's already-loaded copies, from two
tables: drivers with one build, and drivers whose CommonJS and ES module builds load
separate classes (Neon, PlanetScale, libSQL), patched file by file (`drivers/builds.cjs`).

- `pg.Client.prototype.query`, and mysql2's base connection `query` / `execute` (shared by
  connections, pools and the promise API; pools hand over ready `Query` commands, whose
  `onResult` is wrapped). Neon's WebSocket `Pool` and `Client` are a bundled `pg`.
- Neon's HTTP queries are lazy thenables (`NeonQueryPromise`): timed around `execute`, the
  line taken when `await` reads `then`. PlanetScale: `Connection.execute`. libSQL: each
  client's and transaction's `execute` and `batch` (a batch's time shared by its statements).
- SQLite: better-sqlite3's and node:sqlite's statement methods (synchronous; failed
  `prepare`s recorded), sqlite3's Statement and Database methods (callbacks). node:sqlite is
  patched only once the app has loaded it, since loading it prints a warning.
- MongoDB: `connect()` turns the driver's command monitoring on, and each data command
  becomes a statement shaped by `drivers/mongo-shape.cjs` (`db.orders.find({"userId": ?})`,
  or `Order.find(…)` through Mongoose, whose operations carry the model and the line).
  `getMore` batches are folded into the query that opened the cursor. It times every query (promise and callback forms) and records
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

`source.cjs` (opt-in, `sourceContext`) reads the 10 lines around each origin of a sent
request, once per origin per process, during the background flush. Only relative paths
inside the project are read, files over 1 MB are skipped, and secret-looking assignments,
URL credentials and long key-like literals are masked. Each becomes a `source` envelope item;
the core checks that its origin's line is among the lines and keeps at most 41.

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
It needs no imports and is about 450 KB.

MongoDB operations reach the core as the SDK's canonical text. `capture/mongo.rs` parses it,
and `capture/sql/shape` answers for it (kind, collection, filter fields, limit), so detection
runs unchanged. `Orm::Mongoose` and `Orm::MongoDb` (the driver) have their own advisors; SQL
and MongoDB are recognised apart, and each finding gets the advisor of the API its statement
went through.

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
  - Records when each environment first reports each release, the code around origins the
    SDK sends (source context, one row per line of code, rewritten only when it changes), and
    the latest AI change per issue with a hash of what it was written from.
  - `issueContext(n)`: the issue, its latest event and the code around its top origins. It
    feeds the fix prompt (`issues/prompt.ts`), the MCP `get_issue` tool and AI rewrites.
  - `regressions(env)`: hourly statistics summed before and after the latest release's deploy
    hour (or the last day against the week before, without releases), judged by the pure
    `analysis/regressions.ts`: enough calls on both sides, 1.5× slower and 2 ms more per call,
    or failing at least twice as often.
- **`Registry` Durable Object**: the project list, the public URL and the daily AI allowance.
- **AI** (`ai/`): one `JsonModel` interface, implemented on the Workers AI binding
  (`gpt-oss-120b` by default) and faked in tests. Features ask for JSON that follows a schema,
  then check it: a rewrite must replace lines that are really in the code the SDK sent (which
  is also how its file and line are found, and how it's re-indented), and a drafted filter
  must use the dashboard's fields, operators and values (`shared/filters.ts`).
- **MCP** (`mcp/`): a stateless Streamable HTTP server with JSON replies. `protocol.ts` is
  pure JSON-RPC (`initialize`, `ping`, `tools/list`, `tools/call`), `tools.ts` defines the tools
  over an `McpBackend` interface, `server.ts` adds auth and the Durable Objects.
- **Auth**: SDKs use the DSN key; the dashboard and MCP clients use the `ADMIN_TOKEN` secret
  as a Bearer token (the live WebSocket takes it in the URL, which browsers require).

Rows written are the free plan's scarcest resource (100,000 a day):
- A finding costs 3 rows: the issue, the event, and pruning old events.
- Statistics cost one upsert per shape per report.
- A known shape's `last_seen` is refreshed at most hourly.
- Every request sent costs 1 row in the query history (plus its share of the trims).
- Source context costs a row only for new or changed code; releases one row each.

## 4. The dashboard (`cloud/web`)

React, Tailwind and shadcn/ui (`web/components/ui`), served as static assets by the same
Worker with a single-page-app fallback. Its own small router, with types from `cloud/bindings`.

- **Live** (`/`): for each project, the latest page of the query history
  (`GET …/requests`), then its WebSocket for new requests (the page is reloaded on every
  reconnect, so gaps fill), and older pages on demand (`?before=`). Every statement, newest
  first. Built-in views, project / environment / search filters, and custom filters
  (`web/lib/filters.ts`: one small strategy per field) saved in `localStorage`.
- **Query report** (`/queries/<project>/<request>/<seq>`): one column of cards in diagnosis
  order, each a summary with its evidence folded under "Details": the verdict (with what the
  page can't show and why), what's wrong (most serious first, one plain sentence each), how
  to fix it (the one fix that covers the most, with the AI change and fix prompt), where in
  the code, the query, the request as an event log (time in the app's code between queries
  as lines, runs of one statement folded), and the last 24 hours. `web/lib/report.ts` works
  out what each card says (pure, tested in `test/report.test.ts`); `components/report` lays
  it out. Data: the stored request (`GET …/requests/<n>`, or the loaded copy), its issues
  (`GET …/issues/<n>`), the code (`GET …/source`), the shape's 24 hours and regressions.
- **Docs** (`/docs`): what each "not shown" note links to (line of code, source context,
  values, releases, AI, MCP) and the project's thresholds.
- **Settings** (`/settings`): the connected host (the public URL stored in the `Registry`,
  `GET/PUT /api/0/settings`, used in every DSN; defaults to the address the dashboard was
  reached at), each project's DSN with an editable key (`PUT …/key`), sign-out.
- **Muted issues**: an issue set to `ignored` (Mute on the report). Live drops muted findings
  from its views and filters unless the "Show muted issues" filter is on.
- **Fixing**: each issue card copies its fix prompt (`GET …/issues/<n>/prompt`, loaded with
  the card so the copy happens within the click) and shows the AI change
  (`GET/POST …/issues/<n>/suggestion`) as a diff numbered like the file. The report shows the
  code around the statement's origin when the SDK sent it (`GET …/source?origin=`).
- **Regressions**: a panel above the Live list (`GET …/regressions`), refreshed every 5
  minutes, shown only when there are some; the report notes it on the statement's last 24 hours.
- **Described filters**: the filter dialog sends a description (`POST /api/0/filters/draft`)
  and fills in the conditions, to check and save like any other.

## 5. Next

- Alerts: Cloudflare Email Service or webhooks on new and regressed issues.
- Sign-in through Cloudflare Access instead of a shared token.
- More ORMs with code-level fixes (`OrmAdvisor`), and SDKs beyond Node.js.
