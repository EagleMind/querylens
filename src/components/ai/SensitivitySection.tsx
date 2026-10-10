import { useMutation } from '@tanstack/react-query'
import { Loader2Icon, ShuffleIcon } from 'lucide-react'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import type { SensitivityReport } from '@/bindings/SensitivityReport'
import { Button } from '@/components/ui/button'
import { fmtCount, fmtPct } from '@/lib/format'
import { api } from '@/lib/ipc'
import { cn } from '@/lib/utils'

const SHAPE_SWATCH = ['bg-chart-2', 'bg-heat-medium', 'bg-chart-3', 'bg-heat-high', 'bg-signal']

function Report({ r }: { r: SensitivityReport }) {
  // Letter + swatch per distinct plan shape, in order of appearance.
  const shapes: string[] = []
  for (const row of r.rows) if (!shapes.includes(row.planFp)) shapes.push(row.planFp)
  return (
    <div className="space-y-2">
      <p
        className={cn('border-l-2 pl-3 text-[13px]/relaxed text-pretty', r.flips ? 'border-heat-medium' : 'border-ok')}
      >
        {r.summary}
      </p>
      <div className="rounded-[3px] border border-rule">
        {r.rows.map((row, i) => {
          const s = shapes.indexOf(row.planFp)
          return (
            <div
              key={i}
              className={cn(
                'grid grid-cols-[86px_minmax(0,1fr)_54px] items-center gap-2 px-2.5 py-1.5 text-[12px]',
                i > 0 && 'border-t border-rule',
                row.generic && 'bg-background/40',
              )}
            >
              <span className={cn('truncate', row.generic ? 'italic text-muted-foreground' : 'font-semibold')}>
                {row.label}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-mono text-[11.5px] text-foreground/85">
                  {row.generic ? 'any value' : (row.value ?? 'NULL')}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className={cn('size-2 shrink-0 rounded-[1px]', SHAPE_SWATCH[s % SHAPE_SWATCH.length])} />
                  <span className="font-mono">{String.fromCharCode(65 + s)}</span>
                  <span className="truncate">{row.shape}</span>
                </span>
              </span>
              <span className="text-right font-mono text-[11px] text-muted-foreground tabular">
                {row.frequency != null ? fmtPct(row.frequency) : row.cost != null ? fmtCount(row.cost) : '—'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Plan the statement with representative values for each $n and show plan flips. */
export function SensitivitySection({ analysis }: { analysis: AnalysisResult }) {
  const run = useMutation({ mutationFn: () => api.sensitivity(analysis.id) })
  if (!analysis.params?.length) return null
  return (
    <section className="space-y-3 border-t-2 border-foreground/80 pt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-[15px] font-semibold">Parameters</h3>
        <Button size="xs" variant="outline" className="ml-auto" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? <Loader2Icon className="animate-spin" /> : <ShuffleIcon />}
          {run.data ? 'Test again' : 'Test sensitivity'}
        </Button>
      </div>
      {!run.data && !run.isPending && (
        <p className="text-[12.5px]/relaxed text-muted-foreground">
          Plans this statement with common, rare and absent values of each parameter (from the column statistics), plus
          the generic plan a prepared statement reuses, to find plans that flip with the data. Estimates only, nothing
          runs.
        </p>
      )}
      {run.data?.map((r) => (
        <Report key={r.param} r={r} />
      ))}
    </section>
  )
}
