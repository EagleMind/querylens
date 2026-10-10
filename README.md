<div align="center">

<img src="src-tauri/icons/app-icon.svg" width="96" alt="QueryLens logo">

# QueryLens

**See where your query spends its time, and what would make it faster.**

A local-first desktop profiler for PostgreSQL, MySQL, MongoDB and DuckDB.
It runs the plan safely, shows the time per operator, flags known problems,
and asks an AI advisor for fixes it can measure before recommending them.

[![CI](https://github.com/EagleMind/querylens/actions/workflows/ci.yml/badge.svg)](https://github.com/EagleMind/querylens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-f2d84a.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-161f36.svg)
![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2024-000000?logo=rust&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)

![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8.0.18%2B-4479A1?logo=mysql&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?logo=mongodb&logoColor=white)
![DuckDB](https://img.shields.io/badge/DuckDB-FFF000?logo=duckdb&logoColor=black)

<img src="docs/assets/workbench.png" alt="The QueryLens workbench: a SQL query, its plan colored by time per operator, and the advisor's suggestions" width="100%">

<sub>The workbench on the demo database. The advisor panel shows sample output.</sub>

</div>

## Why QueryLens

`EXPLAIN ANALYZE` output is precise but hard to read, and every engine prints it
differently. QueryLens connects to your database, runs the plan for you inside a safety
envelope, and turns it into one readable model across engines.

- **Time per operator, not cumulative cost.** Each operator is colored by its own
  (exclusive) time, so the slow step is obvious. One bar shows where every millisecond went.
- **Trustworthy numbers.** Profile runs the query three times and shows the median, with
  the first run's disk reads reported separately.
- **Problems flagged instantly, without AI.** Missing indexes, row misestimates, sorts and
  hashes spilling to disk, repeated lookups, in-memory sorts an index could avoid.
- **An advisor that tests before it recommends.** With Claude Code, the advisor calls
  QueryLens's own MCP tools to try an index or a rewrite, then labels each suggestion
  **Measured** or **Estimated**.
- **Before and after.** Preview a fix, compare any two runs operator by operator, and see
  when a plan changed or got slower since the last run.
- **Workload view.** Top queries lists the statements costing the most time on the server
  (`pg_stat_statements`, MySQL `performance_schema`).

## Safe by construction

| Engine | What Profile does | Limits |
|---|---|---|
| PostgreSQL | `EXPLAIN ANALYZE` in a transaction that is always rolled back; one statement only | statement and lock timeouts |
| MySQL | `EXPLAIN ANALYZE` in a **read-only** transaction: the server refuses any write | `max_execution_time`, `KILL QUERY` backstop |
| MongoDB | `explain` with `executionStats`: writes are never applied, `$out`/`$merge` refused | `maxTimeMS` |
| DuckDB | `EXPLAIN ANALYZE` on a file opened **read-only** | interrupt watchdog |

Queries issued by the AI run read-only. Explain mode never executes the query.

## Engines

| Engine | Profile | Explain | Schema context | Top queries | Index testing |
|---|:-:|:-:|:-:|:-:|:-:|
| PostgreSQL | ✓ | ✓ | ✓ incl. `pg_stats` | ✓ | ✓ HypoPG or rolled-back build |
| MySQL 8.0.18+ | ✓ reads | ✓ | ✓ | ✓ | – (DDL commits) |
| MongoDB | ✓ | ✓ | ✓ sampled fields | – | – |
| DuckDB | ✓ | ✓ | ✓ | – | – |

MongoDB queries are written as in the shell, for example
`db.orders.find({ status: "paid" }).sort({ total: -1 }).limit(20)` or `db.orders.aggregate([…])`.

## AI providers

| Provider | Notes |
|---|---|
| **Claude Code** (default) | Uses your existing `claude` login. Gets QueryLens as an MCP server, so it can measure fixes. |
| LM Studio, Ollama | Fully local: nothing leaves your machine. |
| OpenRouter, OpenAI, any OpenAI-compatible API | API key stored in the OS keychain. |

The model sees a compact, normalized plan plus schema facts (existing indexes, sizes,
column statistics), never table rows.

## Private

No accounts and no telemetry. Connection passwords and API keys live in the OS keychain,
and history stays in a local SQLite file.

## Getting started

Prerequisites: Node 22+, pnpm, stable Rust, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
pnpm install
```

```bash
pnpm tauri dev
```

### Demo databases

PostgreSQL, MySQL and MongoDB, seeded with deliberately slow queries:

```bash
docker compose -f dev/docker-compose.yml up -d --build
```

All on host `localhost`, database `shop`:

| Engine | Port | User | Password |
|---|---|---|---|
| PostgreSQL | `54329` | `querylens` | none |
| MySQL | `33069` | `querylens` | `querylens` |
| MongoDB | `27019` | none | none |

For a harder workload, `dev/load-job.sh` loads the IMDB dataset and the
[Join Order Benchmark](https://github.com/gregrahn/join-order-benchmark) queries into
PostgreSQL.

## Development

| Command | What it does |
|---|---|
| `pnpm dev` | UI only, in a browser, against a mock backend with a real captured plan |
| `pnpm tauri dev` | Full desktop app with hot reload |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` | TypeScript, oxlint, Prettier |
| `pnpm bindings` | Regenerate `src/bindings/*.ts` from the Rust types (ts-rs) |
| `cd src-tauri && cargo test --lib` | Unit tests: parsers, scoring, warnings, storage, query parsing |
| `pnpm tauri build` | Release installers (`.msi`/`.exe`, `.dmg`, `.AppImage`/`.deb`) |

Live tests against the demo databases (and optionally Claude Code) are opt-in through
environment variables; see [docs/architecture.md §10](docs/architecture.md#10-build-test-ship).

```
src/            React 19 + shadcn/ui frontend
src/bindings/   TypeScript types generated from Rust (do not edit)
src-tauri/      Rust core: engines, plan parsing and scoring, LLM providers, MCP server, storage
dev/            Docker Compose demo databases and seed data
docs/           Product, architecture and scope documents
```

## Documentation

- [Vision](docs/vision.md): the product, positioning, and what it is not
- [Architecture](docs/architecture.md): stack, data model, safety envelope, LLM and MCP design
- [Scope](docs/mvp.md): what shipped, what's deferred

## License

[MIT](LICENSE)
