// Acting on a fix: the prompt for the user's coding agent, and a change to their own code
// written by Workers AI (when the SDK sends the code around the query). The page loads the
// suggestion state and passes it here, so it can also say when AI changes aren't available.
import { CheckIcon, ClipboardCopyIcon } from 'lucide-react'
import { useState } from 'react'

import type { SuggestionState } from '../../shared/api'
import { CodeChange } from '@/components/Code'
import { ErrorNote } from '@/components/common'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { fmtRelative } from '@/lib/format'
import { href, onLinkClick } from '@/lib/router'
import { useAsync } from '@/lib/useAsync'

export function CopyPromptButton({ projectId, issueId }: { projectId: string; issueId: number }) {
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
    <Button variant="outline" size="sm" disabled={!prompt.data} onClick={copy}>
      {copied ? <CheckIcon /> : <ClipboardCopyIcon />}
      {copied ? 'Copied' : 'Copy fix prompt'}
    </Button>
  )
}

/**
 * The actions under a fix, and the AI-written change once there is one. `state`: the
 * stored suggestion, `undefined` while loading; `onState`: a new one was written.
 */
export function FixActions({
  projectId,
  issueId,
  state,
  onState,
}: {
  projectId: string
  issueId: number
  state: SuggestionState | undefined
  onState: (s: SuggestionState) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const write = async (refresh: boolean) => {
    setBusy(true)
    setError(null)
    try {
      onState(await api.suggest(projectId, issueId, refresh))
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  const canWrite = state?.unavailable === null
  const suggestion = state?.suggestion ?? null
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {canWrite && (
          <Button size="sm" variant={suggestion && !state?.stale ? 'outline' : 'default'} disabled={busy} onClick={() => write(Boolean(suggestion))}>
            {busy ? 'Writing the change…' : suggestion ? 'Write it again' : 'Write the change for my code'}
          </Button>
        )}
        <CopyPromptButton projectId={projectId} issueId={issueId} />
        {state?.unavailable === 'needs_source' && (
          <span className="text-xs text-muted-foreground">
            AI changes need the code around the query.{' '}
            <a href={`${href({ page: 'docs' })}#source-context`} onClick={onLinkClick} className="font-medium text-primary hover:underline">
              Turn on source context
            </a>
          </span>
        )}
      </div>
      <ErrorNote error={error} />
      {suggestion && (
        <div className="grid min-w-0 gap-3 rounded-lg border bg-muted/20 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="text-sm font-medium">The change for your code</p>
            <span className="text-xs text-muted-foreground">
              Written by {suggestion.model.split('/').pop()} {fmtRelative(suggestion.createdAt)}. Review it before using it.
            </span>
          </div>
          <p className="text-sm leading-relaxed">{suggestion.summary}</p>
          <CodeChange file={suggestion.file} line={suggestion.line} before={suggestion.before} after={suggestion.after} />
          {suggestion.notes.length > 0 && (
            <ul className="grid list-disc gap-1 pl-5 text-sm leading-relaxed text-muted-foreground">
              {suggestion.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {state?.stale && (
            <p className="flex items-center gap-2 text-sm">
              <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
              The problem or your code changed since this was written.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
