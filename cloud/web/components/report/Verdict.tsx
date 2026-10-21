// Card 1: is something wrong with this query, and how bad? The verdict, the four numbers it
// rests on (flagged when they're the problem), what the page can't show, and the run's details.
import { InfoIcon } from 'lucide-react'

import type { Project } from '../../../bindings/Project'
import { Figure, Pairs, ReportCard } from '@/components/report/ReportCard'
import { fmtDateTime, fmtExact, fmtMs, fmtRelative } from '@/lib/format'
import type { LiveQuery } from '@/lib/queries'
import { valuesSent } from '@/lib/queries'
import type { Missing, Problem, Verdict as VerdictInfo } from '@/lib/report'
import { href, onLinkClick } from '@/lib/router'
import { cn } from '@/lib/utils'

function NotShown({ missing }: { missing: Missing[] }) {
  if (missing.length === 0) return null
  return (
    <div className="grid gap-1.5 border-t pt-3 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <InfoIcon className="size-3.5 shrink-0" aria-hidden />
        Not shown here
      </p>
      <ul className="grid gap-1 pl-5">
        {missing.map((m) => (
          <li key={m.key} className="leading-relaxed text-muted-foreground">
            <span className="text-foreground">{m.what}</span>: {m.why}{' '}
            <a href={`${href({ page: 'docs' })}#${m.key}`} onClick={onLinkClick} className="font-medium whitespace-nowrap text-primary hover:underline">
              How to turn it on
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Verdict({
  q,
  verdict,
  problems,
  project,
  total,
  tables,
  missing,
}: {
  q: LiveQuery
  verdict: VerdictInfo
  problems: Problem[]
  project: Project | undefined
  /** Statements in its request. */
  total: number
  /** The tables (collections) it reads or writes, once known. */
  tables: string[] | undefined
  missing: Missing[]
}) {
  const s = q.statement
  const slowMs = project?.settings.slowMs
  const slow = slowMs !== undefined && s.durationMs >= slowMs
  const large = problems.some((p) => p.kind === 'large_result')
  const what = tables?.length ? `${q.verb} on ${tables.join(', ')}` : q.verb
  return (
    <ReportCard
      label="Verdict"
      panelLabel={false}
      tone={verdict.tone}
      details={
        <Pairs
          items={[
            ['Started', fmtDateTime(q.at)],
            ['Request', <span className="font-mono text-xs">{q.request.name}</span>],
            ['Project and environment', `${project?.name ?? 'Unknown project'}, ${q.request.environment}`],
            ['Release', q.request.release ? <span className="font-mono text-xs">{q.request.release}</span> : 'Not reported'],
            ['Connection', `#${s.conn}`],
            ['Values', valuesSent(s) ? 'Sent with the query' : 'Kept in your app (only a hash is sent)'],
          ]}
        />
      }
      detailsLabel="Details of this run"
    >
      <div className="grid gap-1">
        <p className="text-sm text-muted-foreground">
          <span className="font-mono text-[13px] text-foreground">{what}</span>, in <span className="font-mono text-[13px]">{q.request.name}</span>,{' '}
          {fmtRelative(new Date(q.at).toISOString())}
        </p>
        <h1 className={cn('text-xl font-semibold tracking-tight', verdict.tone === 'danger' && 'text-destructive')}>{verdict.title}</h1>
      </div>
      <div className="grid grid-cols-2 gap-2 @sm:grid-cols-4">
        <Figure
          label="Took"
          value={fmtMs(s.durationMs)}
          note={slowMs !== undefined ? `your limit: ${fmtMs(slowMs)}` : undefined}
          flag={slow ? 'warning' : undefined}
        />
        <Figure label="Rows" value={fmtExact(s.rows)} note={large ? 'no LIMIT' : q.type === 'select' ? 'returned' : 'written'} flag={large ? 'warning' : undefined} />
        <Figure label="Result" value={s.error ? 'Failed' : 'Succeeded'} note={s.error ? 'see the problem below' : 'no error'} flag={s.error ? 'danger' : undefined} />
        <Figure label="In its request" value={`${s.seq} of ${total}`} note="statements" />
      </div>
      <NotShown missing={missing} />
    </ReportCard>
  )
}
