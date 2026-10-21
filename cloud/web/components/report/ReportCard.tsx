// The query report's building block: a card whose top answers its question at a glance, and
// whose "Details" fold holds the evidence behind it. Native <details>, so it opens with the
// keyboard and needs no script.
import { ChevronRightIcon } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

export type Tone = 'ok' | 'warning' | 'danger'

const TONE_BORDER: Record<Tone, string> = {
  ok: '',
  warning: 'border-warning/60',
  danger: 'border-destructive/60',
}

export function ReportCard({
  label,
  tone = 'ok',
  children,
  details,
  detailsLabel = 'Details',
  className,
}: {
  /** What the card answers, as a small heading. */
  label: string
  tone?: Tone
  children?: ReactNode
  /** The evidence, folded. */
  details?: ReactNode
  detailsLabel?: string
  className?: string
}) {
  return (
    <section aria-label={label} className={cn('overflow-hidden rounded-xl border bg-card', TONE_BORDER[tone], className)}>
      <div className="grid gap-3 px-5 py-4">
        <h2 className="text-xs font-medium text-muted-foreground">{label}</h2>
        {children}
      </div>
      {details && <Fold label={detailsLabel}>{details}</Fold>}
    </section>
  )
}

/** A folded section at the bottom of a card (or a row in it). */
export function Fold({ label, children, open, className }: { label: ReactNode; children: ReactNode; open?: boolean; className?: string }) {
  return (
    <details open={open} className={cn('group border-t', className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-5 py-2.5 text-xs font-medium text-primary outline-none hover:bg-muted/40 focus-visible:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        {label}
      </summary>
      <div className="px-5 pt-1 pb-4">{children}</div>
    </details>
  )
}

/** Label / value pairs inside a fold. */
export function Pairs({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
      {items.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** One headline number. `flag`: it's the problem, so it's marked (border and dot, text stays readable). */
export function Figure({ label, value, note, flag }: { label: string; value: ReactNode; note?: ReactNode; flag?: Tone }) {
  return (
    <div
      className={cn(
        'grid content-start gap-0.5 rounded-lg border bg-muted/30 px-3 py-2.5',
        flag === 'warning' && 'border-warning/60 bg-warning/[0.07]',
        flag === 'danger' && 'border-destructive/60 bg-destructive/[0.07]',
      )}
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {flag && flag !== 'ok' && (
          <span className={cn('size-1.5 rounded-full', flag === 'danger' ? 'bg-destructive' : 'bg-warning')} aria-hidden />
        )}
        {label}
      </span>
      <span className="text-lg font-semibold tracking-tight tabular">{value}</span>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  )
}
