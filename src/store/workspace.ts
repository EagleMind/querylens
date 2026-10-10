/** UI state for the Analyze screen. Server data lives in TanStack Query instead. */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import type { SuggestionSet } from '@/bindings/SuggestionSet'
import type { WhatIfReport } from '@/bindings/WhatIfReport'
import type { WhatIfResult } from '@/bindings/WhatIfResult'
import type { WhatIfScenario } from '@/bindings/WhatIfScenario'

export interface Activity {
  id: number
  label: string
  detail: string | null
  at: number
}

export type StreamStatus = 'idle' | 'streaming' | 'done' | 'error' | 'cancelled'

export interface WhatIfState {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  requestId: string | null
  scenarios: WhatIfScenario[]
  /** Scenario currently being evaluated and its phase ("planning" / "profiling"). */
  current: { kind: string; phase: string } | null
  results: WhatIfResult[]
  report: WhatIfReport | null
  error: string | null
}

export const idleWhatIf: WhatIfState = {
  status: 'idle',
  requestId: null,
  scenarios: [],
  current: null,
  results: [],
  report: null,
  error: null,
}

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
  analysis: AnalysisResult | null
  /** True when the plan was opened from History rather than just run. */
  isReplay: boolean
  selectedNodeId: string | null
  planView: 'tree' | 'icicle'
  stream: SuggestionStream
  whatif: WhatIfState
  insightsTab: 'advisor' | 'whatif'

  setSql: (sql: string) => void
  setConnectionId: (id: string | null) => void
  setAnalysis: (a: AnalysisResult | null, opts?: { replay?: boolean }) => void
  selectNode: (id: string | null) => void
  setPlanView: (v: 'tree' | 'icicle') => void
  setSuggestions: (set: SuggestionSet) => void
  updateStream: (patch: Partial<SuggestionStream>) => void
  appendDelta: (text: string) => void
  pushActivity: (label: string, detail: string | null) => void
  resetStream: () => void
  updateWhatIf: (patch: Partial<WhatIfState>) => void
  setInsightsTab: (t: 'advisor' | 'whatif') => void
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
      analysis: null,
      isReplay: false,
      selectedNodeId: null,
      planView: 'tree',
      stream: idleStream,
      whatif: idleWhatIf,
      insightsTab: 'advisor',

      setSql: (sql) => set({ sql }),
      setConnectionId: (connectionId) => set({ connectionId }),
      setAnalysis: (analysis, opts) =>
        set({
          analysis,
          isReplay: !!opts?.replay,
          selectedNodeId: null,
          stream: analysis?.suggestions ? { ...idleStream, status: 'done' } : idleStream,
          whatif: analysis?.whatif
            ? { ...idleWhatIf, status: 'done', report: analysis.whatif, results: analysis.whatif.results }
            : idleWhatIf,
        }),
      selectNode: (selectedNodeId) => set({ selectedNodeId }),
      setPlanView: (planView) => set({ planView }),
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
      updateWhatIf: (patch) => set((s) => ({ whatif: { ...s.whatif, ...patch } })),
      setInsightsTab: (insightsTab) => set({ insightsTab }),
    }),
    {
      name: 'querylens.workspace',
      storage: createJSONStorage(() => localStorage),
      // Only the editor draft survives restarts; results come from history.
      partialize: (s) => ({ sql: s.sql, connectionId: s.connectionId, planView: s.planView }),
    },
  ),
)
