import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { api } from '@/lib/ipc'
import { idleWhatIf, useWorkspace } from '@/store/workspace'

/** Starts / stops the planner what-if sweep for the current analysis. */
export function useWhatIf() {
  const qc = useQueryClient()

  const start = useCallback(async () => {
    const ws = useWorkspace.getState()
    const analysisId = ws.analysis?.id
    if (!analysisId || ws.whatif.status === 'running') return
    ws.updateWhatIf({ ...idleWhatIf, status: 'running' })
    const isCurrent = () => useWorkspace.getState().analysis?.id === analysisId
    try {
      const requestId = await api.runWhatif(analysisId, (e) => {
        if (!isCurrent() || useWorkspace.getState().whatif.status === 'cancelled') return
        const s = useWorkspace.getState()
        switch (e.type) {
          case 'started':
            s.updateWhatIf({ scenarios: e.scenarios })
            break
          case 'running':
            s.updateWhatIf({ current: { kind: e.kind, phase: e.phase } })
            break
          case 'result':
            s.updateWhatIf({ results: [...s.whatif.results, e.result], current: null })
            break
          case 'done':
            s.updateWhatIf({ status: 'done', report: e.report, results: e.report.results, current: null })
            if (s.analysis) useWorkspace.setState({ analysis: { ...s.analysis, whatif: e.report } })
            qc.invalidateQueries({ queryKey: ['history'] })
            break
          case 'error':
            s.updateWhatIf({ status: 'error', error: e.message, current: null })
            break
        }
      })
      if (isCurrent()) useWorkspace.getState().updateWhatIf({ requestId })
    } catch (e) {
      if (isCurrent()) useWorkspace.getState().updateWhatIf({ status: 'error', error: (e as Error).message })
    }
  }, [qc])

  const stop = useCallback(async () => {
    const { whatif, updateWhatIf } = useWorkspace.getState()
    updateWhatIf({ status: 'cancelled', current: null })
    if (whatif.requestId) await api.cancelTask(whatif.requestId).catch(() => {})
  }, [])

  return { start, stop }
}
