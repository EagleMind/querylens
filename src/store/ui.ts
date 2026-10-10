import { create } from 'zustand'

import type { Connection } from '@/bindings/Connection'

interface UiState {
  /** `undefined` = closed, `null` = creating, Connection = editing. */
  connectionDialog: Connection | null | undefined
  openConnectionDialog: (editing?: Connection) => void
  closeConnectionDialog: () => void
}

export const useUi = create<UiState>()((set) => ({
  connectionDialog: undefined,
  openConnectionDialog: (editing) => set({ connectionDialog: editing ?? null }),
  closeConnectionDialog: () => set({ connectionDialog: undefined }),
}))
