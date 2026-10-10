import { useQuery } from '@tanstack/react-query'
import { Loader2Icon } from 'lucide-react'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import type { SensitivityReport } from '@/bindings/SensitivityReport'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
      <h3 className="font-mono text-[12.5px]">
        <span className="text-signal">${r.param}</span>
        {r.column && <span className="text-muted-foreground"> · {r.column}</span>}
      </h3>
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
export function SensitivityDialog({
  analysis,
  open,
  onOpenChange,
}: {
  analysis: AnalysisResult
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const run = useQuery({
    queryKey: ['sensitivity', analysis.id],
    queryFn: () => api.sensitivity(analysis.id),
    enabled: open,
    retry: false,
    staleTime: Infinity,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] max-w-[min(640px,94vw)] overflow-y-auto sm:max-w-[min(640px,94vw)]">
        <DialogHeader>
          <DialogTitle>Does the plan depend on the value?</DialogTitle>
          <DialogDescription>
            Plans this statement with common, rare and absent values of each parameter, taken from the column
            statistics, plus the generic plan a prepared statement can reuse. Planner estimates only; nothing runs.
          </DialogDescription>
        </DialogHeader>
        {run.isPending && (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Planning with sample values…
          </p>
        )}
        {run.error && (
          <p className="text-[13px] text-destructive" data-selectable>
            {(run.error as Error).message}
          </p>
        )}
        {run.data?.length === 0 && (
          <p className="text-[13px] text-muted-foreground">
            None of the parameters compare against a column with statistics, so there are no sample values to try.
          </p>
        )}
        <div className="space-y-5">
          {run.data?.map((r) => (
            <Report key={r.param} r={r} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
