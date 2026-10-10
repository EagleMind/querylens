import type { Engine } from '@/bindings/Engine'
import type { LlmProviderKind } from '@/bindings/LlmProviderKind'

export const CONNECTION_COLORS = [
  '#2dd4bf',
  '#60a5fa',
  '#a78bfa',
  '#f472b6',
  '#fb923c',
  '#facc15',
  '#4ade80',
  '#94a3b8',
] as const

export const ENGINES: Record<Engine, { label: string; short: string; defaultPort: number | null }> = {
  postgres: { label: 'PostgreSQL', short: 'PG', defaultPort: 5432 },
  duckdb: { label: 'DuckDB', short: 'DUCK', defaultPort: null },
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
