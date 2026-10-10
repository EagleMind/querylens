import type { ReactNode } from 'react'

import type { Engine } from '@/bindings/Engine'
import { ENGINES } from '@/lib/constants'
import { cn } from '@/lib/utils'

export function EngineBadge({ engine, className }: { engine: Engine; className?: string }) {
  return (
    <span className={cn('font-mono text-[10.5px] text-muted-foreground lowercase', className)}>
      {ENGINES[engine].short}
    </span>
  )
}

/** Connection color: a small ink swatch, like a map legend. */
export function ColorDot({ color, className }: { color: string; className?: string }) {
  return (
    <span className={cn('inline-block size-2 shrink-0 rounded-[2px]', className)} style={{ backgroundColor: color }} />
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-[3px] border border-current/25 px-1 font-mono text-[10px] opacity-75',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/** Section label used across panels. */
export function PaneLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-[12px] font-semibold text-muted-foreground', className)}>{children}</span>
}

/** Registration marks around a child, like the corners of a drawing sheet. */
export function Registered({ children, className }: { children: ReactNode; className?: string }) {
  const corner = 'pointer-events-none absolute size-2 border-foreground/35'
  return (
    <div className={cn('relative p-3', className)}>
      <span className={cn(corner, 'top-0 left-0 border-t border-l')} />
      <span className={cn(corner, 'top-0 right-0 border-t border-r')} />
      <span className={cn(corner, 'bottom-0 left-0 border-b border-l')} />
      <span className={cn(corner, 'right-0 bottom-0 border-r border-b')} />
      {children}
    </div>
  )
}
