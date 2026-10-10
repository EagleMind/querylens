/**
 * Typed wrappers around Tauri commands. The only module that talks to the backend.
 *
 * Outside Tauri (plain `pnpm dev` in a browser) calls are routed to an in-memory
 * mock backend so the UI can be developed without the Rust side.
 */
import { Channel, invoke, isTauri } from '@tauri-apps/api/core'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import type { AppError } from '@/bindings/AppError'
import type { Connection } from '@/bindings/Connection'
import type { ConnectionInput } from '@/bindings/ConnectionInput'
import type { ConnectionTestResult } from '@/bindings/ConnectionTestResult'
import type { ExplainMode } from '@/bindings/ExplainMode'
import type { HistoryEntry } from '@/bindings/HistoryEntry'
import type { LlmSettings } from '@/bindings/LlmSettings'
import type { LlmTestResult } from '@/bindings/LlmTestResult'
import type { PlanDiff } from '@/bindings/PlanDiff'
import type { SensitivityReport } from '@/bindings/SensitivityReport'
import type { TopQuery } from '@/bindings/TopQuery'
import type { TopQueryOrder } from '@/bindings/TopQueryOrder'
import type { Settings } from '@/bindings/Settings'
import type { SuggestionEvent } from '@/bindings/SuggestionEvent'
import type { WhatIfEvent } from '@/bindings/WhatIfEvent'

export class IpcError extends Error {
  readonly kind: AppError['kind']
  constructor(error: AppError) {
    super(error.message)
    this.kind = error.kind
  }
}

function toIpcError(e: unknown): IpcError {
  if (e instanceof IpcError) return e
  if (e && typeof e === 'object' && 'message' in e && 'kind' in e) return new IpcError(e as AppError)
  return new IpcError({ kind: 'internal', message: String(e) })
}

type Args = Record<string, unknown>

async function call<T>(command: string, args?: Args): Promise<T> {
  try {
    if (isTauri()) return await invoke<T>(command, args)
    if (!import.meta.env.DEV)
      throw new IpcError({ kind: 'internal', message: 'QueryLens must run inside its desktop app.' })
    const { mockInvoke } = await import('@/dev/mockBackend')
    return await mockInvoke<T>(command, args)
  } catch (e) {
    throw toIpcError(e)
  }
}

export const api = {
  listConnections: () => call<Connection[]>('list_connections'),
  saveConnection: (input: ConnectionInput) => call<Connection>('save_connection', { input }),
  deleteConnection: (id: string) => call<void>('delete_connection', { id }),
  testConnection: (input: ConnectionInput) => call<ConnectionTestResult>('test_connection', { input }),

  analyze: (connectionId: string, sql: string, mode: ExplainMode, params: (string | null)[] = []) =>
    call<AnalysisResult>('analyze_query', { connectionId, sql, mode, params: params.length ? params : null }),

  sensitivity: (analysisId: string) => call<SensitivityReport[]>('parameter_sensitivity', { analysisId }),
  topQueries: (connectionId: string, orderBy: TopQueryOrder, limit = 50) =>
    call<TopQuery[]>('top_queries', { connectionId, orderBy, limit }),

  listHistory: (search?: string, limit = 200) =>
    call<HistoryEntry[]>('list_history', { search: search || null, limit }),
  getAnalysis: (id: string) => call<AnalysisResult>('get_analysis', { id }),
  deleteAnalysis: (id: string) => call<void>('delete_analysis', { id }),
  clearHistory: () => call<void>('clear_history'),

  getSettings: () => call<Settings>('get_settings'),
  /** `apiKey`: undefined keeps the stored key, "" removes it. */
  saveSettings: (settings: Settings, apiKey?: string) =>
    call<Settings>('save_settings', { settings, apiKey: apiKey ?? null }),
  listModels: (llm: LlmSettings) => call<string[]>('list_llm_models', { llm }),
  testLlm: () => call<LlmTestResult>('test_llm'),

  /** Starts generation; events (including the final result) arrive on `onEvent`. */
  async getSuggestions(analysisId: string, onEvent: (e: SuggestionEvent) => void): Promise<string> {
    if (!isTauri() && import.meta.env.DEV) {
      const { mockSuggestions } = await import('@/dev/mockBackend')
      return mockSuggestions(analysisId, onEvent)
    }
    const channel = new Channel<SuggestionEvent>()
    channel.onmessage = onEvent
    return call<string>('get_suggestions', { analysisId, onEvent: channel })
  },
  /** Cancel any background job (suggestions, what-if sweep, sensitivity). */
  cancelTask: (requestId: string) => call<void>('cancel_task', { requestId }),

  compare: (beforeId: string, afterId: string) => call<PlanDiff>('compare_analyses', { beforeId, afterId }),

  /** Re-run an analysis with a fix applied (rolled back); returns the new analysis. */
  previewFix: (analysisId: string, fix: string) => call<AnalysisResult>('preview_fix', { analysisId, fix }),

  /** Start a planner what-if sweep; events (incl. the final report) arrive on `onEvent`. */
  async runWhatif(analysisId: string, onEvent: (e: WhatIfEvent) => void): Promise<string> {
    if (!isTauri() && import.meta.env.DEV) {
      const { mockWhatif } = await import('@/dev/mockBackend')
      return mockWhatif(analysisId, onEvent)
    }
    const channel = new Channel<WhatIfEvent>()
    channel.onmessage = onEvent
    return call<string>('run_whatif', { analysisId, onEvent: channel })
  },
}

/** Native file picker for DuckDB databases; null when cancelled or unavailable. */
export async function pickDuckdbFile(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'DuckDB', extensions: ['duckdb', 'db', 'ddb'] }],
  })
  return typeof picked === 'string' ? picked : null
}

export { isTauri }
