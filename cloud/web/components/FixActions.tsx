// Getting an issue fixed from its card: the fix as a prompt for the user's coding agent, and a
// change to their own code written by Workers AI (when the SDK sends the code around it).
import { CheckIcon, ClipboardCopyIcon } from 'lucide-react'
import { useState } from 'react'

import type { SuggestionState } from '../../shared/api'
import { CodeChange } from '@/components/Code'
import { ErrorNote } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { fmtRelative } from '@/lib/format'
import { useAsync } from '@/lib/useAsync'

function CopyPromptButton({ projectId, issueId }: { projectId: string; issueId: number }) {
  // Loaded with the card, so the copy happens within the click (browsers require it).
  const prompt = useAsync(() => api.fixPrompt(projectId, issueId), [projectId, issueId])
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!prompt.data) return
    await navigator.clipboard?.writeText(prompt.data.prompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!prompt.data}
      onClick={copy}
      title="A brief with the issue, its code and the fix, to paste into Claude Code, Cursor or another coding agent"
    >
      {copied ? <CheckIcon /> : <ClipboardCopyIcon />}
      {copied ? 'Copied' : 'Copy fix prompt'}
    </Button>
  )
}

function SourceContextHint() {
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      To have the change written against your code, let the SDK send the lines around each query with{' '}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] whitespace-nowrap">QUERYLENS_SOURCE_CONTEXT=1</code>. Until
      then, paste the fix prompt into your coding agent.
    </p>
  )
}

function Suggestion({ projectId, issueId }: { projectId: string; issueId: number }) {
  const state = useAsync(() => api.suggestion(projectId, issueId), [projectId, issueId])
  const [written, setWritten] = useState<SuggestionState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const s = written ?? state.data

  const write = async (refresh: boolean) => {
    setBusy(true)
    setError(null)
    try {
      setWritten(await api.suggest(projectId, issueId, refresh))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  if (state.error) return <ErrorNote error={state.error} />
  if (!s) return <Skeleton className="h-8 w-48" />
  if (s.unavailable === 'ai_unavailable' || s.unavailable === 'no_origin') return null

  const canWrite = s.unavailable === null
  return (
    <div className="grid min-w-0 gap-3">
      {s.suggestion ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="font-medium">The change for your code</p>
            <span className="text-xs text-muted-foreground">
              Written by {s.suggestion.model.split('/').pop()} {fmtRelative(s.suggestion.createdAt)}
            </span>
          </div>
          <p className="leading-relaxed">{s.suggestion.summary}</p>
          <CodeChange file={s.suggestion.file} line={s.suggestion.line} before={s.suggestion.before} after={s.suggestion.after} />
          {s.suggestion.notes.length > 0 && (
            <ul className="grid list-disc gap-1 pl-5 leading-relaxed text-muted-foreground">
              {s.suggestion.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {s.stale && (
            <p className="flex items-center gap-2 text-sm">
              <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
              The issue or your code changed since this was written.
            </p>
          )}
          {canWrite && (
            <div>
              <Button variant={s.stale ? 'default' : 'ghost'} size="sm" disabled={busy} onClick={() => write(true)}>
                {busy ? 'Writing the change…' : 'Write it again'}
              </Button>
            </div>
          )}
        </>
      ) : canWrite ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={busy} onClick={() => write(false)}>
            {busy ? 'Writing the change…' : 'Write the change for my code'}
          </Button>
          <span className="text-xs text-muted-foreground">Workers AI applies the fix above to the code the SDK sent. Review it before using it.</span>
        </div>
      ) : (
        <SourceContextHint />
      )}
      <ErrorNote error={error} />
    </div>
  )
}

/** The bottom of an issue card: the prompt to copy, and the AI-written change. */
export function FixActions({ projectId, issueId }: { projectId: string; issueId: number }) {
  return (
    <div className="grid min-w-0 gap-4 border-t pt-4">
      <Suggestion projectId={projectId} issueId={issueId} />
      <div className="flex flex-wrap items-center gap-3">
        <CopyPromptButton projectId={projectId} issueId={issueId} />
        <span className="text-xs text-muted-foreground">For Claude Code, Cursor or any coding agent working in your repository.</span>
      </div>
    </div>
  )
}
