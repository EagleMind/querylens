# QueryLens monitoring on Cloudflare

The backend and dashboard for always-on query monitoring (PostgreSQL and MySQL apps). Your app runs the
[`querylens-node`](../integrations/node) SDK with a DSN. The SDK sends requests that look
problematic, a sample of the others, and per-minute totals for every statement. This Worker
evaluates them with QueryLens's Rust analysis and shows the results in a web dashboard:

- **Live**: every statement of the requests the SDKs send, as they arrive, across projects.
  Built-in views (all, slow, failed, with issues), project and environment filters, search,
  and custom filters saved in the browser (written by hand, or drafted by Workers AI from a
  description). Above them, regressions: statements that got slower or started failing since
  the latest release.
- **Query report**: one statement's SQL and parameters, the line of code that ran it, the
  issue it belongs to (N+1 queries, duplicate queries, writes in a loop, slow, failing and
  large statements, chatty requests) with the fix written in your ORM's API, the
  rest of its request, and its totals over the last 24 hours. Each issue copies as a prompt
  for a coding agent and, when the SDK sends source context, Workers AI writes the change for
  the app's code.

- **Settings**: the connected host (the public address that goes into every DSN, editable
  for a custom domain or proxy), each project's DSN (its key can be changed or regenerated),
  and sign-out.

Muting an issue (from its query report) keeps it counted but out of the Live views; a filter
on Live shows muted issues again. Creating more projects, thresholds and sampling are managed
through the API (`/api/0/projects`) for now.

Coding agents reach the same issues through the MCP server at `/mcp` (see below).

Everything runs on Cloudflare's Workers Free plan.

## How it works

```
app + querylens-node ──POST /api/<project>/envelope──▶ Worker ──RPC──▶ Project Durable Object
   (gzipped NDJSON, values removed)                     │                 ├─ querylens-core (WebAssembly): evaluate
                                                        │                 ├─ SQLite: issues, events, requests, hourly stats
dashboard (static assets) ──/api/0/*──────────────────▶ │                 └─ WebSockets: live feed (hibernating)
                         ──/api/0/live (WebSocket)────▶ │
coding agents ──POST /mcp (JSON-RPC)──────────────────▶ ┘  Registry Durable Object: the project list, AI allowance
                                                           Workers AI: rewrites and filters, on demand
```

- **The Worker** (`worker/index.ts`) only routes requests. A Worker on the free plan gets 10 ms
  of CPU per request; waiting on Workers AI doesn't count.
- **One `Project` Durable Object per app** (`worker/project.ts`) does the work. It checks the
  DSN key, runs `querylens-core` compiled to WebAssembly on each envelope, folds findings into
  issues (keyed by the finding's stable id per environment), keeps the latest 10 requests per
  issue, the query history (every request the SDKs send, 7 days, the latest 20,000) and
  hourly per-shape statistics (30 days), and pushes everything to open dashboards
  over hibernating WebSockets. A resolved issue that shows up again comes back as *regressed*.
  It also records when each environment first reported each release (the baseline for
  regressions), the code around origins when the SDK sends source context, and the latest AI
  change per issue.
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

Open http://localhost:5173 and sign in with the token from `.dev.vars`. Workers AI has no
local simulation: the AI features call your account even in development (`cf auth login`). Create a project, copy
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

## Coding agents (MCP)

The Worker is a stateless MCP server (Streamable HTTP, JSON replies) at `/mcp`, authenticated
with the admin token:

```bash
claude mcp add --transport http querylens https://querylens.<your-subdomain>.workers.dev/mcp --header "Authorization: Bearer <ADMIN_TOKEN>"
```

| Tool | What it does |
|---|---|
| `list_projects` | The monitored apps and their ORM |
| `list_issues` | Issues by time lost (or recency), filtered by status and environment |
| `get_issue` | One issue as a fix brief: the code, the SQL, its request, the fix for the ORM |
| `list_regressions` | Statements slower or failing since the latest release |
| `set_issue_status` | Resolve, ignore or reopen an issue |

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
- **Source context** writes a row only when a line's code is new or changed; the SDK sends
  each line once per process. Releases cost one row each, the first time they're seen.
- **Workers AI** gives 10,000 neurons a day for free. A change written for an issue costs
  about 100 (`gpt-oss-120b`), a drafted filter less. The backend allows 80 AI calls a day
  (`DAILY_AI_CALLS` in `worker/fixing.ts`) and reuses a written change until the issue or
  its code changes.

## Rebuild the core

After changing the Rust analysis:

```bash
pnpm build:core
```

This needs Rust with the `wasm32-unknown-unknown` target. The built module is committed, so
deploying doesn't need Rust.

## Layout

```
worker/index.ts      routing: ingest, the dashboard API, MCP
worker/api.ts        the dashboard API (/api/0)
worker/http.ts       errors, JSON, body limits (gzip), auth
worker/backend.ts    reaching the Durable Objects (shared by the API and MCP)
worker/project.ts    the Project Durable Object: ingest, issues, stats, sources, releases, live feed
worker/registry.ts   the project list, backend settings, the daily AI allowance
worker/core.ts       loads querylens_core.wasm and calls it
worker/fixing.ts     fix prompts, AI changes and filter drafts, as the API and MCP offer them
worker/issues/       an issue as a fix brief for a coding agent (pure)
worker/analysis/     regressions across releases (pure)
worker/ai/           the model interface on Workers AI, rewrites and filters (pure, checked output)
worker/mcp/          the MCP protocol (pure), its tools, and the /mcp endpoint
shared/              API types, labels and the filter schema, shared with the dashboard
web/                 the dashboard (React, Tailwind, shadcn/ui)
test/                tests of the pure modules (pnpm test)
scripts/             build-core.mjs, send-sample.mjs
```

Analysis types come from `bindings/` (generated from the Rust core with ts-rs:
`cargo test -p querylens-core export_bindings` at the repo root, into `bindings/`); the
backend's own API types are in `shared/api.ts`.
