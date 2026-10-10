import { useMemo } from 'react'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtMs, fmtPct } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

import { HEAT_BG, flatten, nodeLabel } from './heat'

const MIN_SEGMENT = 0.015
const TICKS = [0, 25, 50, 75, 100]

/**
 * "Where the time goes", drawn as a measuring ruler: one segment per operator sized by
 * its exclusive share, hottest first, with quarter ticks underneath.
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
    <div className="space-y-2">
      <div>
        <div className="flex h-3 w-full divide-x divide-background overflow-hidden rounded-[2px] bg-muted">
          {segments.map((n) => (
            <Tooltip key={n.id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => selectNode(n.id)}
                  className={cn(
                    'h-full transition-opacity hover:opacity-80',
                    HEAT_BG[n.heat],
                    selectedNodeId && selectedNodeId !== n.id && 'opacity-30',
                  )}
                  style={{ width: `${n.share * 100}%` }}
                />
              </TooltipTrigger>
              <TooltipContent className="font-mono text-xs">
                {nodeLabel(n)} · {timed ? fmtMs(n.selfTimeMs) : `cost ${Math.round(n.selfCost ?? 0)}`} ·{' '}
                {fmtPct(n.share)}
              </TooltipContent>
            </Tooltip>
          ))}
          {rest > 0 && <div className="h-full bg-muted-foreground/30" style={{ width: `${rest * 100}%` }} />}
        </div>
        <div className="relative mt-0.5 h-2">
          {TICKS.map((t) => (
            <span
              key={t}
              className="absolute top-0 h-1.5 w-px bg-foreground/25"
              style={{ left: `calc(${t}% - ${t === 100 ? 1 : 0}px)` }}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-4 overflow-hidden text-[12px] text-muted-foreground">
        {segments.slice(0, 3).map((n, i) => (
          <button
            key={n.id}
            type="button"
            onClick={() => selectNode(n.id)}
            className="flex min-w-0 items-center gap-1.5 hover:text-foreground"
          >
            <span className="font-mono text-[10.5px] text-foreground/40">{String(i + 1).padStart(2, '0')}</span>
            <span className={cn('size-2 shrink-0 rounded-[1px]', HEAT_BG[n.heat])} />
            <span className="truncate">{nodeLabel(n)}</span>
            <span className="font-mono text-foreground tabular">{fmtPct(n.share)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
