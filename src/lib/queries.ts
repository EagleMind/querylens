/** Server state (owned by Rust), cached with TanStack Query. */
import { QueryClient, keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import type { ConnectionInput } from '@/bindings/ConnectionInput'
import type { Settings } from '@/bindings/Settings'
import { api } from '@/lib/ipc'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false },
    mutations: {
      onError: (e) => toast.error(e.message),
    },
  },
})

export const keys = {
  connections: ['connections'] as const,
  history: (search: string) => ['history', search] as const,
  analysis: (id: string) => ['analysis', id] as const,
  settings: ['settings'] as const,
  captures: ['captures'] as const,
  runningCaptures: ['captures', 'running'] as const,
  captureReport: (id: string) => ['captures', 'report', id] as const,
}

export function useConnections() {
  return useQuery({ queryKey: keys.connections, queryFn: api.listConnections })
}

export function useSaveConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ConnectionInput) => api.saveConnection(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connections }),
  })
}

export function useDeleteConnection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.connections }),
  })
}

export function useHistory(search: string) {
  return useQuery({
    queryKey: keys.history(search),
    queryFn: () => api.listHistory(search),
    placeholderData: keepPreviousData,
  })
}

export function useDeleteAnalysis() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteAnalysis(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['history'] }),
  })
}

export function useClearHistory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.clearHistory,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['history'] }),
  })
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: api.getSettings, staleTime: Infinity })
}

export function useSaveSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ settings, apiKey }: { settings: Settings; apiKey?: string }) => api.saveSettings(settings, apiKey),
    onSuccess: (saved) => qc.setQueryData(keys.settings, saved),
  })
}

export function useCaptures() {
  return useQuery({ queryKey: keys.captures, queryFn: api.listCaptures })
}

/** Running captures, polled while any is running so counters stay live. */
export function useRunningCaptures() {
  return useQuery({
    queryKey: keys.runningCaptures,
    queryFn: api.runningCaptures,
    refetchInterval: (q) => (q.state.data?.length ? 1000 : false),
  })
}

export function useCaptureReport(id: string | null) {
  return useQuery({
    queryKey: keys.captureReport(id ?? ''),
    queryFn: () => api.captureReport(id!),
    enabled: !!id,
    staleTime: Infinity,
  })
}

export function useStartCapture() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ connectionId, port }: { connectionId: string; port: number | null }) =>
      api.startCapture(connectionId, port),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.captures }),
  })
}

export function useStopCapture() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.stopCapture(id),
    onSuccess: (report) => {
      qc.setQueryData(keys.captureReport(report.capture.id), report)
      return qc.invalidateQueries({ queryKey: keys.captures, predicate: (q) => q.queryKey[1] !== 'report' })
    },
  })
}

export function useProfileCapture() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.captureReport(id, true),
    onSuccess: (report) => qc.setQueryData(keys.captureReport(report.capture.id), report),
  })
}

export function useDeleteCapture() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteCapture(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.captures }),
  })
}
