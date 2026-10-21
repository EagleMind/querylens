// One statement's report, ordered for diagnosis: each card answers the question the one
// before it raises.
//   1. Verdict: is something wrong, and how bad? (and what this page can't show)
//   2. What's wrong, most serious first
//   3. How to fix it
//   4. Where in your code
//   5. The query
//   6. Its request, as an event log
//   7. This query over the last 24 hours
// What each card says is worked out in lib/report.ts; the cards are in components/report.
import { ArrowLeftIcon } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'

import type { IssueDetail } from '../../bindings/IssueDetail'
import type { Project } from '../../bindings/Project'
import type { SuggestionState } from '../../shared/api'
import { ErrorNote } from '@/components/common'
import { CodeCard, QueryCard } from '@/components/report/CodeAndQuery'
import { Fix } from '@/components/report/Fix'
import { History } from '@/components/report/History'
import { Problems } from '@/components/report/Problems'
import { RequestLog } from '@/components/report/RequestLog'
import { Verdict } from '@/components/report/Verdict'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError, api } from '@/lib/api'
import type { Muted } from '@/lib/muted'
import { type LiveQuery, type LiveRequest, queriesOf, withProject } from '@/lib/queries'
import { eventLog, missingParts, primaryFix, problemsOf, verdict } from '@/lib/report'
import { type QueryRef, href, onLinkClick } from '@/lib/router'
import { useAsync } from '@/lib/useAsync'

function BackLink() {
  return (
    <Button variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground" asChild>
      <a href={href({ page: 'live' })} onClick={onLinkClick}>
        <ArrowLeftIcon /> Live queries
      </a>
    </Button>
  )
}

function Missing({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-6">
      <BackLink />
      <div className="mx-auto grid max-w-lg gap-2 py-16 text-center text-sm">
        <p className="text-base font-medium">{title}</p>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </div>
  )
}

/** The request from the loaded history when it's there, from the API otherwise. */
function useRequest(at: QueryRef, loaded: LiveRequest[]) {
  const inMemory = loaded.find((r) => r.projectId === at.project && r.id === at.request)
  const fetched = useAsync(
    () => (inMemory ? Promise.resolve(inMemory) : api.request(at.project, at.request).then((r) => withProject(at.project, r))),
    [at.project, at.request],
  )
  return { request: inMemory ?? fetched.data, error: inMemory ? null : fetched.error }
}

/** Everything the report needs beyond the request: its issues, its code, its history, the AI state. */
function useReport(q: LiveQuery) {
  const projectId = q.request.projectId
  const ids = q.findings.map((f) => f.issueId)
  const issues = useAsync(
    () => Promise.all(ids.map((id) => api.issue(projectId, id).then((d): [number, IssueDetail] => [id, d]))).then((pairs) => new Map(pairs)),
    [projectId, ids.join(',')],
  )
  const origin = q.statement.origin
  const source = useAsync(() => (origin ? api.source(projectId, origin) : Promise.resolve(null)), [projectId, origin])
  const shape = useAsync(
    () => api.shape(projectId, { fingerprint: q.statement.fingerprint, environment: q.request.environment, hours: 24 }),
    [projectId, q.statement.fingerprint, q.request.environment],
  )
  const regressions = useAsync(() => api.regressions(projectId, q.request.environment), [projectId, q.request.environment])
  return { issues, source, shape, regressions }
}

function Report({ q, project, muted }: { q: LiveQuery; project: Project | undefined; muted: Muted }) {
  const { issues, source, shape, regressions } = useReport(q)
  const siblings = useMemo(() => queriesOf(q.request), [q.request])
  const details = issues.data ?? new Map<number, IssueDetail>()
  const settings = project?.settings
  const problems = problemsOf(q, siblings, details, settings)
  const log = useMemo(() => eventLog(q.request, siblings), [q.request, siblings])

  // The AI state of the issue whose fix is shown: it decides the fix card's actions, and
  // whether "AI-written changes" belongs in what the page can't show.
  const fixIssue = primaryFix(problems)?.finding?.issueId ?? null
  const loadedAi = useAsync(() => (fixIssue === null ? Promise.resolve(undefined) : api.suggestion(q.request.projectId, fixIssue)), [q.request.projectId, fixIssue])
  const [writtenAi, setWrittenAi] = useState<SuggestionState | undefined>()
  useEffect(() => setWrittenAi(undefined), [fixIssue])
  const ai = writtenAi ?? loadedAi.data

  const tables = shape.data?.tables
  const missing = missingParts(q, source.loading ? undefined : (source.data ?? null), ai)

  return (
    <div className="grid gap-4">
      <Verdict q={q} verdict={verdict(q, problems)} problems={problems} project={project} total={siblings.length} tables={tables} missing={missing} />
      <ErrorNote error={issues.error} />
      <Problems problems={problems} q={q} settings={settings} muted={muted} />
      <Fix problems={problems} q={q} ai={ai} onAi={setWrittenAi} />
      <CodeCard q={q} source={source.data} details={[...details.values()]} />
      <QueryCard q={q} tables={tables} />
      <RequestLog q={q} log={log} statements={siblings.length} />
      <History shape={shape.data} report={regressions.data?.[0]} fingerprint={q.statement.fingerprint} error={shape.error} />
    </div>
  )
}

export function QueryPage({ at, projects, requests, muted }: { at: QueryRef; projects: Project[]; requests: LiveRequest[]; muted: Muted }) {
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [at.project, at.request, at.seq])
  const { request, error } = useRequest(at, requests)

  if (error) {
    return error instanceof ApiError && error.status === 404 ? (
      <Missing title="This query is no longer in the history">
        QueryLens keeps each project’s requests for 7 days (the latest 20,000 at most).
      </Missing>
    ) : (
      <Missing title="The query couldn’t be loaded">
        <ErrorNote error={error} />
      </Missing>
    )
  }
  if (!request) {
    return (
      <div className="mx-auto grid w-full max-w-[60rem] gap-4">
        <BackLink />
        <Skeleton className="h-44" />
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    )
  }
  const q = queriesOf(request).find((x) => x.ref.seq === at.seq)
  if (!q) return <Missing title="No such query">This request has no statement #{at.seq}.</Missing>

  return (
    <div className="mx-auto grid w-full max-w-[60rem] gap-4">
      <BackLink />
      <Report key={q.id} q={q} project={projects.find((p) => p.id === q.request.projectId)} muted={muted} />
    </div>
  )
}
