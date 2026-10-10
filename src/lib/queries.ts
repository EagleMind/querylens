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
