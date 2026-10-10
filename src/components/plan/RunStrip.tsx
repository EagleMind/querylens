import type { RunStats } from '@/bindings/RunStats'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtCount, fmtMs } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Every Profile run as a tick on a tiny min–max scale. The first run (usually reading
 * from disk) is a hollow ring; the median, which the plan shows, is filled signal.
 */
export function RunStrip({ stats }: { stats: RunStats }) {
  const { executionMs: runs, minMs, maxMs, medianMs } = stats
  const span = maxMs - minMs || 1
  const pos = (ms: number) => `${((ms - minMs) / span) * 100}%`
  const medianIdx = runs.indexOf(medianMs)
  const spread = medianMs > 0 ? (maxMs - minMs) / medianMs : 0
  const cacheEffect = stats.warmReadBlocks != null && stats.firstReadBlocks > stats.warmReadBlocks

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="mt-1.5 flex cursor-default items-center gap-2">
          <div className="relative h-2.5 w-24">
            <span className="absolute inset-x-0 top-1/2 h-px bg-foreground/20" />
            {runs.map((ms, i) => (
              <span
                key={i}
                className={cn(
                  'absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full',
                  i === 0 ? 'border border-heat-medium bg-background' : 'bg-foreground/45',
                  i === medianIdx && 'bg-signal',
                )}
                style={{ left: pos(ms) }}
              />
            ))}
          </div>
          <span className="text-[11px] text-muted-foreground tabular">
            {runs.length} runs{spread >= 0.05 ? ` · ±${Math.round((spread / 2) * 100)}%` : ''}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 flex-col items-start gap-1 py-2">
        <p className="font-semibold">
          Median {fmtMs(medianMs)} over {runs.length} runs
          {runs.length < stats.requested && ` (of ${stats.requested}, time budget reached)`}
        </p>
        <p className="opacity-80">
          First run {fmtMs(stats.firstMs)}
          {cacheEffect
            ? `, ${fmtCount(stats.firstReadBlocks)} blocks read from disk vs. ${fmtCount(stats.warmReadBlocks ?? 0)} once warm.`
            : '.'}{' '}
          Range {fmtMs(minMs)} – {fmtMs(maxMs)}.
        </p>
        <p className="opacity-80">The plan shown is the median run.</p>
      </TooltipContent>
    </Tooltip>
  )
}
