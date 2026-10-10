import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

import { Registered } from './bits'

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
    <div className={cn('flex h-full flex-col items-center justify-center gap-4 p-8 text-center', className)}>
      <Registered>
        <Icon className="size-5 text-foreground/70" strokeWidth={1.5} />
      </Registered>
      <div className="space-y-1.5">
        <h3 className="text-[17px] font-semibold">{title}</h3>
        {children && <div className="max-w-sm text-[13px]/relaxed text-muted-foreground">{children}</div>}
      </div>
      {action}
    </div>
  )
}
