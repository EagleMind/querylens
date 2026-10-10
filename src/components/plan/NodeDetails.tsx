import type { PlanNode } from '@/bindings/PlanNode'
import { fmtCount, fmtMs } from '@/lib/format'
import { cn } from '@/lib/utils'

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] tracking-[0.12em] text-muted-foreground uppercase">{label}</div>
      <div className={cn('font-mono text-xs tabular', className)}>{value}</div>
    </div>
  )
}

const SEVERITY_BORDER = { error: 'border-heat-high/60', warning: 'border-heat-medium/60', info: 'border-sky-400/50' }

export function NodeDetails({ node, timed, indent }: { node: PlanNode; timed: boolean; indent: number }) {
  const b = node.buffers
  const hitRatio = b && b.sharedHit + b.sharedRead > 0 ? b.sharedHit / (b.sharedHit + b.sharedRead) : null

  return (
    <div
      className="animate-rise space-y-3 border-y border-border/60 bg-background/60 py-3 pr-4"
      style={{ paddingLeft: indent }}
      data-selectable
    >
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {timed && <Stat label="Inclusive" value={fmtMs(node.totalTimeMs)} />}
        {timed && <Stat label="Self" value={fmtMs(node.selfTimeMs)} />}
        {node.loops != null && <Stat label="Loops" value={fmtCount(node.loops)} />}
        <Stat label="Rows est." value={fmtCount(node.estimatedRows)} />
        {node.actualRows != null && <Stat label="Rows actual" value={fmtCount(node.actualRows)} />}
        {node.totalCost != null && (
          <Stat label="Cost" value={`${node.startupCost?.toFixed(1) ?? '0'} → ${node.totalCost.toFixed(1)}`} />
        )}
        {b && <Stat label="Buffers hit" value={fmtCount(b.sharedHit)} />}
        {b && (
          <Stat
            label="Buffers read"
            value={fmtCount(b.sharedRead)}
            className={b.sharedRead > 1000 ? 'text-heat-medium' : ''}
          />
        )}
        {hitRatio != null && <Stat label="Cache hit" value={`${(hitRatio * 100).toFixed(1)}%`} />}
        {b && b.tempWritten > 0 && (
          <Stat label="Temp written" value={fmtCount(b.tempWritten)} className="text-heat-medium" />
        )}
      </div>

      {node.warnings.length > 0 && (
        <div className="space-y-1.5">
          {node.warnings.map((w, i) => (
            <p key={i} className={cn('border-l-2 pl-2.5 text-xs/relaxed', SEVERITY_BORDER[w.severity])}>
              {w.message}
            </p>
          ))}
        </div>
      )}

      {node.properties.length > 0 && (
        <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-0.5 font-mono text-[11px]">
          {node.properties.map((p) => (
            <div key={p.key} className="contents">
              <dt className="text-muted-foreground">{p.key}</dt>
              <dd className="break-all text-foreground/85">{p.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
