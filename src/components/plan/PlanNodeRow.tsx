import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  InfoIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { memo, useEffect, useRef } from 'react'

import type { PlanNode } from '@/bindings/PlanNode'
import type { PlanWarning } from '@/bindings/PlanWarning'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { estimateFactor, fmtCount, fmtMs, fmtPct } from '@/lib/format'
import { cn } from '@/lib/utils'

import { HEAT_BG } from './heat'
import { NodeDetails } from './NodeDetails'

export const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_116px_84px_120px] items-center gap-3'
const INDENT = 18

const SEVERITY_ICON = { error: CircleAlertIcon, warning: TriangleAlertIcon, info: InfoIcon }
const SEVERITY_COLOR = { error: 'text-heat-high', warning: 'text-heat-medium', info: 'text-chart-2' }

function worst(warnings: PlanWarning[]): PlanWarning['severity'] | null {
  if (warnings.some((w) => w.severity === 'error')) return 'error'
  if (warnings.some((w) => w.severity === 'warning')) return 'warning'
  return warnings.length ? 'info' : null
}

function Warnings({ warnings }: { warnings: PlanWarning[] }) {
  const sev = worst(warnings)
  if (!sev) return null
  const Icon = SEVERITY_ICON[sev]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex shrink-0 items-center gap-0.5', SEVERITY_COLOR[sev])}>
          <Icon className="size-3.5" />
          {warnings.length > 1 && <span className="font-mono text-[10px]">{warnings.length}</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm flex-col items-start gap-1.5 py-2">
        {warnings.map((w, i) => (
          <p key={i} className="text-xs/relaxed">
            <span className="text-[11px] font-semibold opacity-70">{w.kind.replaceAll('_', ' ')}</span>
            <br />
            {w.message}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

function Rows({ node }: { node: PlanNode }) {
  // Follow the backend's judgement (it knows e.g. that rows below a LIMIT stop early).
  const factor = estimateFactor(node.estimatedRows, node.actualRows)
  const off = factor != null && node.warnings.some((w) => w.kind === 'row_estimate_error')
  const under = (node.actualRows ?? 0) > (node.estimatedRows ?? 0)
  return (
    <div className="flex items-center justify-end gap-1.5 font-mono text-xs tabular">
      {off && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center rounded-[2px] border border-heat-medium/40 px-1 text-[10.5px] text-heat-medium">
              {under ? <ArrowUpIcon className="size-2.5" /> : <ArrowDownIcon className="size-2.5" />}
              {factor >= 1000 ? fmtCount(factor) : Math.round(factor)}×
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Planner {under ? 'under' : 'over'}estimated rows by {Math.round(factor).toLocaleString()}×
          </TooltipContent>
        </Tooltip>
      )}
      {node.actualRows != null ? (
        <span>
          {fmtCount(node.actualRows)}
          <span className="text-muted-foreground">/{fmtCount(node.estimatedRows)}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">~{fmtCount(node.estimatedRows)}</span>
      )}
    </div>
  )
}

interface RowProps {
  node: PlanNode
  depth: number
  timed: boolean
  collapsed: boolean
  selected: boolean
  onToggleCollapse: (id: string) => void
  onSelect: (id: string | null) => void
}

export const PlanNodeRow = memo(function PlanNodeRow({
  node,
  depth,
  timed,
  collapsed,
  selected,
  onToggleCollapse,
  onSelect,
}: RowProps) {
  const ref = useRef<HTMLDivElement>(null)
  const hasChildren = node.children.length > 0
  const hot = node.heat === 'high'

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected])

  return (
    <div
      ref={ref}
      className={cn(
        'group relative scroll-mt-9',
        selected &&
          'bg-accent/70 before:absolute before:inset-y-0 before:left-0 before:z-10 before:w-[3px] before:bg-signal',
      )}
    >
      <div
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren ? !collapsed : undefined}
        tabIndex={0}
        onClick={() => onSelect(selected ? null : node.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(selected ? null : node.id)
          }
        }}
        className={cn(
          ROW_GRID,
          'h-9 cursor-default border-b border-rule/50 pr-4 outline-none hover:bg-accent/40 focus-visible:bg-accent/50',
        )}
      >
        <div className="flex min-w-0 items-center" style={{ paddingLeft: 8 + depth * INDENT }}>
          {/* tree guides */}
          {depth > 0 && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-2"
              style={{
                width: depth * INDENT,
                backgroundImage: `repeating-linear-gradient(to right, transparent 0 ${INDENT / 2 + 3}px, var(--rule) ${INDENT / 2 + 3}px ${INDENT / 2 + 4}px, transparent ${INDENT / 2 + 4}px ${INDENT}px)`,
              }}
            />
          )}
          <button
            type="button"
            aria-label={collapsed ? 'Expand' : 'Collapse'}
            onClick={(e) => {
              e.stopPropagation()
              if (hasChildren) onToggleCollapse(node.id)
            }}
            className={cn(
              'mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground',
              !hasChildren && 'invisible',
            )}
          >
            <ChevronRightIcon className={cn('size-3.5 transition-transform', !collapsed && 'rotate-90')} />
          </button>
          <span className={cn('mr-2.5 size-2 shrink-0 rounded-[1px]', HEAT_BG[node.heat])} />
          <span className={cn('shrink-0 text-[13.5px] font-semibold', hot && 'text-heat-high')}>{node.nodeType}</span>
          {node.relation && (
            <span className="ml-1.5 shrink-0 font-mono text-[12.5px] text-foreground/85">
              <span className="text-muted-foreground">on </span>
              {node.relation}
              {node.alias && <span className="text-muted-foreground"> {node.alias}</span>}
            </span>
          )}
          {node.indexName && (
            <span className="ml-1.5 shrink-0 font-mono text-xs text-chart-2">
              <span className="text-muted-foreground">using </span>
              {node.indexName}
            </span>
          )}
          <span className="ml-2">
            <Warnings warnings={node.warnings} />
          </span>
          {node.detail && (
            <span
              className="ml-2.5 min-w-0 truncate font-mono text-[11.5px] text-muted-foreground italic"
              title={node.detail}
            >
              {node.detail}
            </span>
          )}
          {collapsed && hasChildren && (
            <span className="ml-2 shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
              +{node.children.length}
            </span>
          )}
        </div>

        <Rows node={node} />

        <div className="text-right font-mono text-[12.5px] tabular">
          {timed ? (
            <span className={cn(hot && 'text-heat-high', node.heat === 'medium' && 'text-heat-medium')}>
              {fmtMs(node.selfTimeMs)}
            </span>
          ) : (
            <span className="text-muted-foreground">{node.selfCost != null ? fmtCount(node.selfCost) : '—'}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden bg-rule">
            <div
              className={cn('h-full', HEAT_BG[node.heat])}
              style={{ width: `${Math.max(node.share * 100, node.share > 0 ? 2 : 0)}%` }}
            />
          </div>
          <span className="w-10 text-right font-mono text-[11px] text-muted-foreground tabular">
            {fmtPct(node.share)}
          </span>
        </div>
      </div>

      {selected && <NodeDetails node={node} timed={timed} indent={8 + depth * INDENT + 28} />}
    </div>
  )
})
