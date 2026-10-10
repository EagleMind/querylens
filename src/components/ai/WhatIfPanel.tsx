import {
  CheckIcon,
  GitCompareArrowsIcon,
  Loader2Icon,
  MinusIcon,
  RotateCcwIcon,
  SquareIcon,
  TestTubesIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import type { WhatIfOutcome } from '@/bindings/WhatIfOutcome'
import type { WhatIfResult } from '@/bindings/WhatIfResult'
import { CopyButton } from '@/components/shared/CopyButton'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useWhatIf } from '@/hooks/useWhatIf'
import { fmtCount, fmtMs } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'

import { SensitivitySection } from './SensitivitySection'

const OUTCOME: Record<WhatIfOutcome, { label: string; className: string }> = {
  faster: { label: 'Faster', className: 'text-ok' },
  slower: { label: 'Slower', className: 'text-heat-high' },
  similar: { label: 'Similar', className: 'text-foreground/70' },
  no_change: { label: 'Same plan', className: 'text-muted-foreground' },
  failed: { label: 'Failed', className: 'text-destructive' },
}

function value(v: number | null, timed: boolean) {
  return v == null ? '—' : timed ? fmtMs(v) : `cost ${fmtCount(v)}`
}

/** before → after as two bars on a shared scale. */
function Bars({ r }: { r: WhatIfResult }) {
  if (r.before == null || r.after == null || r.outcome === 'no_change') return null
  const max = Math.max(r.before, r.after) || 1
  return (
    <div className="space-y-0.5">
      <div className="h-1 bg-foreground/25" style={{ width: `${(r.before / max) * 100}%` }} />
      <div
        className={cn(
          'h-1',
          r.outcome === 'faster' ? 'bg-ok' : r.outcome === 'slower' ? 'bg-heat-high' : 'bg-foreground/50',
        )}
        style={{ width: `${Math.max((r.after / max) * 100, 1)}%` }}
      />
    </div>
  )
}

function ResultRow({ r, baselineId }: { r: WhatIfResult; baselineId: string }) {
  const openCompare = useUi((s) => s.openCompare)
  const o = OUTCOME[r.outcome]
  const factor =
    r.speedup && r.outcome !== 'no_change'
      ? r.speedup >= 1
        ? `${r.speedup >= 10 ? r.speedup.toFixed(0) : r.speedup.toFixed(1)}×`
        : `${(1 / r.speedup).toFixed(1)}× slower`
      : null
  return (
    <div className="space-y-2 border-t border-rule py-3 animate-rise">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 text-[13.5px] font-semibold">{r.scenario.label}</span>
        <span className={cn('shrink-0 text-[12px] font-semibold', o.className)}>
          {o.label}
          {factor && r.outcome === 'faster' && ` · ${factor}`}
        </span>
      </div>
      <Bars r={r} />
      {r.outcome !== 'no_change' && r.before != null && (
        <div className="font-mono text-[11.5px] text-muted-foreground tabular">
          {value(r.before, r.timed)} → <span className="text-foreground">{value(r.after, r.timed)}</span>
          {!r.timed && ' (estimated)'}
        </div>
      )}
      <p className="text-[12.5px]/relaxed text-foreground/80">{r.verdict}</p>
      <div className="flex items-center gap-1.5">
        {r.analysisId && (
          <Button size="xs" variant="outline" onClick={() => openCompare(baselineId, r.analysisId!)}>
            <GitCompareArrowsIcon /> Compare
          </Button>
        )}
        <CopyButton value={r.scenario.setup.map((s) => `${s};`).join('\n')} label="Copy SQL" variant="ghost" />
      </div>
    </div>
  )
}

function Pending({ label, state }: { label: string; state: 'waiting' | 'planning' | 'profiling' }) {
  return (
    <div className="flex items-center gap-2 border-t border-rule py-2.5 text-[13px]">
      {state === 'waiting' ? (
        <MinusIcon className="size-3.5 text-muted-foreground" />
      ) : (
        <Loader2Icon className="size-3.5 animate-spin text-signal" />
      )}
      <span className={state === 'waiting' ? 'text-muted-foreground' : 'font-semibold'}>{label}</span>
      {state !== 'waiting' && <span className="ml-auto text-[11.5px] text-muted-foreground italic">{state}…</span>}
    </div>
  )
}

export function WhatIfPanel({ analysis, tabs }: { analysis: AnalysisResult | null; tabs: ReactNode }) {
  const w = useWorkspace((s) => s.whatif)
  const { start, stop } = useWhatIf()
  const running = w.status === 'running'
  const supported = analysis?.engine === 'postgres'
  const done = new Set(w.results.map((r) => r.scenario.kind))

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b px-4">
        {tabs}
        <div className="ml-auto flex items-center gap-1">
          {running ? (
            <Button size="xs" variant="outline" onClick={stop}>
              <SquareIcon className="fill-current" /> Stop
            </Button>
          ) : (
            analysis &&
            supported &&
            w.status !== 'idle' && (
              <Button size="xs" variant="ghost" onClick={start}>
                <RotateCcwIcon /> Run again
              </Button>
            )
          )}
        </div>
      </div>
      {running && (
        <div className="relative h-0.5 shrink-0 overflow-hidden bg-rule">
          <div className="absolute inset-y-0 w-1/5 animate-sweep bg-signal" />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {!analysis && (
            <EmptyState icon={TestTubesIcon} title="No experiments yet" className="py-16">
              Profile a query, then re-plan it under alternative settings to find out why it's slow.
            </EmptyState>
          )}

          {analysis && !supported && (
            <EmptyState icon={TestTubesIcon} title="PostgreSQL only" className="py-16">
              What-if experiments change planner settings, which DuckDB doesn't expose.
            </EmptyState>
          )}

          {analysis && supported && w.status === 'idle' && (
            <div className="border-t-2 border-foreground/80 pt-3 animate-rise">
              <h3 className="text-[17px] font-semibold">Why is the planner choosing this?</h3>
              <p className="mt-1.5 text-[13px]/relaxed text-muted-foreground">
                Re-plans the query under alternative join methods, memory, cost model and statistics, each inside a
                rolled-back transaction. Only alternatives that change the plan are executed, with a time limit.
                {analysis.mode === 'estimate' && ' This plan was Explained, so results compare estimated cost.'}
              </p>
              <Button className="mt-4" onClick={start}>
                <TestTubesIcon /> Run experiments
              </Button>
            </div>
          )}

          {w.report && !running && (
            <section className="animate-rise">
              <h3 className="text-[12px] font-semibold text-muted-foreground">Diagnosis</h3>
              <p className="mt-1.5 border-l-2 border-signal pl-3 text-[14px]/relaxed text-pretty" data-selectable>
                {w.report.summary}
              </p>
            </section>
          )}

          {w.status === 'error' && (
            <p className="rounded-[3px] border border-destructive/40 p-3 font-mono text-[11.5px] text-destructive">
              {w.error}
            </p>
          )}

          {analysis && (w.results.length > 0 || running) && (
            <div>
              {[...w.results]
                .sort((a, b) => rank(a) - rank(b))
                .map((r) => (
                  <ResultRow key={r.scenario.kind} r={r} baselineId={analysis.id} />
                ))}
              {running &&
                w.scenarios
                  .filter((s) => !done.has(s.kind))
                  .map((s) => (
                    <Pending
                      key={s.kind}
                      label={s.label}
                      state={w.current?.kind === s.kind ? (w.current.phase as 'planning' | 'profiling') : 'waiting'}
                    />
                  ))}
            </div>
          )}

          {analysis && supported && !running && <SensitivitySection analysis={analysis} />}

          {w.status === 'done' && w.results.length === 0 && (
            <p className="text-[13px] text-muted-foreground">No experiments apply to this plan.</p>
          )}
          {w.status === 'cancelled' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <CheckIcon className="size-3" /> Stopped.
                </p>
              </TooltipTrigger>
              <TooltipContent>Finished experiments are kept above.</TooltipContent>
            </Tooltip>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

/** Faster first (biggest win on top), then similar/slower, then no-ops. */
function rank(r: WhatIfResult): number {
  const order: Record<WhatIfOutcome, number> = { faster: 0, similar: 1, slower: 2, no_change: 3, failed: 4 }
  return order[r.outcome] * 1000 - (r.speedup ?? 0)
}
