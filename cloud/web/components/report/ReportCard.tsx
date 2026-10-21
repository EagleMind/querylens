// The query report's building block: a card whose top answers its question at a glance, and
// whose "Details" fold holds the evidence behind it. Native <details>, so it opens with the
// keyboard and needs no script.
import { ChevronRightIcon } from 'lucide-react'
import { Fragment, type ReactNode, createContext, useContext } from 'react'

import { cn } from '@/lib/utils'

export type Tone = 'ok' | 'warning' | 'danger'

/** `card`: each card framed, on the full report page. `plain`: unframed, inside the report panel's tabs. */
export const ReportChrome = createContext<'card' | 'plain'>('card')

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
  panelLabel = true,
  className,
}: {
  /** What the card answers, as a small heading. */
  label: string
  /** Show the heading in the report panel too; the verdict's is left to screen readers there. */
  panelLabel?: boolean
  tone?: Tone
  children?: ReactNode
  /** The evidence, folded. */
  details?: ReactNode
  detailsLabel?: string
  className?: string
}) {
  const plain = useContext(ReportChrome) === 'plain'
  return (
    <section aria-label={label} className={cn(plain ? '' : cn('overflow-hidden rounded-xl border bg-card', TONE_BORDER[tone]), className)}>
      <div className={cn('grid gap-3', plain ? 'pb-3' : 'px-5 py-4')}>
        <h2 className={cn('text-xs font-medium text-muted-foreground', plain && 'text-sm text-foreground', plain && !panelLabel && 'sr-only')}>{label}</h2>
        {children}
      </div>
      {details && <Fold label={detailsLabel}>{details}</Fold>}
    </section>
  )
}

/** A folded section at the bottom of a card (or a row in it). */
export function Fold({ label, children, open, className }: { label: ReactNode; children: ReactNode; open?: boolean; className?: string }) {
  const plain = useContext(ReportChrome) === 'plain'
  return (
    <details open={open} className={cn('group border-t', className)}>
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-1.5 py-2.5 text-xs font-medium text-primary outline-none hover:bg-muted/40 focus-visible:bg-muted/40 [&::-webkit-details-marker]:hidden',
          plain ? '-mx-2 rounded-md px-2' : 'px-5',
        )}
      >
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        {label}
      </summary>
      <div className={cn('pt-1 pb-4', !plain && 'px-5')}>{children}</div>
    </details>
  )
}

/** Label / value pairs inside a fold. */
export function Pairs({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm @lg:grid-cols-[11rem_minmax(0,1fr)]">
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
        'grid content-start gap-0.5 rounded-lg border bg-muted/30 px-3 py-2.5 @max-lg:px-2.5 @max-lg:py-2',
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
