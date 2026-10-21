// Card 2: what's wrong, most serious first. Each problem is one plain sentence; opening it
// shows the evidence: what QueryLens saw, why that counts as a problem, how often and since
// when, what it cost, and muting it.
import { BellIcon, BellOffIcon, ChevronRightIcon } from 'lucide-react'
import { useState } from 'react'

import type { ProjectSettings } from '../../../bindings/ProjectSettings'
import { CodeBlock, ErrorNote, Prose } from '@/components/common'
import { Pairs, ReportCard } from '@/components/report/ReportCard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FINDING_KINDS, SEVERITY, fmtCount, fmtMs, fmtRelative } from '@/lib/format'
import type { Muted } from '@/lib/muted'
import type { LiveQuery } from '@/lib/queries'
import { type Problem, whyFlagged } from '@/lib/report'
import { cn } from '@/lib/utils'

function MuteButton({ projectId, issueId, muted }: { projectId: string; issueId: number; muted: Muted }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const isMuted = muted.isMuted(projectId, issueId)
  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      await muted.setMuted(projectId, issueId, !isMuted)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" size="sm" disabled={busy} onClick={toggle}>
        {isMuted ? <BellIcon /> : <BellOffIcon />}
        {isMuted ? 'Unmute this problem' : 'Mute this problem'}
      </Button>
      <span className="text-xs text-muted-foreground">
        {isMuted ? 'Muted: still counted, hidden from Live.' : 'Keeps counting it, but hides it from Live.'}
      </span>
      <ErrorNote error={error} />
    </div>
  )
}

function Evidence({ p, q, settings, muted }: { p: Problem; q: LiveQuery; settings: ProjectSettings | undefined; muted: Muted }) {
  const d = p.detail
  const issue = d?.issue
  const releases =
    issue?.firstRelease && issue.lastRelease
      ? issue.firstRelease === issue.lastRelease
        ? `${issue.firstRelease} only`
        : `first in ${issue.firstRelease}, still in ${issue.lastRelease}`
      : null
  return (
    <div className="grid gap-4 pt-1 pb-1 pl-6 text-sm">
      {p.kind === 'query_errors' && q.statement.error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs break-words">{q.statement.error}</p>
      ) : (
        issue && (
          <p className="leading-relaxed text-muted-foreground">
            <Prose text={issue.detail} />
          </p>
        )
      )}
      {d?.parentSql && (
        <div className="grid gap-1.5">
          <p className="text-muted-foreground">It runs once per row returned by:</p>
          <CodeBlock code={d.parentSql} sql />
        </div>
      )}
      <Pairs
        items={[
          ['Problem', `${FINDING_KINDS[p.kind]}, ${SEVERITY[p.severity].label.toLowerCase()} severity`],
          ['Why it’s flagged', whyFlagged(p.kind, settings)],
          ...(issue
            ? ([
                ['Seen', `${fmtCount(issue.timesSeen)} ${issue.timesSeen === 1 ? 'request' : 'requests'}, first ${fmtRelative(issue.firstSeen)}, last ${fmtRelative(issue.lastSeen)}`],
                ['Time it cost', `${fmtMs(issue.impactMs)} of database time, all requests together`],
              ] as [string, string][])
            : []),
          ...(releases ? ([['Releases', releases]] as [string, string][]) : []),
          ...(issue?.regressed ? ([['Status', 'Came back after it was marked resolved']] as [string, string][]) : []),
        ]}
      />
      {p.finding && <MuteButton projectId={q.request.projectId} issueId={p.finding.issueId} muted={muted} />}
    </div>
  )
}

export function Problems({ problems, q, settings, muted }: { problems: Problem[]; q: LiveQuery; settings: ProjectSettings | undefined; muted: Muted }) {
  if (problems.length === 0) return null
  return (
    <ReportCard label={problems.length === 1 ? 'What’s wrong' : 'What’s wrong, most serious first'} className="[&>div:first-child]:pb-2">
      <ul className="-mx-5 grid">
        {problems.map((p, i) => {
          const isMuted = p.finding ? muted.isMuted(q.request.projectId, p.finding.issueId) : false
          return (
            <li key={p.key} className={cn(i > 0 && 'border-t')}>
              <details open={i === 0} className="group">
                <summary className="flex cursor-pointer list-none items-start gap-2.5 px-5 py-3 outline-none hover:bg-muted/40 focus-visible:bg-muted/40 [&::-webkit-details-marker]:hidden">
                  <ChevronRightIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
                  <span className={cn('mt-[7px] size-2 shrink-0 rounded-full', SEVERITY[p.severity].dot)} aria-hidden />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="font-medium">{p.headline}</span>
                    <span className="text-xs text-muted-foreground">
                      {FINDING_KINDS[p.kind]}, {SEVERITY[p.severity].label.toLowerCase()}
                      {p.causedBy && <>. Likely caused by “{p.causedBy.headline.toLowerCase()}”: the fix below covers both.</>}
                    </span>
                  </span>
                  {isMuted && (
                    <Badge variant="secondary" className="shrink-0">
                      <BellOffIcon /> Muted
                    </Badge>
                  )}
                </summary>
                <div className="px-5 pb-4">
                  <Evidence p={p} q={q} settings={settings} muted={muted} />
                </div>
              </details>
            </li>
          )
        })}
      </ul>
    </ReportCard>
  )
}
