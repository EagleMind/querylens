import { AlertTriangleIcon, NetworkIcon, PlugZapIcon, TimerIcon } from 'lucide-react'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import { EmptyState } from '@/components/shared/EmptyState'
import { Kbd } from '@/components/shared/bits'
import { ScrollArea } from '@/components/ui/scroll-area'
import { modKey } from '@/hooks/useHotkey'
import type { IpcError } from '@/lib/ipc'
import { cn } from '@/lib/utils'

import { PlanSummary } from './PlanSummary'
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

function ErrorView({ error }: { error: IpcError }) {
  const isConn = error.kind === 'connection'
  const isTimeout = /timeout/i.test(error.message)
  const Icon = isConn ? PlugZapIcon : isTimeout ? TimerIcon : AlertTriangleIcon
  return (
    <div className="p-4">
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 animate-rise">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <Icon className="size-4" />
          {isConn
            ? 'Could not connect'
            : error.kind === 'validation'
              ? 'Check your query'
              : 'The database rejected the query'}
        </div>
        <pre className="mt-2 font-mono text-xs/relaxed whitespace-pre-wrap text-destructive/90" data-selectable>
          {error.message}
        </pre>
      </div>
    </div>
  )
}

export function PlanView({
  analysis,
  isReplay,
  running,
  error,
}: {
  analysis: AnalysisResult | null
  isReplay: boolean
  running: boolean
  error: IpcError | null
}) {
  if (running) return <Running />
  if (error) return <ErrorView error={error} />
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

  return (
    <div className={cn('flex h-full flex-col')}>
      <PlanSummary analysis={analysis} isReplay={isReplay} />
      <ScrollArea className="min-h-0 flex-1">
        <PlanTree
          key={analysis.id}
          root={analysis.root}
          timed={analysis.mode === 'analyze' && analysis.root.selfTimeMs != null}
        />
      </ScrollArea>
    </div>
  )
}
