import { CheckIcon, CornerDownRightIcon, Loader2Icon, PlayIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import type { PlanNode } from '@/bindings/PlanNode'
import type { SuggestionSeverity } from '@/bindings/SuggestionSeverity'
import { findNode, nodeLabel } from '@/components/plan/heat'
import { CopyButton } from '@/components/shared/CopyButton'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/ipc'
import type { DraftSuggestion } from '@/lib/suggestions'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'
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
  analysisId,
}: {
  suggestion: DraftSuggestion
  root: PlanNode
  index: number
  streaming?: boolean
  /** Enables "Preview fix" (re-run with the fix applied, then compare). */
  analysisId?: string
}) {
  const selectNode = useWorkspace((st) => st.selectNode)
  const selectedNodeId = useWorkspace((st) => st.selectedNodeId)
  const sev = SEVERITY[s.severity ?? 'medium']
  const target = s.nodeId ? findNode(root, s.nodeId) : null
  const active = !!target && selectedNodeId === target.id
  const evidence = s.evidence ?? (s.verified ? 'measured' : null)

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
          {evidence && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'inline-flex cursor-default items-center gap-1 font-semibold',
                    evidence === 'measured' ? 'text-ok' : 'text-chart-2',
                  )}
                >
                  <CheckIcon className="size-3" strokeWidth={3} /> {evidence === 'measured' ? 'Measured' : 'Estimated'}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {evidence === 'measured'
                  ? 'Tested against your database with real execution, inside a rolled-back transaction.'
                  : "Tested with the planner only (e.g. a hypothetical index): the estimate says it helps, but it wasn't executed."}
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
        {!streaming && s.sqlFix && analysisId && previewable(s.sqlFix) && (
          <PreviewFix analysisId={analysisId} fix={s.sqlFix} />
        )}
      </div>
    </article>
  )
}

/** Fixes QueryLens can apply inside a rolled-back transaction to measure them. */
function previewable(fix: string): boolean {
  return /^\s*(create\s+(unique\s+)?index|create\s+statistics|set\s|analy[sz]e|select|with)/i.test(fix)
}

function PreviewFix({ analysisId, fix }: { analysisId: string; fix: string }) {
  const openCompare = useUi((st) => st.openCompare)
  const [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    try {
      const after = await api.previewFix(analysisId, fix)
      openCompare(analysisId, after.id)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="xs" variant="outline" onClick={run} disabled={busy}>
          {busy ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
          {busy ? 'Applying in a rolled-back transaction…' : 'Preview fix'}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        Re-runs the query with this fix applied inside a transaction that is rolled back, then compares the plans. Large
        tables use a hypothetical index (estimate) when HypoPG is installed.
      </TooltipContent>
    </Tooltip>
  )
}
