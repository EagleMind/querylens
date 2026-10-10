import { BadgeCheckIcon, CrosshairIcon } from 'lucide-react'

import type { PlanNode } from '@/bindings/PlanNode'
import type { SuggestionSeverity } from '@/bindings/SuggestionSeverity'
import { findNode, nodeLabel } from '@/components/plan/heat'
import { CopyButton } from '@/components/shared/CopyButton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DraftSuggestion } from '@/lib/suggestions'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

const SEVERITY: Record<SuggestionSeverity, { label: string; stripe: string; pill: string }> = {
  high: { label: 'High impact', stripe: 'bg-heat-high', pill: 'bg-heat-high/12 text-heat-high' },
  medium: { label: 'Medium', stripe: 'bg-heat-medium', pill: 'bg-heat-medium/12 text-heat-medium' },
  low: { label: 'Low', stripe: 'bg-heat-low', pill: 'bg-heat-low/12 text-heat-low' },
}

export function SuggestionCard({
  suggestion: s,
  root,
  index,
  streaming,
}: {
  suggestion: DraftSuggestion
  root: PlanNode
  index: number
  streaming?: boolean
}) {
  const selectNode = useWorkspace((st) => st.selectNode)
  const selectedNodeId = useWorkspace((st) => st.selectedNodeId)
  const sev = SEVERITY[s.severity ?? 'medium']
  const target = s.nodeId ? findNode(root, s.nodeId) : null
  const active = !!target && selectedNodeId === target.id

  return (
    <article
      className={cn(
        'group relative overflow-hidden rounded-lg border bg-card animate-rise',
        active && 'border-primary/40 ring-1 ring-primary/20',
      )}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <span className={cn('absolute inset-y-0 left-0 w-[3px]', sev.stripe)} />
      <div className="space-y-2.5 py-3 pr-3 pl-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'rounded-[3px] px-1.5 py-px font-mono text-[9px] font-medium tracking-wider uppercase',
              sev.pill,
            )}
          >
            {sev.label}
          </span>
          {s.verified && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 rounded-[3px] bg-primary/12 px-1.5 py-px font-mono text-[9px] font-medium tracking-wider text-primary uppercase">
                  <BadgeCheckIcon className="size-3" /> Verified
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                The model measured this fix with EXPLAIN against your database (in a rolled-back transaction).
              </TooltipContent>
            </Tooltip>
          )}
          {target && (
            <button
              type="button"
              onClick={() => selectNode(active ? null : target.id)}
              className={cn(
                'ml-auto inline-flex max-w-[60%] items-center gap-1 rounded-[3px] border px-1.5 py-px font-mono text-[10px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground',
                active && 'border-primary/40 text-primary',
              )}
            >
              <CrosshairIcon className="size-3 shrink-0" />
              <span className="truncate">{nodeLabel(target)}</span>
            </button>
          )}
        </div>

        <h3 className="text-[13px]/snug font-medium text-pretty">{s.title}</h3>
        {s.explanation && (
          <p className="text-xs/relaxed text-pretty text-muted-foreground" data-selectable>
            {s.explanation}
            {streaming && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-primary/70 align-middle" />}
          </p>
        )}

        {s.sqlFix && (
          <div className="relative rounded-md border bg-background/70">
            <pre
              className="max-h-56 overflow-auto px-3 py-2.5 pr-20 font-mono text-[11.5px]/relaxed whitespace-pre-wrap text-foreground/90"
              data-selectable
            >
              {s.sqlFix}
            </pre>
            {!streaming && (
              <CopyButton
                value={s.sqlFix}
                label="Copy fix"
                className="absolute top-1.5 right-1.5"
                variant="secondary"
              />
            )}
          </div>
        )}
      </div>
    </article>
  )
}
