import { useMutation, useQueryClient } from '@tanstack/react-query'

import type { ExplainMode } from '@/bindings/ExplainMode'
import { api } from '@/lib/ipc'
import { keys } from '@/lib/queries'
import { useWorkspace } from '@/store/workspace'

export function useAnalyze() {
  const qc = useQueryClient()
  const setAnalysis = useWorkspace((s) => s.setAnalysis)

  return useMutation({
    mutationFn: (v: { connectionId: string; sql: string; mode: ExplainMode; params?: (string | null)[] }) =>
      api.analyze(v.connectionId, v.sql, v.mode, v.params),
    onSuccess: (analysis) => {
      setAnalysis(analysis)
      qc.setQueryData(keys.analysis(analysis.id), analysis)
      qc.invalidateQueries({ queryKey: ['history'] })
      qc.invalidateQueries({ queryKey: keys.connections })
    },
    // Errors render inline in the plan pane instead of a toast.
    onError: () => {},
  })
}
