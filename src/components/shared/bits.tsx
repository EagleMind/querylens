import type { ReactNode } from 'react'

import type { Engine } from '@/bindings/Engine'
import { ENGINES } from '@/lib/constants'
import { cn } from '@/lib/utils'

export function EngineBadge({ engine, className }: { engine: Engine; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-4 items-center rounded-[3px] border px-1 font-mono text-[9px] font-medium tracking-wider text-muted-foreground',
        className,
      )}
    >
      {ENGINES[engine].short}
    </span>
  )
}

export function ColorDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn('inline-block size-2 shrink-0 rounded-full', className)}
      style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}55` }}
    />
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-[4px] border border-current/20 bg-current/5 px-1 font-mono text-[10px] font-medium opacity-80',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** Small uppercase section label used across panels. */
export function PaneLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn('font-mono text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase', className)}
    >
      {children}
    </span>
  )
}
