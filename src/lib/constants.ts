import { FileSearchIcon, TimerIcon } from 'lucide-react'

import type { Engine } from '@/bindings/Engine'
import type { ExplainMode } from '@/bindings/ExplainMode'
import type { LlmProviderKind } from '@/bindings/LlmProviderKind'

// Survey-ink swatches chosen to read on blueprint paper without clashing with plan heat.
export const CONNECTION_COLORS = [
  '#7fb3e6',
  '#f2d84a',
  '#b9a3f0',
  '#e98fb0',
  '#8fd0a8',
  '#e9a35b',
  '#f1ead9',
  '#8a96b3',
] as const

export const ENGINES: Record<
  Engine,
  {
    label: string
    short: string
    /** null = a local file, not a server. */
    defaultPort: number | null
    /** What users type in the editor. */
    language: 'sql' | 'mongo'
    defaultUser: string
  }
> = {
  postgres: { label: 'PostgreSQL', short: 'pg', defaultPort: 5432, language: 'sql', defaultUser: 'postgres' },
  mysql: { label: 'MySQL', short: 'my', defaultPort: 3306, language: 'sql', defaultUser: 'root' },
  mongodb: { label: 'MongoDB', short: 'mongo', defaultPort: 27017, language: 'mongo', defaultUser: '' },
  duckdb: { label: 'DuckDB', short: 'duck', defaultPort: null, language: 'sql', defaultUser: '' },
}

export const PROVIDERS: Record<
  LlmProviderKind,
  { label: string; baseUrl: string; needsKey: boolean; local: boolean; hint: string; modelPlaceholder: string }
> = {
  claude_code: {
    label: 'Claude Code',
    baseUrl: '',
    needsKey: false,
    local: false,
    hint: 'Uses your local Claude Code login. Can verify fixes against your database through MCP.',
    modelPlaceholder: 'default (or sonnet, opus, haiku)',
  },
  lm_studio: {
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    needsKey: false,
    local: true,
    hint: 'Fully local. Start the server in LM Studio → Developer.',
    modelPlaceholder: 'auto (first loaded model)',
  },
  ollama: {
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    local: true,
    hint: 'Fully local, via the OpenAI-compatible endpoint.',
    modelPlaceholder: 'e.g. qwen2.5-coder:14b',
  },
  open_router: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    local: false,
    hint: 'Hundreds of hosted models behind one key.',
    modelPlaceholder: 'e.g. nvidia/nemotron-3-ultra-550b-a55b:free',
  },
  open_ai: {
    label: 'OpenAI-compatible',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    local: false,
    hint: 'OpenAI or any server that speaks /v1/chat/completions.',
    modelPlaceholder: 'e.g. gpt-4.1',
  },
}

/**
 * The two ways to look at a query, named for what they *do* rather than as a mode.
 * `analyze`/`estimate` stay the internal names; users see Profile/Explain.
 */
export const ACTIONS: Record<
  ExplainMode,
  { label: string; busy: string; icon: typeof TimerIcon; title: string; body: string }
> = {
  analyze: {
    label: 'Profile',
    busy: 'Profiling…',
    icon: TimerIcon,
    title: 'Run the query and measure it',
    body: 'Executes the statement with EXPLAIN ANALYZE inside a transaction that is always rolled back. Real timings, real row counts.',
  },
  estimate: {
    label: 'Explain',
    busy: 'Explaining…',
    icon: FileSearchIcon,
    title: 'Show the plan without running it',
    body: "Plain EXPLAIN: the planner's estimates only. Nothing executes, so it's safe on production.",
  },
}
