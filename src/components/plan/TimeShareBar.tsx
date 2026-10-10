import { useMemo } from 'react'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtMs, fmtPct } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

import { HEAT_BG, flatten, nodeLabel } from './heat'

const MIN_SEGMENT = 0.015

/**
 * "Where the time goes": one stacked bar, a segment per operator sized by its
 * exclusive share. The hottest operator is unmissable before reading a single row.
 */
export function TimeShareBar({ analysis }: { analysis: AnalysisResult }) {
  const selectedNodeId = useWorkspace((s) => s.selectedNodeId)
  const selectNode = useWorkspace((s) => s.selectNode)
  const timed = analysis.mode === 'analyze'

  const { segments, rest } = useMemo(() => {
    const nodes = flatten(analysis.root).filter((n) => n.share > 0)
    const big = nodes.filter((n) => n.share >= MIN_SEGMENT).sort((a, b) => b.share - a.share)
    const rest = nodes.filter((n) => n.share < MIN_SEGMENT).reduce((acc, n) => acc + n.share, 0)
    return { segments: big, rest }
  }, [analysis])

  if (segments.length === 0) return null

  return (
    <div className="space-y-1.5">
      <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted/40">
        {segments.map((n, i) => (
          <Tooltip key={n.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => selectNode(n.id)}
                className={cn(
                  'h-full transition-[opacity,filter] hover:brightness-125 animate-rise',
                  HEAT_BG[n.heat],
                  selectedNodeId && selectedNodeId !== n.id && 'opacity-35',
                  n.heat === 'low' && 'opacity-60',
                )}
                style={{ width: `${n.share * 100}%`, animationDelay: `${i * 40}ms` }}
              />
            </TooltipTrigger>
            <TooltipContent className="font-mono text-xs">
              <span className="text-muted-foreground">{n.id}</span> {nodeLabel(n)} ·{' '}
              {timed ? fmtMs(n.selfTimeMs) : `cost ${Math.round(n.selfCost ?? 0)}`} · {fmtPct(n.share)}
            </TooltipContent>
          </Tooltip>
        ))}
        {rest > 0 && <div className="h-full bg-muted-foreground/25" style={{ width: `${rest * 100}%` }} />}
      </div>
      <div className="flex items-center gap-3 overflow-hidden font-mono text-[10px] text-muted-foreground">
        {segments.slice(0, 3).map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => selectNode(n.id)}
            className="flex min-w-0 items-center gap-1.5 hover:text-foreground"
          >
            <span className={cn('size-1.5 shrink-0 rounded-full', HEAT_BG[n.heat])} />
            <span className="truncate">{nodeLabel(n)}</span>
            <span className="text-foreground/80 tabular">{fmtPct(n.share)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
