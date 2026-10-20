# QueryLens — MVP Scope

The MVP answers one question well: **"Why is my query slow, and what should I do about
it?"** It covers PostgreSQL and DuckDB (MySQL and MongoDB arrived in v1.2), with AI suggestions, in a native desktop app.

Technical design: [architecture.md](architecture.md). Product context: [vision.md](vision.md).

---

## In scope

### 1. Connections
- Add / edit / delete **PostgreSQL** (host, port, database, user, password, SSL mode)
  and **DuckDB** (file path via native picker, or `:memory:`) connections.
- **Test connection** reports latency and server version.
- Passwords are stored in the OS keychain only. The UI only knows `hasPassword`.
- The sidebar list has a color dot and engine badge. Selecting a connection makes it
  active in the editor.

### 2. Editor + Analyze
- CodeMirror 6 with SQL highlighting (Postgres dialect), a dark theme that matches
  shadcn, and a resizable height.
- Toolbar: connection select and two actions, **Profile** and **Explain**. The primary
  one (chosen in Settings) is on <kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd>, the other on
  <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd>.
- **Profile** runs `EXPLAIN ANALYZE` inside a rolled-back transaction with a statement
  timeout. **Explain** runs plain `EXPLAIN` and never executes the query. A hint
  appears when the SQL writes data.
- Loading, error and empty states.

### 3. Plan tree
- Indented tree with guide lines, colored by **self-time share** (high / medium / low).
- Each row shows operator, relation / index, detail (filter, join condition), self
  time, share bar, and rows actual vs. estimated with a misestimate marker.
- Warning badges: `missing_index`, `seq_scan_large`, `row_estimate_error`, `sort_spill`,
  `hash_spill`, `nested_loop_blowup`, `heap_fetches`.
- Click a row for details: all properties, buffers, raw node JSON.
- Summary strip: execution time, planning time, total cost, node count, warning count.
- Collapse/expand subtrees.

### 4. AI suggestions
- Providers: **Claude Code CLI** (with QueryLens MCP tools for verified rewrites),
  **LM Studio**, **Ollama**, **OpenRouter**, **OpenAI-compatible custom**.
- A "Get suggestions" button. The response streams in, with cards rendered
  progressively and a live activity log (for Claude: "Running EXPLAIN on rewrite…").
- 3–5 cards: severity, title, explanation, target node (click to highlight), and
  **Copy fix**. Verified fixes get a badge.
- Stop and Regenerate. Results are saved with the analysis in history.
- When no provider is configured, a clear CTA links to Settings.

### 5. History
- Every analysis is saved automatically (newest 200 kept).
- List shows connection, engine, mode, SQL preview, execution time, warnings, a
  suggestions marker and a relative timestamp.
- Text search over SQL. Open an entry to replay it read-only (plan + saved
  suggestions), or load its SQL back into the editor. Delete entries or clear all.

### 6. Settings
- LLM provider select with per-provider defaults: base URL, API key (keychain), model,
  temperature, and the `claude` binary path for Claude Code.
- **Test LLM** shows round-trip latency and the reply.
- Analysis: default mode, statement timeout.

### Quality bar
- Unit tests for the Postgres/DuckDB parsers, self-time math and every warning rule.
- Rust is the single source of truth for types (ts-rs), and the TS build is strict.
- Dev UI runs in a plain browser against a mock backend, for fast UI iteration.

---

## Deferred

| Feature | Why deferred | Target |
|---|---|---|
| Light mode | Cosmetic. The tokens are already themeable. | v1.1 |
| Export (Markdown/JSON report) | Nice to have | v1.1 |
| Command palette | Nice to have | v1.1 |
| ClickHouse, MariaDB, SQLite, SQL Server | More parsers. ClickHouse needs `query_log` profiling, not EXPLAIN; MariaDB's `ANALYZE FORMAT=JSON` differs from MySQL's tree. | v1.2 |
| Cross-engine comparison | Needs operator-class bucketing across engines | v1.2 |
| SSH tunnels | Significant complexity. Most dev DBs are local or on a VPN. | v1.2 |
| Auto-updater, code signing | Manual GitHub releases are fine for early users | v1.1 |
| TLS between the app and the capture proxy | The proxy listens on localhost; apps that force TLS must disable it for the proxy URL | later |

---

## Build checklist

### Foundation
- [x] Tauri 2 + React 19 + Vite + Tailwind v4 + shadcn/ui scaffold (dark)
- [x] App shell: sidebar, routes (Analyze / History / Settings)
- [x] SQLite store with migrations; keychain secrets
- [x] Connection CRUD + test connection
- [x] ts-rs generated bindings

### Core analysis
- [x] Postgres engine: safety envelope, EXPLAIN JSON, schema context
- [x] DuckDB engine: read-only open, EXPLAIN (ANALYZE, FORMAT JSON), schema context
- [x] Parsers → PlanNode, self-time scoring, warnings (+ unit tests)
- [x] Plan tree UI, summary strip, node details
- [x] History persistence, list, search, replay

### LLM
- [x] OpenAI-compatible streaming provider (LM Studio / Ollama / OpenRouter / OpenAI)
- [x] Claude Code CLI provider + QueryLens MCP server (`--mcp`)
- [x] Channel streaming, progressive cards, cancel
- [x] Settings screen + Test LLM

### v1.1 profiling (done)
- [x] Server capabilities, version-aware EXPLAIN (SETTINGS/WAL/SERIALIZE/MEMORY), I/O time, JIT/serialization
- [x] Repeat runs (median + first run), lock timeout
- [x] Fingerprints, run-over-run baselines, plan diff + Compare dialog, icicle view
- [x] HypoPG hypothetical indexes, MCP `test_index`, measured/estimated evidence, Preview fix
- [x] `$n` parameters (custom/generic plans), parameter sensitivity, Top queries (pg_stat_statements)
- [x] Dev image with hypopg + pg_stat_statements, `dev/load-job.sh`, JOB / workload live tests

### v1.2 engines (done)
- [x] MySQL 8.0.18+: `EXPLAIN ANALYZE` / `FORMAT=TREE` parser, alias resolution, read-only Profile, `max_execution_time` + `KILL QUERY` backstop, truncated-plan detection, schema context, Top queries from `performance_schema`
- [x] MongoDB: mongosh-syntax parser (find/aggregate/count/distinct/update/delete, shell helpers, regex literals), `explain` with classic and SBE plans and pipelines, `maxTimeMS`, sampled schema + indexes
- [x] New warnings `blocking_sort`, `unselective_index`; engine-specific advisor prompt and MCP tools; engine-aware Preview fix
- [x] Editor: MySQL dialect / JavaScript highlighting, per-language drafts; connection form for both
- [x] Dev containers (MySQL 8.4, MongoDB 8.0) and live tests

### v1.3 capture (done)
- [x] PostgreSQL wire proxy: startup/SSL negotiation, upstream TLS, cancel forwarding, byte-exact relay
- [x] Protocol tracker: simple and extended protocol, pipelining, error batches, binary parameters
- [x] Comment tags (sqlcommenter, Rails/Marginalia), Node.js `pg` hook (file:line, per-request id)
- [x] Fingerprints ignore comments, list lengths and inlined booleans
- [x] Detection: N+1 (with parent), duplicate queries, looped writes, slow, large results, errors, chatty requests
- [x] Plan checks with captured values; missing-index heuristic (incl. never-analyzed tables); HypoPG / rolled-back index test
- [x] ORM recognition (7 ORMs); Sequelize advisor with code; generic advisor for the rest
- [x] CLI: `capture`, `check` (baseline gate, GitHub job summary), `report`, `captures`, `mcp`; headless build without the GUI
- [x] MCP: `capture_start/stop/report/statement`, `compare_captures`, `list_captures`; advisor mode unchanged
- [x] App: Capture page (live view, report, Open in Workbench, Measure plans)
- [x] `dev/sequelize-demo`, `live_capture` test, CI jobs (headless CLI, live capture)

### v1.4 SDK-first setup (done)
- [x] `querylens-node` SDK: records `pg` queries in-process (timing, values, rows, errors, call site, request), local only, idle unless capturing, off in production
- [x] Ingest layer: one `Observed` type; SDK via HTTP collector (127.0.0.1:7343) or spool files; proxy as fallback; proxy copies of SDK statements dropped
- [x] `querylens init`: installs the SDK, adds one line (Express, Nest, plain Node, Next.js instrumentation)
- [x] Database discovery (env, `.env*`, sequelize-cli config), free-port fallback, `.querylens/report.md`
- [x] Distribution: release builds for 5 platforms, npm (`querylens-cli` + platform packages, `querylens-node`), install scripts, GitHub Action

### v1.5 monitoring on Cloudflare (done)
- [x] `querylens-core` crate (pure analysis) + `querylens-wasm`; the app re-exports it
- [x] SDK monitoring mode: DSN, per-request buffering, local pre-filter, rate limits, sampling, per-shape stats, scrubbed values with value hashes, gzip batches with backoff, `withTransaction`, `flush`
- [x] Worker + `Project` / `Registry` Durable Objects (SQLite): ingest, issues with regression, events, hourly stats, live WebSocket feed
- [x] Dashboard: Live (requests, statements per minute), Evaluation (issues with fixes, top statements), Settings (DSN, thresholds, sampling, projects)
- [ ] Alerts (email via Cloudflare Email Service, webhooks)
- [ ] Plan checks for monitored statements (needs a database the backend can reach, e.g. Hyperdrive)
- [ ] Sign-in with Cloudflare Access instead of a shared token

### Next for capture
- [ ] Dedicated advisors for Prisma, TypeORM, Django, Active Record (code templates like Sequelize)
- [ ] MySQL proxy (handshake without TLS termination needs `caching_sha2_password` RSA exchange)
- [ ] Python/Ruby call-site hooks (sqlcommenter covers Django/Rails today)
- [ ] Capture comparison in the app (before/after view; MCP and the library have it)
- [ ] CLI release binaries per platform

### Ship
- [x] Windows release build (`.msi` + NSIS `.exe`)
- [ ] GitHub Actions matrix + release artifacts
- [ ] Manual QA on macOS + Linux (Windows verified during development)

### Verified so far
- 44 unit tests: parsers, self-time math, every warning rule, SQL sanitizing, storage.
- Live Postgres: DML really is rolled back, multi-statement input is rejected,
  model-issued writes fail read-only, and a `setup_sql` index is measured and leaves
  no trace.
- Live Claude Code + MCP: Claude test-built `(user_id, created_at DESC)` inside a
  rolled-back transaction, measured 47 ms → 0.17 ms, and returned it as a *verified*
  suggestion.
