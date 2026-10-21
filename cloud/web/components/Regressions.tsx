// Statements that got slower or started failing since the latest release, above the Live list.
// Quiet when there are none: it only takes room when there's something to look at.
import { ChevronDownIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { Project } from '../../bindings/Project'
import type { Regression, RegressionReport } from '../../shared/api'
import { ExportMenu } from '@/components/ExportMenu'
import { Sql } from '@/components/Sql'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { regressionsTable } from '@/lib/export/tables'
import { fmtCount, fmtMs, fmtRelative } from '@/lib/format'
import { href, onLinkClick } from '@/lib/router'
import { useAsync } from '@/lib/useAsync'
import { cn } from '@/lib/utils'

/** Statistics arrive every few minutes; this is often enough. */
const REFRESH_MS = 5 * 60_000
const OPEN_KEY = 'querylens.regressions.open'

function since(r: RegressionReport): string {
  return r.baseline.kind === 'release'
    ? `since release ${r.baseline.release}, deployed ${fmtRelative(r.baseline.since)}`
    : 'in the last 24 hours, compared with the week before'
}

function change(g: Regression): string {
  return g.regression === 'slower'
    ? `${fmtMs(g.before.meanMs)} → ${fmtMs(g.after.meanMs)}`
    : `${(g.before.errorRate * 100).toFixed(1)}% → ${(g.after.errorRate * 100).toFixed(1)}% failing`
}

function Row({ g, project }: { g: Regression; project: Project }) {
  const failing = g.regression === 'failing'
  const body = (
    <>
      <span className={cn('size-2 shrink-0 rounded-full', failing ? 'bg-destructive' : 'bg-warning')} aria-hidden />
      <span className="sr-only">{failing ? 'Started failing:' : 'Slower:'}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={g.sampleSql}>
        <Sql sql={g.sampleSql} />
      </span>
      <span className={cn('shrink-0 text-xs font-medium tabular', failing && 'text-destructive')}>{change(g)}</span>
      <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground tabular sm:inline">{fmtCount(g.after.calls)} calls</span>
    </>
  )
  const row = 'flex items-center gap-3 px-3 py-2'
  return g.latest ? (
    <a
      href={href({ page: 'query', project: project.id, request: g.latest.request, seq: g.latest.seq })}
      onClick={onLinkClick}
      className={cn(row, 'outline-none hover:bg-muted/50 focus-visible:bg-muted/50')}
    >
      {body}
    </a>
  ) : (
    <div className={row} title="No recent run of this statement is kept in the history">
      {body}
    </div>
  )
}

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

/** For the project, service (`backend`) and environment (each unless `null`) the Live page is showing. */
export function Regressions({ project, backend, environment }: { project: Project; backend: string | null; environment: string | null }) {
  const reports = useAsync(
    () =>
      api
        .regressions(project.id, { backend: backend ?? undefined, environment: environment ?? undefined })
        .then((all) => all.filter((r) => r.regressions.length > 0)),
    [project.id, backend, environment],
  )
  const { reload } = reports
  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS)
    return () => clearInterval(timer)
  }, [reload])
  const [open, setOpen] = useState(loadOpen)
  const toggle = () => {
    setOpen(!open)
    try {
      localStorage.setItem(OPEN_KEY, open ? '0' : '1')
    } catch {
      // Not remembered: fine.
    }
  }

  const found = reports.data ?? []
  if (found.length === 0) return null
  const all = found.flatMap((r) => r.regressions)
  const slower = all.filter((g) => g.regression === 'slower').length
  const failing = all.length - slower
  const summary = [
    slower ? `${slower} ${slower === 1 ? 'statement' : 'statements'} got slower` : null,
    failing ? `${failing} started failing` : null,
  ]
    .filter(Boolean)
    .join(' and ')

  return (
    <section aria-label="Regressions" className="overflow-hidden rounded-lg border border-warning/50 bg-warning/[0.05]">
      <div className="flex items-center justify-between gap-3 py-1.5 pr-1.5 pl-3">
        <p className="text-sm">
          <span className="font-medium">{summary}</span>
          <span className="text-muted-foreground">{found.length === 1 ? ` ${since(found[0])}` : ' since their latest release'}.</span>
        </p>
        <span className="flex shrink-0 items-center gap-1">
          <ExportMenu iconOnly count={all.length} name={[project.name, 'regressions']} table={() => regressionsTable(project, found)} />
          <Button variant="ghost" size="sm" onClick={toggle} aria-expanded={open}>
            {open ? 'Hide' : 'Show'}
            <ChevronDownIcon className={cn('transition-transform', open && 'rotate-180')} />
          </Button>
        </span>
      </div>
      {open && (
        <div className="divide-y border-t bg-card">
          {found.map((r) => (
            <div key={`${r.backend}:${r.environment}`}>
              {(found.length > 1 || (!backend && project.backends.length > 1)) && (
                <p className="bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                  {!backend && project.backends.length > 1 ? `${project.backends.find((b) => b.id === r.backend)?.name ?? 'Unknown service'}, ` : ''}
                  {r.environment}, {since(r)}
                </p>
              )}
              <div className="divide-y">
                {r.regressions.map((g) => (
                  <Row key={`${g.fingerprint}:${g.regression}`} g={g} project={project} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
