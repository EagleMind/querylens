import { useQuery } from '@tanstack/react-query'
import { ArrowRightIcon, ChevronRightIcon, Loader2Icon } from 'lucide-react'
import { useState } from 'react'

import type { DiffNode } from '@/bindings/DiffNode'
import type { DiffSide } from '@/bindings/DiffSide'
import type { PlanDiff } from '@/bindings/PlanDiff'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fmtCount, fmtMs, fmtRelative } from '@/lib/format'
import { api } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'

import { HEAT_BG } from './heat'

const GRID = 'grid grid-cols-[minmax(0,1fr)_96px_96px_110px] items-center gap-3'
const INDENT = 18

function value(s: DiffSide | null, timed: boolean): number | null {
  if (!s) return null
  return timed ? s.selfTimeMs : s.selfCost
}

function fmt(v: number | null, timed: boolean) {
  if (v == null) return '—'
  return timed ? fmtMs(v) : fmtCount(v)
}

function Delta({ before, after, timed }: { before: number | null; after: number | null; timed: boolean }) {
  if (before == null && after == null) return <span className="text-muted-foreground">—</span>
  const d = (after ?? 0) - (before ?? 0)
  const rel = before ? d / before : null
  const noise = Math.abs(d) < (timed ? 0.05 : 0.5) || (rel != null && Math.abs(rel) < 0.05)
  return (
    <span className={cn('font-mono tabular', noise ? 'text-muted-foreground' : d < 0 ? 'text-ok' : 'text-heat-high')}>
      {noise ? '≈' : `${d < 0 ? '−' : '+'}${fmt(Math.abs(d), timed)}`}
    </span>
  )
}

function Label({ node }: { node: DiffNode }) {
  const b = node.before
  const a = node.after
  const name = (s: DiffSide) => (
    <>
      <span className="font-semibold">{s.nodeType}</span>
      {s.indexName && (
        <span className="ml-1 font-mono text-[12px] text-chart-2">
          <span className="text-muted-foreground">using </span>
          {s.indexName}
        </span>
      )}
    </>
  )
  return (
    <span className="flex min-w-0 items-center gap-1.5 truncate text-[13.5px]">
      {node.status === 'changed' && b && a ? (
        <>
          <span className="text-muted-foreground line-through decoration-foreground/30">{name(b)}</span>
          <ArrowRightIcon className="size-3 shrink-0 text-signal" />
          {name(a)}
        </>
      ) : (
        <span
          className={cn(node.status === 'removed' && 'text-muted-foreground line-through decoration-foreground/30')}
        >
          {name((a ?? b)!)}
        </span>
      )}
      {node.relation && (
        <span className="font-mono text-[12.5px] text-foreground/80">
          <span className="text-muted-foreground">on </span>
          {node.relation}
        </span>
      )}
      {node.status === 'added' && (
        <span className="rounded-[2px] border border-ok/50 px-1 text-[10.5px] font-semibold text-ok">new</span>
      )}
      {node.status === 'removed' && (
        <span className="rounded-[2px] border border-foreground/25 px-1 text-[10.5px] text-muted-foreground">gone</span>
      )}
    </span>
  )
}

function Rows({ node, depth, timed }: { node: DiffNode; depth: number; timed: boolean }) {
  const [open, setOpen] = useState(true)
  const side = node.after ?? node.before
  const before = value(node.before, timed)
  const after = value(node.after, timed)
  return (
    <>
      <div className={cn(GRID, 'h-9 border-b border-rule/50 pr-4')} style={{ paddingLeft: 8 + depth * INDENT }}>
        <div className="flex min-w-0 items-center">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className={cn(
              'mr-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground',
              node.children.length === 0 && 'invisible',
            )}
          >
            <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </button>
          {side && <span className={cn('mr-2.5 size-2 shrink-0 rounded-[1px]', HEAT_BG[side.heat])} />}
          <Label node={node} />
        </div>
        <span className="text-right font-mono text-[12.5px] text-muted-foreground tabular">{fmt(before, timed)}</span>
        <span className="text-right font-mono text-[12.5px] tabular">{fmt(after, timed)}</span>
        <span className="text-right text-[12.5px]">
          <Delta before={before} after={after} timed={timed} />
        </span>
      </div>
      {open && node.children.map((c, i) => <Rows key={i} node={c} depth={depth + 1} timed={timed} />)}
    </>
  )
}

function Headline({ d }: { d: PlanDiff }) {
  const before = d.timed ? d.beforeMs : d.beforeCost
  const after = d.timed ? d.afterMs : d.afterCost
  const ratio = before && after ? before / after : null
  const faster = ratio != null && ratio > 1
  const fmtV = (v: number | null) => (d.timed ? fmtMs(v) : `cost ${fmtCount(v)}`)
  return (
    <div className="flex items-end gap-6">
      <div>
        <div className="text-[11.5px] text-muted-foreground">Before</div>
        <div
          className="font-display text-[26px] font-semibold text-foreground/60 tabular"
          style={{ fontStretch: '85%' }}
        >
          {fmtV(before)}
        </div>
      </div>
      <ArrowRightIcon className="mb-3 size-5 text-signal" />
      <div>
        <div className="text-[11.5px] text-muted-foreground">After</div>
        <div className="font-display text-[26px] font-semibold tabular" style={{ fontStretch: '85%' }}>
          {fmtV(after)}
        </div>
      </div>
      {ratio != null && Math.abs(ratio - 1) >= 0.05 && (
        <div className={cn('mb-1.5 text-[15px] font-semibold', faster ? 'text-ok' : 'text-heat-high')}>
          {faster
            ? `${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)}× faster`
            : `${(1 / ratio).toFixed(1)}× slower`}
          {!d.timed && <span className="ml-1 font-normal text-muted-foreground">(estimated)</span>}
        </div>
      )}
      <span className="mb-2 ml-auto text-[12px] text-muted-foreground">
        {d.planChanged ? 'Plan shape changed' : 'Same plan shape'}
      </span>
    </div>
  )
}

export function CompareDialog() {
  const compare = useUi((s) => s.compare)
  const close = useUi((s) => s.closeCompare)
  const { data, isLoading, error } = useQuery({
    queryKey: ['compare', compare?.beforeId, compare?.afterId],
    queryFn: () => api.compare(compare!.beforeId, compare!.afterId),
    enabled: !!compare,
  })
  const sqlDiffers = data && data.beforeSql.trim() !== data.afterSql.trim()

  return (
    <Dialog open={!!compare} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex h-[86vh] max-w-[min(1100px,94vw)] flex-col gap-4 sm:max-w-[min(1100px,94vw)]">
        <DialogHeader>
          <DialogTitle>Compare plans</DialogTitle>
          <DialogDescription>
            {data
              ? `${fmtRelative(data.beforeLabel)} → ${fmtRelative(data.afterLabel)}. Self time per operator, before and after.`
              : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        {isLoading && <Loader2Icon className="mx-auto mt-10 size-5 animate-spin text-muted-foreground" />}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
        {data && (
          <>
            <Headline d={data} />
            {sqlDiffers && (
              <div className="grid grid-cols-2 gap-3">
                {[data.beforeSql, data.afterSql].map((sql, i) => (
                  <pre
                    key={i}
                    className="max-h-28 overflow-auto rounded-[3px] bg-background px-3 py-2 font-mono text-[11.5px]/relaxed whitespace-pre-wrap text-foreground/80"
                    data-selectable
                  >
                    {sql}
                  </pre>
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1 rounded-[3px] border border-rule">
              <div
                className={cn(GRID, 'h-8 border-b bg-panel pr-4 pl-4 text-[12px] font-semibold text-muted-foreground')}
              >
                <span>Operator</span>
                <span className="text-right">Before</span>
                <span className="text-right">After</span>
                <span className="text-right">Δ self {data.timed ? 'time' : 'cost'}</span>
              </div>
              <ScrollArea className="h-[calc(100%-2rem)]">
                <Rows node={data.root} depth={0} timed={data.timed} />
              </ScrollArea>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
