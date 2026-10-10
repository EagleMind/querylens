import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { api } from '@/lib/ipc'
import { useWorkspace } from '@/store/workspace'

/** Starts / stops AI suggestion generation for the current analysis. */
export function useSuggestionStream() {
  const qc = useQueryClient()

  const start = useCallback(async () => {
    const ws = useWorkspace.getState()
    const analysisId = ws.analysis?.id
    if (!analysisId || ws.stream.status === 'streaming') return

    ws.updateStream({
      status: 'streaming',
      requestId: null,
      buffer: '',
      activities: [],
      error: null,
      provider: null,
      model: null,
      startedAt: Date.now(),
    })

    // Events for a stale request (user re-ran the analysis) are ignored.
    const isCurrent = () => useWorkspace.getState().analysis?.id === analysisId
    try {
      const requestId = await api.getSuggestions(analysisId, (event) => {
        if (!isCurrent()) return
        const s = useWorkspace.getState()
        if (s.stream.status === 'cancelled') return
        switch (event.type) {
          case 'started':
            s.updateStream({ provider: event.provider, model: event.model })
            break
          case 'delta':
            s.appendDelta(event.text)
            break
          case 'activity':
            s.pushActivity(event.label, event.detail)
            break
          case 'done':
            s.setSuggestions(event.result)
            s.updateStream({ status: 'done' })
            qc.invalidateQueries({ queryKey: ['history'] })
            break
          case 'error':
            s.updateStream({ status: 'error', error: event.message })
            break
        }
      })
      if (isCurrent()) useWorkspace.getState().updateStream({ requestId })
    } catch (e) {
      if (isCurrent()) {
        useWorkspace.getState().updateStream({ status: 'error', error: (e as Error).message })
      }
    }
  }, [qc])

  const stop = useCallback(async () => {
    const { stream, updateStream } = useWorkspace.getState()
    updateStream({ status: 'cancelled' })
    if (stream.requestId) await api.cancelTask(stream.requestId).catch(() => {})
  }, [])

  return { start, stop }
}
