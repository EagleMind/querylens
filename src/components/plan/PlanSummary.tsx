import { ShieldCheckIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import { CopyButton } from '@/components/shared/CopyButton'
import { ColorDot, EngineBadge } from '@/components/shared/bits'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtCount, fmtMs, fmtRelative } from '@/lib/format'
import { useConnections } from '@/lib/queries'
import { cn } from '@/lib/utils'

import { TimeShareBar } from './TimeShareBar'

function Metric({ label, value, unit, accent }: { label: string; value: ReactNode; unit?: string; accent?: string }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">{label}</div>
      <div className={cn('flex items-baseline gap-1 font-mono text-lg leading-tight font-medium tabular', accent)}>
        {value}
        {unit && <span className="text-xs font-normal text-muted-foreground">{unit}</span>}
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
  const color = connections?.find((c) => c.id === analysis.connectionId)?.color ?? '#64748b'
  const analyzed = analysis.mode === 'analyze'
  const [execValue, execUnit] = splitMs(analysis.executionTimeMs)
  const [planValue, planUnit] = splitMs(analysis.planningTimeMs)

  return (
    <div className="space-y-3 border-b bg-panel px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ColorDot color={color} />
        <span className="font-medium text-foreground">{analysis.connectionName}</span>
        <EngineBadge engine={analysis.engine} />
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'inline-flex h-4 items-center gap-1 rounded-[3px] px-1 font-mono text-[9px] font-medium tracking-wider',
                analyzed ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
              )}
            >
              {analyzed && <ShieldCheckIcon className="size-2.5" />}
              {analyzed ? 'ANALYZE · ROLLED BACK' : 'ESTIMATE'}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {analyzed
              ? 'The statement really executed, inside a transaction that was rolled back. Non-transactional side effects (sequences, dblink, NOTIFY) may still occur.'
              : 'Planner estimates only — the statement was not executed.'}
          </TooltipContent>
        </Tooltip>
        <span className="ml-auto flex items-center gap-2">
          {isReplay && (
            <span className="rounded-[3px] bg-muted px-1 font-mono text-[9px] tracking-wider">FROM HISTORY</span>
          )}
          <span>{fmtRelative(analysis.analyzedAt)}</span>
          <CopyButton value={analysis.rawPlan} label="Raw plan" variant="ghost" />
        </span>
      </div>

      <div className="grid grid-cols-5 gap-4">
        {analyzed ? (
          <Metric label="Execution" value={execValue} unit={execUnit} accent="text-primary" />
        ) : (
          <Metric label="Total cost" value={fmtCount(analysis.totalCost)} accent="text-primary" />
        )}
        <Metric label="Planning" value={planValue} unit={planUnit} />
        <Metric label={analyzed ? 'Est. cost' : 'Mode'} value={analyzed ? fmtCount(analysis.totalCost) : 'plan'} />
        <Metric label="Operators" value={analysis.nodeCount} />
        <Metric
          label="Warnings"
          value={analysis.warningsCount}
          accent={analysis.warningsCount > 0 ? 'text-heat-medium' : 'text-heat-low'}
        />
      </div>

      <TimeShareBar analysis={analysis} />
    </div>
  )
}
