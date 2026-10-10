import type { ReactNode } from 'react'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import { CopyButton } from '@/components/shared/CopyButton'
import { ColorDot, EngineBadge } from '@/components/shared/bits'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtCount, fmtMs, fmtRelative } from '@/lib/format'
import { useConnections } from '@/lib/queries'
import { cn } from '@/lib/utils'

import { TimeShareBar } from './TimeShareBar'

function Metric({
  label,
  value,
  unit,
  className,
}: {
  label: string
  value: ReactNode
  unit?: string
  className?: string
}) {
  return (
    <div className="min-w-0 border-l border-rule pl-3 first:border-l-0 first:pl-0">
      <div className="text-[11.5px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          'flex items-baseline gap-1 font-display text-[26px] leading-tight font-semibold tabular',
          className,
        )}
        style={{ fontStretch: '85%' }}
      >
        {value}
        {unit && <span className="font-sans text-xs font-normal text-muted-foreground">{unit}</span>}
      </div>
    </div>
  )
}

function splitMs(ms: number | null): [string, string] {
  const s = fmtMs(ms)
  const i = s.lastIndexOf(' ')
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]
}

export function PlanSummary({ analysis, isReplay }: { analysis: AnalysisResult; isReplay: boolean }) {
  const { data: connections } = useConnections()
  const color = connections?.find((c) => c.id === analysis.connectionId)?.color ?? '#7c8aa5'
  const analyzed = analysis.mode === 'analyze'
  const [execValue, execUnit] = splitMs(analysis.executionTimeMs)
  const [planValue, planUnit] = splitMs(analysis.planningTimeMs)

  return (
    <div className="space-y-4 border-b bg-panel px-5 pt-3.5 pb-4">
      <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <ColorDot color={color} />
        <span className="font-semibold text-foreground">{analysis.connectionName}</span>
        <EngineBadge engine={analysis.engine} />
        <span className="text-foreground/25">/</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default border-b border-dotted border-muted-foreground/60">
              {analyzed ? 'executed, rolled back' : 'estimated, not executed'}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {analyzed
              ? 'The statement really ran, inside a transaction that was rolled back. Non-transactional side effects (sequences, dblink, NOTIFY) may still occur.'
              : 'Planner estimates only. The statement was not executed.'}
          </TooltipContent>
        </Tooltip>
        <span className="ml-auto flex items-center gap-3">
          {isReplay && <span className="italic">from history</span>}
          <span>{fmtRelative(analysis.analyzedAt)}</span>
          <CopyButton value={analysis.rawPlan} label="Raw plan" variant="ghost" />
        </span>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {analyzed ? (
          <Metric label="Execution" value={execValue} unit={execUnit} />
        ) : (
          <Metric label="Total cost" value={fmtCount(analysis.totalCost)} />
        )}
        <Metric label="Planning" value={planValue} unit={planUnit} />
        <Metric label={analyzed ? 'Est. cost' : 'Mode'} value={analyzed ? fmtCount(analysis.totalCost) : 'plan'} />
        <Metric label="Operators" value={analysis.nodeCount} />
        <Metric
          label="Findings"
          value={analysis.warningsCount}
          className={analysis.warningsCount > 0 ? 'text-heat-medium' : 'text-ok'}
        />
      </div>

      <TimeShareBar analysis={analysis} />
    </div>
  )
}
