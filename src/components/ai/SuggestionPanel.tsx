import { AlertCircleIcon, KeyRoundIcon, RotateCcwIcon, SparklesIcon, SquareIcon, WandSparklesIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import { EmptyState } from '@/components/shared/EmptyState'
import { PaneLabel } from '@/components/shared/bits'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useSuggestionStream } from '@/hooks/useSuggestionStream'
import { PROVIDERS } from '@/lib/constants'
import { useSettings } from '@/lib/queries'
import { parseDraft } from '@/lib/suggestions'
import { useWorkspace } from '@/store/workspace'

import { ActivityLog } from './ActivityLog'
import { SuggestionCard } from './SuggestionCard'

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])
  return <span className="font-mono tabular">{((now - since) / 1000).toFixed(1)}s</span>
}

export function SuggestionPanel({ analysis }: { analysis: AnalysisResult | null }) {
  const stream = useWorkspace((s) => s.stream)
  const { data: settings } = useSettings()
  const { start, stop } = useSuggestionStream()
  const draft = useMemo(() => parseDraft(stream.buffer), [stream.buffer])

  const providerKind = settings?.llm.provider
  const provider = providerKind ? PROVIDERS[providerKind] : null
  const missingKey = !!provider?.needsKey && !settings?.llm.hasApiKey
  const result = analysis?.suggestions ?? null
  const streaming = stream.status === 'streaming'

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <SparklesIcon className="size-3.5 text-primary" />
        <PaneLabel className="text-foreground">AI suggestions</PaneLabel>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {streaming
            ? [stream.provider, stream.model].filter(Boolean).join(' · ')
            : result
              ? `${result.provider} · ${result.model}`
              : provider?.label}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {streaming ? (
            <>
              {stream.startedAt && (
                <span className="mr-1 text-[10px] text-muted-foreground">
                  <Elapsed since={stream.startedAt} />
                </span>
              )}
              <Button size="xs" variant="outline" onClick={stop}>
                <SquareIcon className="fill-current" /> Stop
              </Button>
            </>
          ) : (
            analysis &&
            (result || stream.status === 'error' || stream.status === 'cancelled') && (
              <Button size="xs" variant="ghost" onClick={start} disabled={missingKey}>
                <RotateCcwIcon /> Regenerate
              </Button>
            )
          )}
        </div>
      </div>

      {streaming && (
        <div className="relative h-px shrink-0 overflow-hidden bg-primary/10">
          <div className="absolute inset-y-0 w-1/4 animate-scan bg-linear-to-r from-transparent via-primary to-transparent" />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {!analysis && (
            <EmptyState icon={WandSparklesIcon} title="Suggestions appear here" className="py-16">
              Analyze a query, then ask the model to explain the plan and propose fixes.
            </EmptyState>
          )}

          {analysis && missingKey && !result && (
            <EmptyState
              icon={KeyRoundIcon}
              title={`${provider?.label} needs an API key`}
              className="py-12"
              action={
                <Button asChild size="sm" variant="outline">
                  <Link to="/settings">Open settings</Link>
                </Button>
              }
            >
              Or switch to Claude Code or a local model (LM Studio, Ollama).
            </EmptyState>
          )}

          {analysis && !missingKey && stream.status === 'idle' && !result && (
            <div className="relative overflow-hidden rounded-lg border bg-card p-4 animate-rise">
              <div className="pointer-events-none absolute -top-16 -right-16 size-40 rounded-full bg-primary/10 blur-3xl" />
              <p className="text-sm font-medium">Explain this plan and suggest fixes</p>
              <p className="mt-1 text-xs/relaxed text-muted-foreground">
                {analysis.warningsCount > 0
                  ? `${analysis.warningsCount} heuristic warning${analysis.warningsCount > 1 ? 's' : ''} found. `
                  : 'No heuristic warnings. '}
                {provider?.label} gets the normalized plan and schema context
                {providerKind === 'claude_code' && settings?.llm.verifyWithTools
                  ? ', and can test its fixes with EXPLAIN before recommending them.'
                  : '.'}
              </p>
              <Button size="sm" className="mt-3" onClick={start}>
                <SparklesIcon /> Get suggestions
              </Button>
            </div>
          )}

          {stream.status !== 'idle' && stream.status !== 'error' && (
            <ActivityLog activities={stream.activities} live={streaming} />
          )}

          {stream.status === 'error' && (
            <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 animate-rise">
              <div className="flex items-center gap-2 text-xs font-medium text-destructive">
                <AlertCircleIcon className="size-3.5" /> Suggestions failed
              </div>
              <p className="font-mono text-[11px]/relaxed whitespace-pre-wrap text-destructive/90" data-selectable>
                {stream.error}
              </p>
              <div className="flex gap-2">
                <Button size="xs" variant="outline" onClick={start}>
                  <RotateCcwIcon /> Try again
                </Button>
                <Button size="xs" variant="ghost" asChild>
                  <Link to="/settings">Settings</Link>
                </Button>
              </div>
            </div>
          )}

          {stream.status === 'cancelled' && !result && <p className="px-1 text-xs text-muted-foreground">Stopped.</p>}

          {/* Live draft while streaming */}
          {streaming && analysis && (
            <>
              {draft.summary && <Summary text={draft.summary} />}
              {draft.suggestions.map((s, i) => (
                <SuggestionCard
                  key={i}
                  suggestion={s}
                  root={analysis.root}
                  index={0}
                  streaming={i === draft.suggestions.length - 1}
                />
              ))}
              {!draft.summary && draft.suggestions.length === 0 && (
                <div className="space-y-2 px-1">
                  <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                  <p className="pt-1 text-[11px] text-muted-foreground">
                    {stream.buffer.length > 0
                      ? `Receiving… ${stream.buffer.length.toLocaleString()} chars`
                      : 'Waiting for the model…'}
                  </p>
                </div>
              )}
            </>
          )}

          {/* Final, persisted result */}
          {!streaming && result && analysis && (
            <>
              {result.summary && <Summary text={result.summary} />}
              {result.suggestions.map((s, i) => (
                <SuggestionCard key={i} suggestion={s} root={analysis.root} index={i} />
              ))}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function Summary({ text }: { text: string }) {
  return (
    <div className="rounded-lg bg-primary/[0.06] px-3 py-2.5 animate-rise">
      <PaneLabel className="text-primary/80">Bottleneck</PaneLabel>
      <p className="mt-1 text-[13px]/relaxed text-pretty" data-selectable>
        {text}
      </p>
    </div>
  )
}
