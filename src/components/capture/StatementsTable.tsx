import type { FingerprintStat } from '@/bindings/FingerprintStat'
import { fmtCount, fmtMs, fmtPct } from '@/lib/format'
import { cn } from '@/lib/utils'

const GRID = 'grid grid-cols-[96px_minmax(0,1fr)_64px_80px_80px_72px] items-center gap-4'

/** Every distinct statement of a capture, most total time first. */
export function StatementsTable({ stats, onOpen }: { stats: FingerprintStat[]; onOpen: (s: FingerprintStat) => void }) {
  return (
    <div>
      <div className={cn(GRID, 'border-b bg-panel px-4 py-2 text-[12px] font-semibold text-muted-foreground')}>
        <span>Share</span>
        <span>Statement</span>
        <span className="text-right">Calls</span>
        <span className="text-right">p95</span>
        <span className="text-right">Total</span>
        <span className="text-right">Rows/call</span>
      </div>
      {stats.map((s) => (
        <button
          key={s.fingerprint}
          type="button"
          onClick={() => onOpen(s)}
          title="Open in Workbench"
          className={cn(GRID, 'w-full border-b border-rule px-4 py-2.5 text-left hover:bg-accent/40')}
        >
          <div className="space-y-1">
            <div className="h-1.5 bg-rule">
              <div className="h-full bg-heat-high" style={{ width: `${Math.max(s.share * 100, 1)}%` }} />
            </div>
            <span className="font-mono text-[11px] text-muted-foreground tabular">{fmtPct(s.share)}</span>
          </div>
          <div className="min-w-0">
            <p className="line-clamp-2 font-mono text-[12px]/relaxed text-foreground/85">{s.normalized}</p>
            {s.origins[0] && (
              <p className="truncate font-mono text-[11px] text-muted-foreground">{s.origins[0].origin}</p>
            )}
          </div>
          <span className="text-right font-mono text-[12.5px] tabular">{fmtCount(s.calls)}</span>
          <span className="text-right font-mono text-[12.5px] tabular">{fmtMs(s.p95Ms)}</span>
          <span className="text-right font-mono text-[12.5px] tabular">{fmtMs(s.totalMs)}</span>
          <span className="text-right font-mono text-[12.5px] text-muted-foreground tabular">
            {fmtCount(s.rows / s.calls)}
          </span>
        </button>
      ))}
    </div>
  )
}
