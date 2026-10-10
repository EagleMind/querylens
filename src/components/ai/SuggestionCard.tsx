import { CheckIcon, CornerDownRightIcon } from 'lucide-react'

import type { PlanNode } from '@/bindings/PlanNode'
import type { SuggestionSeverity } from '@/bindings/SuggestionSeverity'
import { findNode, nodeLabel } from '@/components/plan/heat'
import { CopyButton } from '@/components/shared/CopyButton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DraftSuggestion } from '@/lib/suggestions'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

const SEVERITY: Record<SuggestionSeverity, { label: string; swatch: string; text: string }> = {
  high: { label: 'High impact', swatch: 'bg-heat-high', text: 'text-heat-high' },
  medium: { label: 'Medium impact', swatch: 'bg-heat-medium', text: 'text-heat-medium' },
  low: { label: 'Minor', swatch: 'bg-heat-low', text: 'text-muted-foreground' },
}

/** One entry in the advisor's report: numbered, ruled, no card chrome. */
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
        'grid grid-cols-[2.25rem_minmax(0,1fr)] border-t border-rule pt-3.5 animate-rise',
        active && 'border-signal',
      )}
    >
      <span
        className="font-display text-[22px] leading-none font-semibold text-foreground/35 tabular"
        style={{ fontStretch: '80%' }}
      >
        {String(index + 1).padStart(2, '0')}
      </span>

      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
          <span className={cn('inline-flex items-center gap-1.5 font-semibold', sev.text)}>
            <span className={cn('size-2 rounded-[1px]', sev.swatch)} />
            {sev.label}
          </span>
          {s.verified && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex cursor-default items-center gap-1 font-semibold text-ok">
                  <CheckIcon className="size-3" strokeWidth={3} /> Measured
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                This fix was tested with EXPLAIN against your database, inside a rolled-back transaction.
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        <h3 className="font-sans text-[14.5px]/snug font-semibold text-pretty">{s.title}</h3>

        {target && (
          <button
            type="button"
            onClick={() => selectNode(active ? null : target.id)}
            className={cn(
              'inline-flex max-w-full items-center gap-1 font-mono text-[11.5px] text-muted-foreground underline decoration-foreground/20 underline-offset-[3px] hover:text-foreground hover:decoration-signal',
              active && 'text-foreground decoration-signal',
            )}
          >
            <CornerDownRightIcon className="size-3 shrink-0" />
            <span className="truncate">{nodeLabel(target)}</span>
          </button>
        )}

        {s.explanation && (
          <p className="text-[13px]/relaxed text-pretty text-foreground/80" data-selectable>
            {s.explanation}
            {streaming && <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-signal align-middle" />}
          </p>
        )}

        {s.sqlFix && (
          <div className="group/fix relative rounded-[3px] bg-background">
            <pre
              className="max-h-56 overflow-auto px-3 py-2.5 pr-20 font-mono text-[12px]/relaxed whitespace-pre-wrap text-foreground/90"
              data-selectable
            >
              {s.sqlFix}
            </pre>
            {!streaming && (
              <CopyButton value={s.sqlFix} label="Copy" className="absolute top-1.5 right-1.5" variant="secondary" />
            )}
          </div>
        )}
      </div>
    </article>
  )
}
