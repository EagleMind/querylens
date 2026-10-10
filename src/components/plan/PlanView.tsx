import { AlertTriangleIcon, NetworkIcon, PlugZapIcon, TimerIcon } from 'lucide-react'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import { EmptyState } from '@/components/shared/EmptyState'
import { Kbd } from '@/components/shared/bits'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { modKey } from '@/hooks/useHotkey'
import type { IpcError } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

import { PlanSummary } from './PlanSummary'
import { IcicleView } from './IcicleView'
import { PlanTree } from './PlanTree'

function Running() {
  return (
    <div className="space-y-4 p-4">
      <div className="relative h-0.5 overflow-hidden bg-rule">
        <div className="absolute inset-y-0 w-1/4 animate-sweep bg-signal" />
      </div>
      <div className="grid grid-cols-5 gap-4">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-2 w-12 animate-pulse rounded bg-muted" />
            <div className="h-5 w-16 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-2" style={{ paddingLeft: i * 18 }}>
          <div className="h-5 w-[3px] rounded-full bg-muted" />
          <div className="h-3.5 animate-pulse rounded bg-muted" style={{ width: `${40 - i * 4}%` }} />
        </div>
      ))}
    </div>
  )
}

function ErrorView({ error, onExplain }: { error: IpcError; onExplain?: () => void }) {
  const isConn = error.kind === 'connection'
  const isTimeout = error.kind === 'timeout'
  const Icon = isConn ? PlugZapIcon : isTimeout ? TimerIcon : AlertTriangleIcon
  return (
    <div className="p-4">
      <div
        className={cn(
          'rounded-lg border p-4 animate-rise',
          isTimeout ? 'border-heat-medium/40 bg-heat-medium/5' : 'border-destructive/30 bg-destructive/5',
        )}
      >
        <div
          className={cn(
            'flex items-center gap-2 text-sm font-medium',
            isTimeout ? 'text-heat-medium' : 'text-destructive',
          )}
        >
          <Icon className="size-4" />
          {isConn
            ? 'Could not connect'
            : isTimeout
              ? 'Query timed out'
              : error.kind === 'validation'
                ? 'Check your query'
                : 'The database rejected the query'}
        </div>
        <p
          className={cn(
            'mt-2 text-[13px]/relaxed whitespace-pre-wrap',
            isTimeout ? 'text-foreground/85' : 'font-mono text-xs/relaxed text-destructive/90',
          )}
          data-selectable
        >
          {error.message}
        </p>
        {isTimeout && onExplain && (
          <Button size="sm" variant="outline" className="mt-3" onClick={onExplain}>
            Explain instead
          </Button>
        )}
      </div>
    </div>
  )
}

export function PlanView({
  analysis,
  isReplay,
  running,
  error,
  onExplain,
}: {
  analysis: AnalysisResult | null
  isReplay: boolean
  running: boolean
  error: IpcError | null
  /** Offered when a Profile times out. */
  onExplain?: () => void
}) {
  const view = useWorkspace((s) => s.planView)
  if (running) return <Running />
  if (error) return <ErrorView error={error} onExplain={onExplain} />
  if (!analysis) {
    return (
      <EmptyState icon={NetworkIcon} title="No plan yet" className="blueprint">
        Write a query above and press{' '}
        <span className="inline-flex gap-0.5 align-middle">
          <Kbd>{modKey}</Kbd>
          <Kbd>↵</Kbd>
        </span>
        . QueryLens runs EXPLAIN, colors each operator by its share of the time, and flags the usual suspects.
      </EmptyState>
    )
  }

  const timed = analysis.mode === 'analyze' && analysis.root.selfTimeMs != null
  return (
    <div className={cn('flex h-full flex-col')}>
      <PlanSummary analysis={analysis} isReplay={isReplay} />
      <ScrollArea className="min-h-0 flex-1">
        {view === 'icicle' ? (
          <IcicleView key={analysis.id} root={analysis.root} timed={timed} />
        ) : (
          <PlanTree key={analysis.id} root={analysis.root} timed={timed} />
        )}
      </ScrollArea>
    </div>
  )
}
