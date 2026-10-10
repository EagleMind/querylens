/** UI state for the Analyze screen. Server data lives in TanStack Query instead. */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import type { ExplainMode } from '@/bindings/ExplainMode'
import type { SuggestionSet } from '@/bindings/SuggestionSet'

export interface Activity {
  id: number
  label: string
  detail: string | null
  at: number
}

export type StreamStatus = 'idle' | 'streaming' | 'done' | 'error' | 'cancelled'

export interface SuggestionStream {
  status: StreamStatus
  requestId: string | null
  provider: string | null
  model: string | null
  /** Text since the last activity: the current candidate JSON answer. */
  buffer: string
  activities: Activity[]
  error: string | null
  startedAt: number | null
}

const idleStream: SuggestionStream = {
  status: 'idle',
  requestId: null,
  provider: null,
  model: null,
  buffer: '',
  activities: [],
  error: null,
  startedAt: null,
}

interface WorkspaceState {
  sql: string
  connectionId: string | null
  mode: ExplainMode | null
  analysis: AnalysisResult | null
  /** True when the plan was opened from History rather than just run. */
  isReplay: boolean
  selectedNodeId: string | null
  stream: SuggestionStream

  setSql: (sql: string) => void
  setConnectionId: (id: string | null) => void
  setMode: (mode: ExplainMode) => void
  setAnalysis: (a: AnalysisResult | null, opts?: { replay?: boolean }) => void
  selectNode: (id: string | null) => void
  setSuggestions: (set: SuggestionSet) => void
  updateStream: (patch: Partial<SuggestionStream>) => void
  appendDelta: (text: string) => void
  pushActivity: (label: string, detail: string | null) => void
  resetStream: () => void
}

let activitySeq = 0

const SAMPLE_SQL = `SELECT u.email, count(*) AS orders, sum(o.total) AS spent
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'paid' AND u.country = 'TN'
GROUP BY u.email
ORDER BY spent DESC
LIMIT 20;`

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      sql: SAMPLE_SQL,
      connectionId: null,
      mode: null,
      analysis: null,
      isReplay: false,
      selectedNodeId: null,
      stream: idleStream,

      setSql: (sql) => set({ sql }),
      setConnectionId: (connectionId) => set({ connectionId }),
      setMode: (mode) => set({ mode }),
      setAnalysis: (analysis, opts) =>
        set({
          analysis,
          isReplay: !!opts?.replay,
          selectedNodeId: null,
          stream: analysis?.suggestions ? { ...idleStream, status: 'done' } : idleStream,
        }),
      selectNode: (selectedNodeId) => set({ selectedNodeId }),
      setSuggestions: (suggestions) => set((s) => (s.analysis ? { analysis: { ...s.analysis, suggestions } } : {})),
      updateStream: (patch) => set((s) => ({ stream: { ...s.stream, ...patch } })),
      appendDelta: (text) => set((s) => ({ stream: { ...s.stream, buffer: s.stream.buffer + text } })),
      pushActivity: (label, detail) =>
        set((s) => ({
          stream: {
            ...s.stream,
            buffer: '',
            activities: [...s.stream.activities, { id: ++activitySeq, label, detail, at: Date.now() }],
          },
        })),
      resetStream: () => set({ stream: idleStream }),
    }),
    {
      name: 'querylens.workspace',
      storage: createJSONStorage(() => localStorage),
      // Only the editor draft survives restarts; results come from history.
      partialize: (s) => ({ sql: s.sql, connectionId: s.connectionId, mode: s.mode }),
    },
  ),
)
