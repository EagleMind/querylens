import { AlertCircleIcon, KeyRoundIcon, RotateCcwIcon, NotebookPenIcon, SquareIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'

import type { AnalysisResult } from '@/bindings/AnalysisResult'
import { EmptyState } from '@/components/shared/EmptyState'
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
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b px-4">
        <h2 className="font-display text-[16px] font-semibold" style={{ fontStretch: '90%' }}>
          Advisor
        </h2>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
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
        <div className="relative h-0.5 shrink-0 overflow-hidden bg-rule">
          <div className="absolute inset-y-0 w-1/5 animate-sweep bg-signal" />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          {!analysis && (
            <EmptyState icon={NotebookPenIcon} title="No review yet" className="py-16">
              Analyze a query, then ask the advisor to review the plan and propose fixes.
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
              Or switch to Claude Code or a local engine (LM Studio, Ollama).
            </EmptyState>
          )}

          {analysis && !missingKey && stream.status === 'idle' && !result && (
            <div className="border-t-2 border-foreground/80 pt-3 animate-rise">
              <h3 className="text-[17px] font-semibold">Review this plan</h3>
              <p className="mt-1.5 text-[13px]/relaxed text-muted-foreground">
                {analysis.warningsCount > 0
                  ? `${analysis.warningsCount} finding${analysis.warningsCount > 1 ? 's' : ''} flagged. `
                  : 'Nothing flagged by the built-in checks. '}
                {provider?.label} gets the normalized plan and schema context
                {providerKind === 'claude_code' && settings?.llm.verifyWithTools
                  ? ', and can test its fixes with EXPLAIN before recommending them.'
                  : '.'}
              </p>
              <Button className="mt-4" onClick={start}>
                <NotebookPenIcon /> Review plan
              </Button>
            </div>
          )}

          {stream.status !== 'idle' && stream.status !== 'error' && (
            <ActivityLog activities={stream.activities} live={streaming} />
          )}

          {stream.status === 'error' && (
            <div className="space-y-2 rounded-[3px] border border-destructive/40 p-3 animate-rise">
              <div className="flex items-center gap-2 text-xs font-medium text-destructive">
                <AlertCircleIcon className="size-3.5" /> The review didn't finish
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
                  index={i}
                  streaming={i === draft.suggestions.length - 1}
                />
              ))}
              {!draft.summary && draft.suggestions.length === 0 && (
                <div className="space-y-2">
                  <div className="h-2.5 w-3/4 animate-pulse bg-muted" />
                  <div className="h-2.5 w-1/2 animate-pulse bg-muted" />
                  <p className="pt-1 text-[12px] text-muted-foreground italic">
                    {stream.buffer.length > 0
                      ? `Receiving… ${stream.buffer.length.toLocaleString()} chars`
                      : 'Reading the plan…'}
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
                <SuggestionCard
                  key={i}
                  suggestion={s}
                  root={analysis.root}
                  index={i}
                  analysisId={analysis.id}
                  engine={analysis.engine}
                />
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
    <section className="animate-rise">
      <h3 className="text-[12px] font-semibold text-muted-foreground">Diagnosis</h3>
      <p className="mt-1.5 border-l-2 border-signal pl-3 text-[14px]/relaxed text-pretty" data-selectable>
        {text}
      </p>
    </section>
  )
}
