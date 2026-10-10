Here's the full architecture and project plan for **QueryLens** (suggested name) — a local-first, multi-engine SQL query profiler desktop app.

---

# QueryLens — Project Architecture & Plan

## 1. Project Identity

**Name:** QueryLens
**Tagline:** "Explain every query. In every engine. In plain English."
**Type:** Local-first desktop application (Tauri v2)
**Audience:** Backend engineers, data engineers, DBAs
**Philosophy:** Zero infra. Zero SaaS. Runs next to your dev environment.

---

## 2. Technology Stack

### Frontend
- **Framework:** React 18 + TypeScript
- **Build tool:** Vite
- **UI Components:** shadcn/ui (Radix primitives)
- **Styling:** Tailwind CSS v4
- **SQL Editor:** CodeMirror 6 (with SQL language support & syntax highlighting)
- **Query Plan Visualization:** Custom React tree renderer (SVG-based, no D3 dependency)
- **State Management:** Zustand (lightweight, no boilerplate)
- **Data Fetching / Async:** TanStack Query (for caching AI responses and plan results)

### Backend (Tauri Rust side)
- **Runtime:** Tauri v2 (with `tauri-plugin-sql` for local DB connections)
- **Language:** Rust (stable)
- **Async:** Tokio
- **Database drivers:**
  - `sqlx` — PostgreSQL, MySQL, SQLite
  - `clickhouse-rs` — ClickHouse
  - `duckdb` crate — DuckDB (embedded)
  - `tiberius` — Microsoft SQL Server
  - `mongodb` driver (limited: aggregation pipeline analysis only)
- **Config storage:** Local SQLite via `sqlx` (connections, history, settings)
- **IPC:** Tauri commands (`#[tauri::command]`)

### LLM Layer
- **Abstraction:** Unified `LlmProvider` trait in Rust
- **Providers:**
  - OpenRouter (cloud, OpenAI-compatible API)
  - LM Studio (local, OpenAI-compatible API on `localhost:1234`)
  - Ollama (local, `localhost:11434`)
  - OpenAI direct (optional, same interface)
- **Transport:** `reqwest` async HTTP client
- **Streaming:** SSE (Server-Sent Events) streamed to frontend via Tauri event emitter

---

## 3. Supported Databases

### Tier 1 — Full Support (EXPLAIN + plan parsing + cost nodes)
| Database | Protocol | EXPLAIN Syntax | Notes |
|---|---|---|---|
| PostgreSQL | TCP/libpq | `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` | Primary target |
| DuckDB | Embedded | `EXPLAIN ANALYZE` | Bundled, no server needed |
| ClickHouse | HTTP/Native | `EXPLAIN PLAN` + `EXPLAIN ANALYZE` | HTTP port 8123 |
| MySQL / MariaDB | TCP | `EXPLAIN FORMAT=JSON` | Via sqlx |
| SQLite | File | `EXPLAIN QUERY PLAN` | Via sqlx, local file |
| Microsoft SQL Server | TDS protocol | `SET STATISTICS IO, TIME ON` + `sys.dm_exec_query_plan` | Via tiberius |

### Tier 2 — Partial Support (query analysis, no visual plan)
| Database | Notes |
|---|---|
| MongoDB | Aggregation pipeline `.explain("executionStats")` |
| Redis | `LATENCY HISTORY`, `SLOWLOG GET` |
| Snowflake | `EXPLAIN` via HTTP API (requires token) |
| BigQuery | `EXPLAIN` not supported; DRY_RUN query job cost estimation |

### Tier 3 — Connection Testing Only (future roadmap)
- CockroachDB (Postgres-wire compatible, promotes to Tier 1 easily)
- Redshift (Postgres-compatible)
- PlanetScale (MySQL-compatible)

---

## 4. Application Architecture

### Layer Separation

```
┌─────────────────────────────────────────────────┐
│                  React Frontend                  │
│   UI / State / Editor / Visualization / UX       │
├─────────────────────────────────────────────────┤
│              Tauri IPC Bridge                    │
│          (typed commands + events)               │
├──────────────────────┬──────────────────────────┤
│   Database Layer     │      LLM Layer            │
│   (Rust + drivers)   │  (Rust + HTTP providers)  │
├──────────────────────┴──────────────────────────┤
│           Local Storage (SQLite)                 │
│  connections, history, settings, cached plans    │
└─────────────────────────────────────────────────┘
```

### Rust Module Structure

```
src-tauri/
├── src/
│   ├── main.rs
│   ├── lib.rs
│   ├── commands/
│   │   ├── mod.rs
│   │   ├── connections.rs     # CRUD for saved connections
│   │   ├── analysis.rs        # Run EXPLAIN, parse result
│   │   ├── llm.rs             # AI suggestion commands
│   │   └── history.rs         # Query history
│   ├── db/
│   │   ├── mod.rs
│   │   ├── driver.rs          # DbDriver trait
│   │   ├── postgres.rs
│   │   ├── duckdb.rs
│   │   ├── clickhouse.rs
│   │   ├── mysql.rs
│   │   ├── sqlite.rs
│   │   ├── mssql.rs
│   │   └── mongodb.rs
│   ├── plan/
│   │   ├── mod.rs
│   │   ├── parser.rs          # Engine-specific plan JSON → PlanNode tree
│   │   ├── normalizer.rs      # Normalize all plans to unified PlanNode schema
│   │   └── cost.rs            # Cost scoring, percentile ranking
│   ├── llm/
│   │   ├── mod.rs
│   │   ├── provider.rs        # LlmProvider trait
│   │   ├── openrouter.rs
│   │   ├── lmstudio.rs
│   │   ├── ollama.rs
│   │   └── openai.rs
│   ├── storage/
│   │   ├── mod.rs
│   │   └── local_db.rs        # SQLite-backed local persistence
│   └── types.rs               # Shared Rust types (serde)
├── Cargo.toml
└── tauri.conf.json
```

### Frontend Module Structure

```
src/
├── main.tsx
├── App.tsx
├── routes/
│   ├── index.tsx              # Main analyzer view
│   ├── connections.tsx        # Connection manager
│   ├── history.tsx            # Query history
│   └── settings.tsx           # LLM + app settings
├── components/
│   ├── editor/
│   │   ├── SqlEditor.tsx      # CodeMirror wrapper
│   │   └── EngineSelector.tsx
│   ├── plan/
│   │   ├── PlanTree.tsx       # Visual node tree
│   │   ├── PlanNode.tsx       # Individual node card
│   │   ├── CostBadge.tsx      # Color-coded cost indicator
│   │   └── DiffView.tsx       # Before/After diff panel
│   ├── ai/
│   │   ├── SuggestionPanel.tsx
│   │   ├── SuggestionCard.tsx
│   │   └── StreamingText.tsx  # SSE stream renderer
│   ├── compare/
│   │   └── CrossEngineTable.tsx
│   ├── connections/
│   │   ├── ConnectionForm.tsx
│   │   └── ConnectionCard.tsx
│   └── shared/
│       ├── Badge.tsx
│       ├── CopyButton.tsx
│       └── EmptyState.tsx
├── store/
│   ├── useAnalysisStore.ts    # Active analysis state
│   ├── useConnectionStore.ts
│   └── useSettingsStore.ts
├── hooks/
│   ├── useAnalyze.ts          # Tauri command wrapper
│   ├── useLlmStream.ts        # SSE streaming hook
│   └── useConnections.ts
├── lib/
│   ├── tauri.ts               # Typed Tauri invoke wrappers
│   ├── planUtils.ts           # Cost formatting, percentile
│   └── constants.ts
└── types/
    ├── plan.ts                # PlanNode, CostNode types
    ├── connection.ts
    └── llm.ts
```

---

## 5. Core Data Types (Shared Schema)

### Unified Plan Node (TypeScript)

```typescript
interface PlanNode {
  id: string;
  nodeType: string;           // "Seq Scan", "Hash Join", "Index Scan", etc.
  relationName?: string;      // table name if applicable
  alias?: string;
  totalCost: number;          // normalized 0–100 score
  actualTimeMs?: number;      // actual execution time
  estimatedRows: number;
  actualRows?: number;
  loops?: number;
  bufferHits?: number;
  bufferReads?: number;
  costPercentile: number;     // relative to siblings (0–100)
  isExpensive: boolean;       // top 20% cost nodes
  children: PlanNode[];
  rawNode: Record<string, unknown>; // engine-specific raw JSON
  engine: DbEngine;
  warnings: PlanWarning[];
}

interface PlanWarning {
  type: "missing_index" | "seq_scan_large" | "high_sort_cost" | "row_estimate_error" | "nested_loop_risk";
  message: string;
  severity: "error" | "warning" | "info";
  suggestion?: string;
}

type DbEngine = "postgresql" | "duckdb" | "clickhouse" | "mysql" | "sqlite" | "mssql" | "mongodb";
```

### LLM Provider Config

```typescript
interface LlmConfig {
  provider: "openrouter" | "lmstudio" | "ollama" | "openai";
  baseUrl: string;            // e.g. "http://localhost:1234/v1" for LM Studio
  apiKey?: string;            // optional for local providers
  model: string;              // e.g. "mistralai/mistral-7b-instruct"
  maxTokens: number;
  temperature: number;
  streamingEnabled: boolean;
}
```

### Saved Connection

```typescript
interface DbConnection {
  id: string;
  name: string;
  engine: DbEngine;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;          // stored encrypted in local SQLite
  filePath?: string;          // for SQLite/DuckDB file-based
  sslEnabled: boolean;
  sshTunnel?: SshTunnelConfig;
  color: string;              // user-assigned color tag
  lastUsedAt: string;
}
```

---

## 6. LLM Layer Architecture

### The Provider Trait (Rust)

```rust
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn complete(&self, prompt: &str) -> Result<String>;
    async fn stream(&self, prompt: &str, tx: Sender<String>) -> Result<()>;
    fn provider_name(&self) -> &'static str;
}
```

All providers (OpenRouter, LM Studio, Ollama, OpenAI) implement this trait. They all speak the OpenAI-compatible `/v1/chat/completions` API, so the implementation is nearly identical — only the `base_url` and auth header differ.

### Prompt Engineering

The LLM is given a structured system prompt + a JSON representation of the parsed plan. It is **never** given raw EXPLAIN output (too verbose, too engine-specific). The normalized `PlanNode` tree is serialized to a compact JSON, keeping only: `nodeType`, `actualTimeMs`, `estimatedRows`, `actualRows`, `warnings`.

**System prompt template:**
```
You are a database performance expert. Analyze this query execution plan and provide:
1. A list of specific, actionable optimization suggestions (max 5)
2. For each suggestion: estimated impact (high/medium/low), the node it targets, and the exact SQL fix
3. A one-sentence plain-English summary of the query's main bottleneck

Respond ONLY in this JSON schema: { suggestions: [...], summary: "..." }
Engine: {engine}
Query: {sql}
Plan: {compact_plan_json}
```

---

## 7. Key Features — Implementation Details

### Feature 1: Query Analyzer (Core)

**Flow:**
1. User writes SQL + selects connection → clicks Analyze
2. Frontend calls `invoke("analyze_query", { connectionId, sql })`
3. Rust: opens connection, runs `EXPLAIN ANALYZE` with appropriate syntax per engine
4. Rust: parses raw JSON/text output → normalizes to `PlanNode` tree
5. Rust: scores each node (cost percentile, flags expensive nodes, generates `PlanWarning` list)
6. Returns `AnalysisResult` to frontend
7. Frontend renders the plan tree with cost coloring

**Cost coloring thresholds:**
- 🔴 Red — top 20% cost (isExpensive = true)
- 🟡 Yellow — 20–60% cost
- 🟢 Green — bottom 40% cost

### Feature 2: AI Suggestions

**Flow:**
1. After plan is rendered, user clicks "Get AI Suggestions" (or auto-triggered if enabled)
2. Frontend calls `invoke("get_suggestions", { analysisId, llmConfigId })`
3. Rust: serializes compact plan, builds prompt, calls LLM provider
4. Streaming: Rust emits Tauri events `suggestion-chunk` as SSE arrives
5. Frontend hook `useLlmStream` listens and appends to streaming state
6. Final JSON is parsed and rendered as `SuggestionCard` list

### Feature 3: Before/After Diff

- When the LLM returns a rewritten SQL in its suggestions, the user can click "Preview Rewrite"
- This runs a second `analyze_query` with the rewritten SQL
- The `DiffView` component shows the two `PlanNode` trees side by side
- Cost delta is computed and shown prominently: `"This rewrite saves ~4,811ms per execution"`

### Feature 4: Cross-Engine Comparison

- User selects multiple connections (must be different engines)
- Same SQL is dispatched in parallel via `invoke("compare_engines", { connectionIds, sql })`
- Rust uses `tokio::join!` to run all EXPLAIN calls concurrently
- Results are normalized and returned as `ComparisonResult[]`
- Frontend renders `CrossEngineTable` with per-step timing breakdown

### Feature 5: Connection Manager

- Full CRUD for saved connections
- Connection passwords encrypted with AES-256-GCM using a machine-local key (stored in OS keychain via `keyring` crate)
- Test connection button with latency ping
- Color tags for visual identification in the sidebar

### Feature 6: Query History

- Every `analyze_query` call is persisted to local SQLite with: SQL, engine, plan JSON, suggestions, timestamp
- Searchable by SQL text, engine, date range
- Can re-open any historical analysis (read-only)
- Export as JSON or Markdown report

---

## 8. UI/UX Design Specification

### Design Language
- **Theme:** Dark-first (developer tool default), light mode optional
- **Aesthetic:** Precision minimalism — tight spacing, monospace accents, data-dense but never cluttered
- **Font:** Geist Mono for code/numbers, Geist Sans for UI text (Vercel's open-source family, designed for developer tools)
- **Accent color:** A single electric teal (`#00D4AA`) for interactive elements and cost indicators
- **Borders:** Subtle (`border-white/8` in dark mode) — structure without noise

### Layout (Main Window)

```
┌─ Sidebar (220px) ─┬─────── Main Content Area ──────────────┐
│                   │                                         │
│ [QueryLens logo]  │  [Tab bar: Analyze | Compare | History] │
│                   │  ─────────────────────────────────────  │
│ Connections       │  SQL Editor (top ~35%)                  │
│  ● my-postgres    │  ─────────────────────────────────────  │
│  ● local-duck     │  [Plan Tree] │ [AI Suggestions]         │
│  ● ch-prod        │  (bottom ~65%, split panel)             │
│                   │                                         │
│ ─────────────     │                                         │
│ History           │                                         │
│ Settings          │                                         │
└───────────────────┴─────────────────────────────────────────┘
```

### Plan Tree Nodes

Each node is a card with:
- Left color bar (red/yellow/green based on cost percentile)
- Node type as monospace heading (`Seq Scan`)
- Table name as subdued subtitle
- Cost pill on the right (`4,823ms`)
- Warning icons inline if `PlanWarning` present
- Chevron to expand children

Nodes are indented to show parent-child relationships. No SVG arrows — pure CSS indentation with a connecting line (simpler, faster, more readable).

### Suggestion Cards

Each `SuggestionCard`:
- Severity icon (🔴 🟡 🟢)
- One-line title: `"Missing index on orders.user_id"`
- Expandable body with explanation
- "Copy Fix" button → copies migration SQL or query rewrite
- "Preview Diff" button → triggers Before/After view

### Settings Screen

Organized into 3 sections:

**LLM Provider**
- Provider selector (OpenRouter / LM Studio / Ollama / OpenAI)
- Base URL field (pre-filled per provider, editable)
- API Key field (masked, stored in keychain)
- Model field (free text or dropdown if provider supports model listing)
- Stream responses toggle
- "Test Connection" button

**Preferences**
- Theme (Dark / Light / System)
- Auto-run AI suggestions toggle
- Cost thresholds (customizable red/yellow percentile cutoffs)
- Default engine for new connections

**Data**
- Clear history button
- Export all data as JSON
- App version + update check

---

## 9. Build & Distribution

### Development

```bash
# Install deps
pnpm install

# Run Tauri dev mode
pnpm tauri dev

# Type-check frontend
pnpm tsc --noEmit

# Lint
pnpm eslint src/
```

### Build

```bash
# Production build — outputs platform-specific installer
pnpm tauri build
```

**Output artifacts:**
- macOS: `.dmg` + `.app`
- Windows: `.msi` + `.exe` (NSIS installer)
- Linux: `.AppImage` + `.deb`

### CI/CD (GitHub Actions)

- `build.yml`: matrix build across `ubuntu-latest`, `windows-latest`, `macos-latest`
- Auto-publish to GitHub Releases on version tag push
- No code signing in v1 (add later for macOS notarization)

### Auto-Update

- Tauri's built-in updater (`tauri-plugin-updater`)
- Update manifest served from GitHub Releases JSON
- User sees subtle "Update available" banner — never forced

---

## 10. Development Phases

### Phase 0 — Scaffold (Week 1)
- [ ] Init Tauri v2 + React + Vite project
- [ ] Configure Tailwind v4 + shadcn/ui
- [ ] Set up local SQLite schema (connections, history tables)
- [ ] Implement sidebar layout + routing (Analyze / Compare / History / Settings)
- [ ] Wire basic Tauri IPC (hello world command)

### Phase 1 — Core Analysis (Weeks 2–3)
- [ ] PostgreSQL driver + EXPLAIN JSON parser → PlanNode normalizer
- [ ] DuckDB embedded driver + parser
- [ ] Plan tree renderer (React, cost-colored nodes)
- [ ] SQL editor (CodeMirror, PostgreSQL syntax)
- [ ] Connection manager (CRUD + encrypted storage)

### Phase 2 — LLM Layer (Week 4)
- [ ] `LlmProvider` trait + LM Studio implementation
- [ ] OpenRouter implementation
- [ ] Ollama implementation
- [ ] Streaming via Tauri events → frontend SSE hook
- [ ] Prompt builder (compact plan JSON → structured prompt)
- [ ] Suggestion card UI with "Copy Fix"

### Phase 3 — More Engines (Week 5)
- [ ] ClickHouse driver + parser
- [ ] MySQL/MariaDB driver + parser
- [ ] SQLite driver + parser
- [ ] MSSQL driver + parser
- [ ] Engine selector updates + Tier 2 partial support stubs

### Phase 4 — Diff & Compare (Week 6)
- [ ] Before/After diff view (parallel analysis run)
- [ ] Cost delta computation + display
- [ ] Cross-engine comparison tab
- [ ] CrossEngineTable component

### Phase 5 — Polish (Week 7)
- [ ] Query history with search
- [ ] Settings screen (all LLM providers, preferences)
- [ ] Light mode + theme toggle
- [ ] Keyboard shortcuts (Cmd+Enter to analyze, Cmd+K command palette)
- [ ] Empty states, loading skeletons, error boundaries
- [ ] Export: analysis as Markdown report

### Phase 6 — Ship (Week 8)
- [ ] GitHub Actions build matrix
- [ ] Tauri auto-updater integration
- [ ] README + docs site (simple, no SaaS)
- [ ] v1.0.0 release

---

## 11. Key Technical Decisions & Rationale

| Decision | Choice | Why |
|---|---|---|
| Desktop runtime | Tauri v2 (not Electron) | 10–30x smaller binary, no bundled Chromium, native OS feel |
| DB drivers | Rust-native crates | No Node.js FFI overhead, safe async |
| State management | Zustand over Redux | Zero boilerplate for a single-user desktop app |
| Plan tree rendering | Custom React (no D3) | D3 adds 300KB+ and fights React's rendering model |
| LLM abstraction | Rust trait, not frontend JS | Keeps API keys server-side (Rust), never exposed to webview |
| Password storage | OS keychain via `keyring` crate | Safer than app-level encryption; integrates with macOS Keychain, Windows Credential Manager |
| Local persistence | SQLite via sqlx | Embedded, zero-config, reliable |
| Streaming LLM | Tauri event emitter | Cleaner than polling; maps naturally to SSE |
| SQL editor | CodeMirror 6 (not Monaco) | 3x smaller bundle, better Tauri webview compatibility |

---

## 12. What This Is NOT (Explicit Scope Boundaries)

- **Not a monitoring tool** — no continuous query capture, no alerts, no dashboards over time
- **Not a schema explorer** — no table browser, no ER diagrams
- **Not cloud/SaaS** — no accounts, no telemetry, no data leaves the machine
- **Not a query runner** — it doesn't execute your queries for results, only EXPLAIN plans
- **Not an IDE** — no file management, no git integration, no multi-file editing

---

This gives you a complete, copy-ready architecture document. Every module, type, feature, and phase is defined without any diagrams — pure structured Markdown throughout.