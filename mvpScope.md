# QueryLens MVP

The MVP answers one question: **"Why is my query slow, and what should I do about it?"** — for the most common database, with AI suggestions, shippable in ~3 weeks.

---

## Scope Decision: What Makes the Cut

The full vision has 6 database engines, 4 LLM providers, cross-engine comparison, diff views, SSH tunnels, history search, and auto-updates. The MVP has exactly what's needed to be genuinely useful to one engineer on day one.

**The MVP is:** PostgreSQL + DuckDB analysis, LM Studio + OpenRouter LLM, plan tree visualization, AI suggestions, connection manager, query history.

**Cut entirely from MVP:**
- ClickHouse, MySQL, MSSQL, SQLite, MongoDB drivers
- Cross-engine comparison tab
- Before/After diff view
- SSH tunnel support
- Auto-updater
- Light mode
- Export / Markdown reports
- Command palette
- Ollama + OpenAI providers (added later; same interface as the two included)

---

## MVP Feature Set

### Feature 1: Connection Manager (Minimal)
- Add / edit / delete PostgreSQL and DuckDB connections
- PostgreSQL: host, port, database, user, password, SSL toggle
- DuckDB: file path picker (or `:memory:`)
- "Test Connection" button with latency result
- Passwords stored in OS keychain
- Connection list in sidebar with color dot

### Feature 2: SQL Editor + Analyze
- CodeMirror 6 editor with SQL syntax highlighting
- Connection selector dropdown (from saved connections)
- Single "Analyze" button → runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` on Postgres or `EXPLAIN ANALYZE` on DuckDB
- Loading state while query runs

### Feature 3: Plan Tree
- Visual node tree, indented, cost-colored (red / yellow / green)
- Each node shows: type, table name, actual time (ms), actual vs estimated rows
- Warning badges on nodes that have issues (seq scan on large table, row estimate error >10x, missing index signal)
- No pan/zoom needed — CSS scroll is fine for MVP

### Feature 4: AI Suggestions
- "Get Suggestions" button triggers LLM call
- Provider: LM Studio (local) or OpenRouter (cloud), configured in Settings
- Streaming response rendered live
- Output: 3–5 suggestion cards, each with severity, explanation, and copyable SQL fix
- If LLM not configured → clear CTA to set it up in Settings

### Feature 5: Query History
- Every analysis auto-saved to local SQLite
- History list in sidebar: connection name, SQL preview, timestamp
- Click any entry to reload the plan tree (read-only replay)
- No search in MVP — just a flat reverse-chronological list, capped at 100 entries

### Feature 6: Settings
- LLM provider selector: claude CLI through MCP / OpenRouter
- Base URL field (default pre-filled)
- API key field (masked)
- Model name field (free text)
- Stream toggle
- "Test LLM" button (sends a trivial prompt, confirms it works)

---

## MVP Data Types

Only what's needed — no `ComparisonResult`, no `DiffResult`, no `SshTunnelConfig`.

```typescript
type DbEngine = "postgresql" | "duckdb"

interface DbConnection {
  id: string
  name: string
  engine: DbEngine
  host?: string           // postgres only
  port?: number           // postgres only
  database?: string       // postgres only
  username?: string       // postgres only
  filePath?: string       // duckdb only
  sslEnabled: boolean
  color: string
}

interface PlanNode {
  id: string
  nodeType: string
  relationName?: string
  actualTimeMs?: number
  estimatedRows: number
  actualRows?: number
  costPercentile: number  // 0–100, relative to all nodes in this plan
  isExpensive: boolean    // costPercentile > 80
  children: PlanNode[]
  warnings: PlanWarning[]
}

interface PlanWarning {
  type: "seq_scan_large" | "row_estimate_error" | "missing_index"
  message: string
  severity: "error" | "warning" | "info"
}

interface AnalysisResult {
  id: string
  connectionId: string
  sql: string
  engine: DbEngine
  planRoot: PlanNode
  totalTimeMs: number
  analyzedAt: string
}

interface LlmConfig {
  provider: "lmstudio" | "openrouter"
  baseUrl: string
  apiKey?: string
  model: string
  streamingEnabled: boolean
}

interface Suggestion {
  severity: "high" | "medium" | "low"
  title: string
  explanation: string
  sqlFix?: string
}
```

---

## MVP Rust Module Structure

```
src-tauri/src/
├── main.rs
├── commands/
│   ├── connections.rs   # list, create, update, delete, test
│   ├── analysis.rs      # analyze_query → AnalysisResult
│   ├── llm.rs           # get_suggestions (streaming)
│   └── history.rs       # list, get_by_id
├── db/
│   ├── driver.rs        # DbDriver trait: explain_analyze() → String
│   ├── postgres.rs      # sqlx + JSON plan parser
│   └── duckdb.rs        # duckdb crate + plan parser
├── plan/
│   ├── parser.rs        # engine-specific raw JSON → PlanNode tree
│   └── cost.rs          # percentile scoring, warning detection
├── llm/
│   ├── provider.rs      # LlmProvider trait
│   ├── lmstudio.rs      # OpenAI-compat, localhost:1234
│   └── openrouter.rs    # OpenAI-compat, api.openrouter.ai
└── storage/
    └── local_db.rs      # SQLite: connections table, history table
```

---

## MVP Frontend Structure

```
src/
├── App.tsx
├── routes/
│   ├── analyze.tsx      # main screen
│   ├── history.tsx      # flat list
│   └── settings.tsx     # LLM config
├── components/
│   ├── editor/
│   │   ├── SqlEditor.tsx
│   │   └── ConnectionSelector.tsx
│   ├── plan/
│   │   ├── PlanTree.tsx
│   │   ├── PlanNode.tsx
│   │   └── CostBadge.tsx
│   ├── ai/
│   │   ├── SuggestionPanel.tsx
│   │   └── SuggestionCard.tsx
│   └── shared/
│       ├── CopyButton.tsx
│       └── EmptyState.tsx
├── store/
│   ├── useAnalysisStore.ts
│   └── useSettingsStore.ts
├── hooks/
│   ├── useAnalyze.ts
│   └── useLlmStream.ts
└── lib/
    ├── tauri.ts         # typed invoke wrappers
    └── planUtils.ts     # cost formatting helpers
```

---

## MVP Layout (Single Window)

```
┌─ Sidebar (200px) ─┬──────────────── Main Area ─────────────────┐
│                   │                                             │
│  QueryLens        │  [connection dropdown]  [Analyze button]    │
│                   │  ─────────────────────────────────────────  │
│  Connections      │  SQL Editor                                 │
│   + New           │  (CodeMirror, ~8 lines visible, resizable)  │
│   ● my-postgres   │  ─────────────────────────────────────────  │
│   ● local-duck    │                                             │
│                   │  Plan Tree          │  AI Suggestions       │
│  ──────────────   │  (scrollable)       │  [Get Suggestions]    │
│                   │                     │  ─────────────────    │
│  History          │  > Hash Join 🔴     │  🔴 Missing index     │
│  Settings         │    > Seq Scan 🔴    │     on orders.user_id │
│                   │    > Index Scan 🟢  │  🟡 DISTINCT on 2M    │
│                   │                     │     rows → use GROUP  │
└───────────────────┴─────────────────────┴─────────────────────-─┘
```

---

## MVP Build Phases

### Week 1 — Foundation
- [ ] Tauri v2 + React + Vite + Tailwind + shadcn/ui scaffold
- [ ] Sidebar layout + route stubs (Analyze / History / Settings)
- [ ] Local SQLite schema: `connections` table, `analyses` table
- [ ] Connection Manager: full CRUD, OS keychain for passwords, test connection

### Week 2 — Core Analysis
- [ ] PostgreSQL driver (`sqlx`) + `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` parser
- [ ] DuckDB embedded driver + `EXPLAIN ANALYZE` parser
- [ ] Plan normalizer: raw engine JSON → `PlanNode` tree
- [ ] Cost scorer: percentile ranking + warning detection
- [ ] Plan tree renderer: color-coded nodes, warnings, scroll
- [ ] SQL editor (CodeMirror) wired to Tauri `analyze_query` command
- [ ] Auto-save every analysis to history

### Week 3 — LLM + Polish
- [ ] LM Studio provider (OpenAI-compat, streaming)
- [ ] OpenRouter provider (OpenAI-compat, streaming)
- [ ] Tauri event emitter → `useLlmStream` hook → live suggestion rendering
- [ ] Suggestion cards with severity + Copy Fix button
- [ ] History list (read-only plan replay)
- [ ] Settings screen: LLM config, Test LLM button
- [ ] Error states, loading skeletons, empty states
- [ ] Manual test across macOS + Windows + Linux
- [ ] GitHub release with `.dmg`, `.msi`, `.AppImage`

---

## What the MVP Deliberately Defers

| Deferred Feature | Why Deferred | When to Add |
|---|---|---|
| ClickHouse, MySQL, MSSQL | More drivers = more parser work; Postgres covers most dev use cases | v1.1 |
| Cross-engine comparison | Requires multi-connection parallel execution + comparison UI | v1.2 |
| Before/After diff | Requires second analysis run + diff renderer | v1.1 |
| Ollama / OpenAI providers | Same interface as included providers; add in one afternoon | v1.1 |
| SSH tunnels | Significant Rust complexity; most dev DBs are local or VPN-accessible | v1.2 |
| History search | Flat list covers MVP needs; search adds index complexity | v1.1 |
| Auto-updater | GitHub releases + manual download is fine for early users | v1.1 |
| Light mode | Dark mode is the default for dev tools; light is cosmetic | v1.1 |

---

The MVP ships in ~3 weeks, works offline by default (LM Studio), needs zero infrastructure, and already does something no free open-source tool does: multi-engine EXPLAIN with AI-driven plain-English suggestions in a native desktop app.