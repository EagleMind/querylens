# QueryLens — Product Vision

> Explain every query, on every engine, in plain English.

QueryLens is a **local-first desktop app** that runs `EXPLAIN` on your SQL, turns the
plan into a readable tree that shows where the time goes, and asks an LLM for specific,
verified fixes.

Think of it as DevTools for SQL. You paste a query, pick a connection, press
<kbd>Ctrl/Cmd</kbd>+<kbd>Enter</kbd>, and see the plan and what to change.

---

## The problem

- Raw `EXPLAIN` output is hard to read. The numbers that matter (self time, row
  misestimates, sorts spilling to disk) are hidden in nested JSON or text.
- Good plan visualizers exist, but each covers one engine and is paste-only
  (explain.dalibo.com / pev2 for Postgres). None of them tells you *what to change*.
- The tools that do give advice (pganalyze, pgMustard) are SaaS products. You have to
  ship your schema and queries to a third party, which is often a non-starter.

## The product

| Pillar | What it means |
|---|---|
| **Readable plans** | A tree of operators colored by *self time* (exclusive time), not cumulative cost, so the hot node is obvious at a glance. |
| **Heuristics first** | Deterministic checks (large seq scan, row-estimate error, sort/hash spill, nested-loop blowup) run locally and instantly, with no LLM required. |
| **AI suggestions** | A model receives a compact, normalized plan plus schema context (existing indexes, table sizes) and returns 3–5 ranked fixes with copyable SQL. |
| **Verified suggestions** | With the Claude Code provider, the model can call QueryLens's own `explain_query` tool through MCP to test a rewrite before it recommends it. |
| **Multi-engine** | PostgreSQL, MySQL, MongoDB and DuckDB, all normalized into one plan model. More engines plug in behind the same trait. |
| **Local-first** | No accounts and no telemetry. Credentials live in the OS keychain. With a local model (LM Studio / Ollama), nothing leaves the machine. |

## Screens (target experience)

**Workbench (main screen).** The SQL editor is on top, with a connection picker and two
actions: **Profile** (run it, rolled back, real timings) and **Explain** (plan only,
never runs). The bottom half splits into the **plan tree** (left)
and the **AI panel** (right). Each plan node shows its operator, relation, self time,
a heat bar for its share of total time, actual vs. estimated rows, and warning badges.
Clicking a node expands its details (filters, index conditions, buffers, raw JSON).

**AI panel.** Suggestion cards stream in live. Each card has a severity, a title, an
explanation, the plan node it targets, and a **Copy fix** button. When the model is
investigating, for example running `EXPLAIN` on a candidate index or rewrite, the
panel shows those steps as they happen.

**Before / After diff (v1.1).** Run a suggested rewrite and see both plans side by
side with the delta: *"This rewrite saves ~4.8 s per execution (−99.7%)"*.

**Cross-engine comparison (v1.2).** Run the same query on Postgres, DuckDB and
ClickHouse and compare time per operator class (scan / join / aggregate / sort). It
answers: *"Is my query slow, or is this the wrong engine for this workload?"*

## What QueryLens is not

- **Not monitoring.** No continuous capture, alerting or dashboards (that's pganalyze or Datadog).
- **Not an IDE or schema browser.** No table explorer, ER diagrams or result grids.
- **Not a query runner.** It never returns result rows. `EXPLAIN ANALYZE` does execute
  the statement, so QueryLens always runs it inside a transaction that is rolled back,
  and offers an *Estimate* mode that never executes anything.
- **Not SaaS.** There is no server to run and nothing to sign up for.

## Positioning

| | explain.dalibo / pev2 | pgMustard | pganalyze | **QueryLens** |
|---|---|---|---|---|
| Engines | Postgres | Postgres | Postgres | Postgres, MySQL, MongoDB, DuckDB |
| Runs EXPLAIN for you | ✗ (paste) | ✗ (paste) | ✓ (agent) | ✓ (direct connection) |
| Fix suggestions | ✗ | ✓ (rules) | ✓ (rules) | ✓ (rules + LLM, verified) |
| Local / private | ✓ | ✗ | ✗ | ✓ |
| Cost | Free | Paid | Paid | Free / OSS |
