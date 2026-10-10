import { useMemo } from 'react'

import type { PlanNode } from '@/bindings/PlanNode'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtCount, fmtMs, fmtPct } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

import { NodeDetails } from './NodeDetails'
import { findNode, nodeLabel } from './heat'

const ROW = 28
const MIN_WIDTH = 0.002

interface Cell {
  node: PlanNode
  depth: number
  x: number
  w: number
}

/** Inclusive weight: time when profiled, else estimated cost. */
function weight(n: PlanNode, timed: boolean): number {
  const own = timed ? n.totalTimeMs : n.totalCost
  if (own != null && own > 0) return own
  return n.children.reduce((s, c) => s + weight(c, timed), 0) || 0
}

/**
 * Lay the tree out as nested spans: a node's width is its inclusive time; children sit
 * inside their parent, so the parent's visible remainder is its own (self) time.
 * Children are squeezed to fit when parallel workers or CTEs make them sum to more
 * than their parent.
 */
function layout(root: PlanNode, timed: boolean): Cell[] {
  const cells: Cell[] = []
  const place = (n: PlanNode, depth: number, x: number, w: number) => {
    cells.push({ node: n, depth, x, w })
    const parent = weight(n, timed)
    const weights = n.children.map((c) => weight(c, timed))
    const sum = weights.reduce((a, b) => a + b, 0)
    if (!sum || !parent) return
    const scale = sum > parent ? w / sum : w / parent
    let cx = x
    n.children.forEach((c, i) => {
      const cw = weights[i] * scale
      if (cw >= MIN_WIDTH) place(c, depth + 1, cx, cw)
      cx += cw
    })
  }
  place(root, 0, 0, 1)
  return cells
}

const FILL = {
  high: 'bg-heat-high text-background',
  medium: 'bg-heat-medium text-background',
  low: 'bg-heat-low/45 text-foreground',
} as const

export function IcicleView({ root, timed }: { root: PlanNode; timed: boolean }) {
  const selectedNodeId = useWorkspace((s) => s.selectedNodeId)
  const selectNode = useWorkspace((s) => s.selectNode)
  const cells = useMemo(() => layout(root, timed), [root, timed])
  const depth = Math.max(...cells.map((c) => c.depth)) + 1
  const selected = selectedNodeId ? findNode(root, selectedNodeId) : null

  return (
    <div className="space-y-3 p-4">
      <p className="text-[12px] text-muted-foreground">
        Width is {timed ? 'inclusive time' : 'estimated cost'}. What a block covers beyond its children is its own
        {timed ? ' (self) time' : ' cost'}. Click a block for details.
      </p>
      <div className="relative w-full" style={{ height: depth * ROW }}>
        {cells.map(({ node, depth: d, x, w }) => (
          <Tooltip key={node.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => selectNode(node.id === selectedNodeId ? null : node.id)}
                className={cn(
                  'absolute overflow-hidden rounded-[2px] border border-background px-1.5 text-left text-[11.5px] leading-[26px] font-semibold whitespace-nowrap transition-[filter] hover:brightness-110',
                  FILL[node.heat],
                  node.id === selectedNodeId && 'z-10 outline-2 outline-signal',
                  selectedNodeId && node.id !== selectedNodeId && 'opacity-60',
                )}
                style={{ left: `${x * 100}%`, width: `${w * 100}%`, top: d * ROW, height: ROW - 2 }}
              >
                {w > 0.06 && nodeLabel(node)}
              </button>
            </TooltipTrigger>
            <TooltipContent className="flex-col items-start gap-0.5 py-2 font-mono text-xs">
              <span className="font-sans font-semibold">{nodeLabel(node)}</span>
              <span>
                {timed
                  ? `inclusive ${fmtMs(node.totalTimeMs)} · self ${fmtMs(node.selfTimeMs)}`
                  : `cost ${fmtCount(node.totalCost)} · self ${fmtCount(node.selfCost)}`}{' '}
                · {fmtPct(node.share)} of total
              </span>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      {selected && (
        <div className="rounded-[3px] border border-rule">
          <div className="border-b border-rule px-4 py-2 text-[13px] font-semibold">{nodeLabel(selected)}</div>
          <NodeDetails node={selected} timed={timed} indent={16} />
        </div>
      )}
    </div>
  )
}
