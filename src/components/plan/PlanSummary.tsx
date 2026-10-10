import type { ReactNode } from 'react'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import { CopyButton } from '@/components/shared/CopyButton'
import { ColorDot, EngineBadge } from '@/components/shared/bits'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtBytes, fmtCount, fmtMs, fmtRelative } from '@/lib/format'
import { useConnections } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'

import { RunStrip } from './RunStrip'
import { TimeShareBar } from './TimeShareBar'

function Metric({
  label,
  value,
  unit,
  className,
  extra,
}: {
  label: string
  value: ReactNode
  unit?: string
  className?: string
  extra?: ReactNode
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
      {extra}
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
          <ViewSwitch />
          <CopyButton value={analysis.rawPlan} label="Raw plan" variant="ghost" />
        </span>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {analyzed ? (
          <Metric
            label={analysis.timing ? 'Execution · median' : 'Execution'}
            value={execValue}
            unit={execUnit}
            extra={analysis.timing && <RunStrip stats={analysis.timing} />}
          />
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

      <BaselineNote analysis={analysis} />
      <PlanFacts analysis={analysis} />
      <TimeShareBar analysis={analysis} />
    </div>
  )
}

/** Statement-level costs and settings that don't belong to any one operator. */
function PlanFacts({ analysis: a }: { analysis: AnalysisResult }) {
  const settings = a.plannerSettings ?? []
  const exec = a.executionTimeMs ?? 0
  // Only worth a chip when it is a noticeable share of the run.
  const jit = a.jitMs != null && a.jitMs > 0 ? a.jitMs : null
  const serialize = a.serializeMs != null && exec > 0 && a.serializeMs / exec >= 0.05 ? a.serializeMs : null
  if (jit == null && serialize == null && settings.length === 0) return null
  const fact = 'inline-flex items-center gap-1.5 rounded-[2px] border border-rule px-1.5 py-0.5'
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
      {jit != null && (
        <span className={fact}>
          JIT <span className="font-mono text-foreground tabular">{fmtMs(jit)}</span>
        </span>
      )}
      {serialize != null && (
        <span className={fact}>
          Sending results <span className="font-mono text-foreground tabular">{fmtMs(serialize)}</span>
          {a.serializeBytes != null && <span className="font-mono">· {fmtBytes(a.serializeBytes)}</span>}
        </span>
      )}
      {settings.map((p) => (
        <Tooltip key={p.key}>
          <TooltipTrigger asChild>
            <span className={cn(fact, 'cursor-default font-mono')}>
              {p.key} = <span className="text-foreground">{p.value}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Non-default planner setting in effect for this run</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

/** "Plan changed" / "1.8× slower than last run", with a one-click comparison. */
function BaselineNote({ analysis: a }: { analysis: AnalysisResult }) {
  const openCompare = useUi((s) => s.openCompare)
  const b = a.baseline
  if (!b) return null
  const ratio = b.timeRatio
  const slower = ratio != null && ratio >= 1.25
  const faster = ratio != null && ratio <= 0.8
  if (!b.planChanged && !slower && !faster) return null
  const parts: string[] = []
  if (b.planChanged) parts.push(`Plan changed since ${fmtRelative(b.previousAt)}`)
  if (slower) parts.push(`${ratio!.toFixed(1)}× slower than the last run`)
  if (faster) parts.push(`${(1 / ratio!).toFixed(1)}× faster than the last run`)
  return (
    <div
      className={cn(
        'flex items-center gap-3 border-l-2 py-1 pl-3 text-[12.5px]',
        slower ? 'border-heat-high' : faster ? 'border-ok' : 'border-heat-medium',
      )}
    >
      <span>{parts.join(' · ')}</span>
      <Button size="xs" variant="outline" onClick={() => openCompare(b.previousId, a.id)}>
        Compare
      </Button>
    </div>
  )
}

function ViewSwitch() {
  const view = useWorkspace((s) => s.planView)
  const setView = useWorkspace((s) => s.setPlanView)
  return (
    <span className="inline-flex rounded-[3px] border border-rule p-0.5 text-[11.5px]">
      {(['tree', 'icicle'] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          className={cn(
            'rounded-[2px] px-2 py-0.5 capitalize',
            view === v ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {v}
        </button>
      ))}
    </span>
  )
}
