// Small pieces the two pages share.
import { CheckIcon, CopyIcon, TimerIcon } from 'lucide-react'
import { Fragment, type ReactNode, useState } from 'react'

import type { SuggestionSeverity } from '../../bindings/SuggestionSeverity'
import { Sql } from '@/components/Sql'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SEVERITY } from '@/lib/format'
import { STATEMENT_ACTION, STATEMENT_TYPES, type StatementType } from '@/lib/queries'
import { cn } from '@/lib/utils'

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className={cn('size-7 text-muted-foreground', className)}
          aria-label={label}
          onClick={() =>
            navigator.clipboard?.writeText(value).then(() => {
              setDone(true)
              setTimeout(() => setDone(false), 1200)
            })
          }
        >
          {done ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{done ? 'Copied' : label}</TooltipContent>
    </Tooltip>
  )
}

/** SQL (`sql`: coloured, wrapped) or code (`wrap={false}`: kept as written), with a copy button. */
export function CodeBlock({ code, sql, wrap = true, className }: { code: string; sql?: boolean; wrap?: boolean; className?: string }) {
  return (
    <div className={cn('relative rounded-md border bg-muted/40', className)}>
      <pre
        className={cn(
          'max-h-96 overflow-auto p-3 pr-11 font-mono text-[12.5px] leading-relaxed',
          wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre',
        )}
      >
        {sql ? <Sql sql={code} /> : code}
      </pre>
      <CopyButton value={code} className="absolute top-1.5 right-1.5" />
    </div>
  )
}

export function SeverityDot({ severity }: { severity: SuggestionSeverity }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', SEVERITY[severity].dot)} aria-hidden />
}

/** Analysis text, with `inline code` spans rendered as code. */
export function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((p, i) =>
        p.length > 2 && p.startsWith('`') && p.endsWith('`') ? (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
            {p.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  )
}

export function ConnectionStatus({ state }: { state: 'connecting' | 'live' | 'offline' }) {
  const label = { live: 'Live', connecting: 'Connecting', offline: 'Reconnecting' }[state]
  const dot = state === 'live' ? 'bg-success' : state === 'offline' ? 'bg-destructive' : 'bg-warning'
  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <span className="relative flex size-2">
        {state === 'live' && <span className={cn('absolute inset-0 rounded-full animate-live-ring', dot)} />}
        <span className={cn('relative size-2 rounded-full', dot)} />
      </span>
      {label}
    </span>
  )
}

const ACTION_DOT = { read: 'bg-read', write: 'bg-write', other: 'bg-muted-foreground/60' } as const

/** The statement type, with its read / write colour as a marker beside the text. */
export function StatementTypeLabel({ type, className }: { type: StatementType; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono text-[11px] font-medium text-muted-foreground', className)}>
      <span className={cn('size-2 shrink-0 rounded-[2px]', ACTION_DOT[STATEMENT_ACTION[type]])} aria-hidden />
      {STATEMENT_TYPES[type]}
    </span>
  )
}

/** Bar fill for a statement in the request timeline. */
export const ACTION_FILL = { read: 'bg-read', write: 'bg-write', other: 'bg-muted-foreground/50' } as const

/** Marks a duration at or over the project's slow threshold: status colour on the icon only. */
export function SlowMark({ slowMs }: { slowMs: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TimerIcon className="size-3.5 shrink-0 text-warning" aria-label={`Slow: at least ${slowMs} ms`} />
      </TooltipTrigger>
      <TooltipContent>Slow: at least {slowMs} ms</TooltipContent>
    </Tooltip>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {error instanceof Error ? error.message : String(error)}
    </p>
  )
}

/** Label / value pairs in a card. */
export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-sm">
      {items.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 text-right tabular break-words">{v}</dd>
        </Fragment>
      ))}
    </dl>
  )
}
