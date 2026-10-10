import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon: LucideIcon
  title: string
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-3 p-8 text-center', className)}>
      <div className="relative">
        <div className="absolute inset-0 rounded-xl bg-primary/10 blur-xl" />
        <div className="relative flex size-11 items-center justify-center rounded-xl border bg-panel-raised">
          <Icon className="size-5 text-muted-foreground" />
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {children && <div className="max-w-sm text-xs/relaxed text-muted-foreground">{children}</div>}
      </div>
      {action}
    </div>
  )
}
