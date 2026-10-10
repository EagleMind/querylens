# QueryLens

**Explain every query, on every engine, in plain English.**

QueryLens is a local-first desktop app. It runs `EXPLAIN` on your SQL, shows where the
time goes, and asks an LLM for specific fixes. With Claude Code, it measures those fixes
against your database before recommending them.

- **Readable plans.** Each operator is colored by its *self* time, and one stacked bar
  shows where every millisecond went.
- **Instant heuristics.** Missing-index scans, row misestimates, sort/hash spills, nested
  loop blowups and stale visibility maps are flagged locally, with no LLM involved.
- **AI suggestions.** These stream in as cards with copyable SQL. Providers: Claude Code
  CLI, LM Studio, Ollama, OpenRouter, or any OpenAI-compatible server.
- **Verified fixes.** Claude gets QueryLens's own MCP tool. It can build a candidate index
  inside a rolled-back transaction, re-run `EXPLAIN`, and report the measured speedup.
- **Safe by construction.** `EXPLAIN ANALYZE` always runs in a transaction that is rolled
  back, with a statement timeout and single-statement execution. Model-issued queries
  are read-only. DuckDB files open read-only.
- **Private.** No accounts and no telemetry. Credentials live in the OS keychain.

Engines: **PostgreSQL** and **DuckDB** (ClickHouse, MySQL and others are planned).

## Quick start

Prerequisites: Node 22+, pnpm, Rust stable, plus the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
```

```bash
pnpm tauri dev
```

Optional demo database (seeded with deliberately slow queries):

```bash
docker compose -f dev/docker-compose.yml up -d --build
```

Then add a connection: host `localhost`, port `54329`, database `shop`, user `querylens`.

For AI suggestions, the default provider is **Claude Code**. Install the `claude` CLI and
sign in, and QueryLens uses that login, so no API key is needed. Alternatively, start LM
Studio's server and pick *LM Studio* in Settings.

## Development

| Command | What it does |
|---|---|
| `pnpm dev` | UI only, in a browser, against a mock backend with a real captured plan |
| `pnpm tauri dev` | Full desktop app with hot reload |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | TypeScript, oxlint, Prettier |
| `pnpm bindings` | Regenerate `src/bindings/*.ts` from the Rust types (ts-rs) |
| `cd src-tauri && cargo test` | Unit tests (parsers, scoring, warnings, storage) |
| `pnpm tauri build` | Release installers (`.msi`/`.exe`, `.dmg`, `.AppImage`/`.deb`) |

Live integration tests against the demo database (and optionally Claude Code) are
described in [docs/architecture.md §10](docs/architecture.md#10-build-test-ship).

## Documentation

- [docs/vision.md](docs/vision.md): the product, positioning, and what it is not
- [docs/architecture.md](docs/architecture.md): stack, layers, data model, safety envelope, LLM/MCP design, and revision notes
- [docs/mvp.md](docs/mvp.md): scope, deferred features, and the build checklist

## Project layout

```
src/            React 19 + shadcn/ui (dark) frontend
src/bindings/   TypeScript types generated from Rust, do not edit
src-tauri/      Rust core: engines, plan parsing/scoring, LLM providers, MCP server, storage
dev/            docker-compose Postgres with seed data
docs/           specs
```
