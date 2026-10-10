/** UI state for the Analyze screen. Server data lives in TanStack Query instead. */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import type { SuggestionSet } from '@/bindings/SuggestionSet'

export interface Activity {
  id: number
  label: string
  detail: string | null
  at: number
}

export type StreamStatus = 'idle' | 'streaming' | 'done' | 'error' | 'cancelled'

/** What the editor holds: SQL, or a MongoDB query in shell syntax. */
export type QueryLanguage = 'sql' | 'mongo'

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
  /** Editor text (SQL or a MongoDB query, see `language`). */
  sql: string
  language: QueryLanguage
  /** The other language's draft, kept while switching between SQL and MongoDB connections. */
  drafts: Record<QueryLanguage, string>
  connectionId: string | null
  analysis: AnalysisResult | null
  /** True when the plan was opened from History rather than just run. */
  isReplay: boolean
  selectedNodeId: string | null
  planView: 'tree' | 'icicle'
  /** Inputs for `$1…$n` (the text NULL = SQL NULL). */
  params: string[]
  stream: SuggestionStream

  setSql: (sql: string) => void
  /** Switch the editor to a language, restoring that language's draft. */
  setLanguage: (language: QueryLanguage) => void
  /** Open a query (from History or Top queries) in its language, keeping the other draft. */
  loadQuery: (sql: string, language: QueryLanguage) => void
  setConnectionId: (id: string | null) => void
  setAnalysis: (a: AnalysisResult | null, opts?: { replay?: boolean }) => void
  selectNode: (id: string | null) => void
  setPlanView: (v: 'tree' | 'icicle') => void
  setParam: (index: number, value: string) => void
  setParams: (values: string[]) => void
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

const SAMPLE_MONGO = `db.orders.find({ status: "paid", total: { $gt: 900 } })
  .sort({ createdAt: -1 })
  .limit(20)`

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      sql: SAMPLE_SQL,
      language: 'sql',
      drafts: { sql: SAMPLE_SQL, mongo: SAMPLE_MONGO },
      connectionId: null,
      analysis: null,
      isReplay: false,
      selectedNodeId: null,
      planView: 'tree',
      params: [],
      stream: idleStream,

      setSql: (sql) => set({ sql }),
      setLanguage: (language) =>
        set((s) =>
          s.language === language
            ? {}
            : { language, sql: s.drafts[language], drafts: { ...s.drafts, [s.language]: s.sql } },
        ),
      loadQuery: (sql, language) =>
        set((s) => ({
          sql,
          language,
          drafts: s.language === language ? s.drafts : { ...s.drafts, [s.language]: s.sql },
        })),
      setConnectionId: (connectionId) => set({ connectionId }),
      setAnalysis: (analysis, opts) =>
        set({
          analysis,
          isReplay: !!opts?.replay,
          selectedNodeId: null,
          stream: analysis?.suggestions ? { ...idleStream, status: 'done' } : idleStream,
        }),
      selectNode: (selectedNodeId) => set({ selectedNodeId }),
      setPlanView: (planView) => set({ planView }),
      setParam: (index, value) =>
        set((s) => {
          const params = [...s.params]
          params[index] = value
          return { params }
        }),
      setParams: (params) => set({ params }),
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
      partialize: (s) => ({
        sql: s.sql,
        language: s.language,
        drafts: s.drafts,
        connectionId: s.connectionId,
        planView: s.planView,
        params: s.params,
      }),
    },
  ),
)
