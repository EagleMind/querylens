import { useEffect, useLayoutEffect, useRef } from 'react'

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const modKey = isMac ? '⌘' : 'Ctrl'

/**
 * `combo` like "mod+enter" (mod = Cmd on macOS, Ctrl elsewhere). Fires even in inputs,
 * unless a focused widget (e.g. the editor's own keymap) already handled the key.
 */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, enabled = true) {
  const ref = useRef(handler)
  useLayoutEffect(() => {
    ref.current = handler
  })

  useEffect(() => {
    if (!enabled) return
    const parts = combo.toLowerCase().split('+')
    const key = parts.at(-1)!
    const wantMod = parts.includes('mod')
    const wantShift = parts.includes('shift')
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod !== wantMod || e.shiftKey !== wantShift) return
      if (e.key.toLowerCase() !== key) return
      e.preventDefault()
      ref.current(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [combo, enabled])
}
