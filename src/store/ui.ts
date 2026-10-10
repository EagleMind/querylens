import { create } from 'zustand'

import type { Connection } from '@/bindings/Connection'

interface UiState {
  /** `undefined` = closed, `null` = creating, Connection = editing. */
  connectionDialog: Connection | null | undefined
  openConnectionDialog: (editing?: Connection) => void
  closeConnectionDialog: () => void
  /** Plan comparison open in the Compare dialog. */
  compare: { beforeId: string; afterId: string } | null
  openCompare: (beforeId: string, afterId: string) => void
  closeCompare: () => void
}

export const useUi = create<UiState>()((set) => ({
  connectionDialog: undefined,
  openConnectionDialog: (editing) => set({ connectionDialog: editing ?? null }),
  closeConnectionDialog: () => set({ connectionDialog: undefined }),
  compare: null,
  openCompare: (beforeId, afterId) => set({ compare: { beforeId, afterId } }),
  closeCompare: () => set({ compare: null }),
}))
