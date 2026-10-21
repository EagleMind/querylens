// Card 6: the request, as an event log. One line per event in the order it happened: when
// (from the start of the request), how long it took, what ran, and the rows, with the line of
// code and connection under it. Time in the app's code between queries is a line too. Runs of
// the same statement fold into one line, which opens into each run; this query is marked.
import { ChevronRightIcon } from 'lucide-react'

import { ReportCard } from '@/components/report/ReportCard'
import { Sql } from '@/components/Sql'
import { FINDING_KINDS, fmtCount, fmtExact, fmtMs } from '@/lib/format'
import { type LiveQuery, STORED_STATEMENT_LIMIT } from '@/lib/queries'
import { type EventLog, type LogLine } from '@/lib/report'
import { href, onLinkClick } from '@/lib/router'
import { cn } from '@/lib/utils'

const GRID = 'grid grid-cols-[4.5rem_4.5rem_minmax(0,1fr)_3.5rem] gap-x-3 px-5'

const offset = (ms: number) => `+${fmtMs(ms)}`

function Plain({ at, children, took }: { at: number; children: React.ReactNode; took?: number }) {
  return (
    <li className={cn(GRID, 'border-t py-1.5 text-xs text-muted-foreground')}>
      <span className="text-right font-mono tabular">{offset(at)}</span>
      <span className="text-right font-mono tabular">{took !== undefined ? fmtMs(took) : ''}</span>
      <span>{children}</span>
      <span />
    </li>
  )
}

function Run({ x, current }: { x: LiveQuery; current: boolean }) {
  const s = x.statement
  return (
    <a
      href={href({ page: 'query', ...x.ref })}
      onClick={onLinkClick}
      aria-current={current ? 'true' : undefined}
      className={cn(GRID, 'py-1 font-mono text-xs outline-none hover:bg-muted/50 focus-visible:bg-muted/50', current && 'font-semibold')}
    >
      <span className="text-right text-muted-foreground tabular">{offset(s.atMs)}</span>
      <span className="text-right tabular">{fmtMs(s.durationMs)}</span>
      <span className={cn('truncate', s.error && 'text-destructive')}>run {s.seq}{s.error ? `: ${s.error}` : ''}</span>
      <span className="text-right tabular">{fmtExact(s.rows)}</span>
    </a>
  )
}

function Statement({ line, current }: { line: Extract<LogLine, { type: 'statement' }>; current: LiveQuery }) {
  const first = line.runs[0]
  const s = first.statement
  const mine = line.runs.some((r) => r.id === current.id)
  const failed = line.runs.filter((r) => r.statement.error)
  const folded = line.runs.length > 1
  const meta = (
    <span className={cn('col-start-3 col-end-5 flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-[11px]', mine ? 'text-foreground/80' : 'text-muted-foreground')}>
      {mine && <span className="font-medium text-foreground">This query.</span>}
      <span className="font-mono">{s.origin ?? 'no line of your code'}</span>
      <span>connection #{s.conn}</span>
      {line.kinds.map((k) => (
        <span key={k} className="rounded border px-1.5 py-px font-medium">
          {FINDING_KINDS[k]}
        </span>
      ))}
      {failed.length > 0 && <span className="text-destructive">failed: {failed[0].statement.error}</span>}
    </span>
  )
  const row = (
    <>
      <span className="text-right text-muted-foreground tabular">{offset(line.at)}</span>
      <span className={cn('text-right tabular', mine && 'font-semibold')}>{fmtMs(line.durationMs)}</span>
      <span className={cn('min-w-0 truncate', failed.length && 'text-destructive')} title={s.sql}>
        <Sql sql={s.sql} plain={failed.length > 0} />
        {folded && <span className="ml-2 font-sans font-medium text-foreground">×{line.runs.length}</span>}
      </span>
      <span className="text-right tabular">{fmtExact(line.rows)}</span>
      {meta}
    </>
  )
  const tone = cn('border-t font-mono text-xs', mine && 'bg-primary/[0.07] shadow-[inset_3px_0_0_var(--primary)]')
  if (!folded) {
    return (
      <li className={tone}>
        <a href={href({ page: 'query', ...first.ref })} onClick={onLinkClick} className={cn(GRID, 'gap-y-0.5 py-2 outline-none hover:bg-muted/50 focus-visible:bg-muted/50')}>
          {row}
        </a>
      </li>
    )
  }
  return (
    <li className={tone}>
      <details className="group">
        <summary className={cn(GRID, 'relative cursor-pointer list-none gap-y-0.5 py-2 outline-none hover:bg-muted/50 focus-visible:bg-muted/50 [&::-webkit-details-marker]:hidden')}>
          <ChevronRightIcon className="absolute top-2.5 left-1.5 size-3 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
          {row}
        </summary>
        <div className="grid pb-2">
          {line.runs.map((r) => (
            <Run key={r.id} x={r} current={r.id === current.id} />
          ))}
        </div>
      </details>
    </li>
  )
}

export function RequestLog({ q, log, statements }: { q: LiveQuery; log: EventLog; statements: number }) {
  return (
    <ReportCard label={`Its request: ${q.request.name}`} className="[&>div:first-child]:pb-3">
      <p className="text-sm text-muted-foreground">
        {fmtMs(log.totalMs)} in total: {fmtMs(log.dbMs)} in the database ({fmtCount(statements)} {statements === 1 ? 'statement' : 'statements'} on{' '}
        {log.connections} {log.connections === 1 ? 'connection' : 'connections'}), {fmtMs(log.codeMs)} in your code.
      </p>
      <div className="-mx-5 overflow-x-auto">
        <div className="min-w-[36rem]">
          <div className={cn(GRID, 'pb-1.5 text-[11px] text-muted-foreground')}>
            <span className="text-right">When</span>
            <span className="text-right">Took</span>
            <span>Event</span>
            <span className="text-right">Rows</span>
          </div>
          <ol className="grid">
            {log.lines.map((line, i) =>
              line.type === 'start' ? (
                <Plain key={i} at={line.at}>
                  Request started
                </Plain>
              ) : line.type === 'end' ? (
                <Plain key={i} at={line.at}>
                  Response sent
                </Plain>
              ) : line.type === 'code' ? (
                <Plain key={i} at={line.at} took={line.durationMs}>
                  In your code
                </Plain>
              ) : (
                <Statement key={i} line={line} current={q} />
              ),
            )}
          </ol>
        </div>
      </div>
      {statements >= STORED_STATEMENT_LIMIT && (
        <p className="text-xs text-muted-foreground">QueryLens keeps the first {STORED_STATEMENT_LIMIT} statements of a request.</p>
      )}
    </ReportCard>
  )
}
