// One statement's report, ordered for diagnosis: each card answers the question the one
// before it raises. On wide screens it opens beside the Live list (QueryPanel: the verdict,
// then the other cards as tabs); on narrow ones, and from a link, as this page.
//   1. Verdict: is something wrong, and how bad? (and what this page can't show)
//   2. What's wrong, most serious first
//   3. How to fix it
//   4. Where in your code
//   5. The query
//   6. Its request, as an event log
//   7. This query over the last 24 hours
// What each card says is worked out in lib/report.ts; the cards are in components/report.
import { ArrowLeftIcon, XIcon } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'

import type { IssueDetail } from '../../bindings/IssueDetail'
import type { Project } from '../../bindings/Project'
import type { SuggestionState } from '../../shared/api'
import { ExportMenu } from '@/components/ExportMenu'
import { ErrorNote } from '@/components/common'
import { CodeCard, QueryCard } from '@/components/report/CodeAndQuery'
import { Fix } from '@/components/report/Fix'
import { History } from '@/components/report/History'
import { Problems } from '@/components/report/Problems'
import { ReportChrome } from '@/components/report/ReportCard'
import { RequestLog } from '@/components/report/RequestLog'
import { Verdict } from '@/components/report/Verdict'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiError, api } from '@/lib/api'
import { requestSql, requestTable } from '@/lib/export/tables'
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

/** The request a query ran in: its statements as a table, the whole request as JSON, or as SQL. */
function RequestExport({ project, request, iconOnly }: { project: Project | undefined; request: LiveRequest; iconOnly?: boolean }) {
  if (!project) return null
  const name = [project.name, request.name, `request ${request.id}`]
  return (
    <ExportMenu
      iconOnly={iconOnly}
      count={request.statements.length}
      name={name}
      table={() => requestTable(project, request)}
      extras={[
        {
          label: 'Full request (JSON)',
          extension: 'request.json',
          mime: 'application/json',
          write: () => {
            const { projectId: _p, key: _k, arrivedAt: _a, ...stored } = request
            return `${JSON.stringify(stored, null, 2)}\n`
          },
        },
        { label: 'SQL script', extension: 'sql', mime: 'application/sql', write: () => requestSql(project, request) },
      ]}
    />
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
  const { backend, environment } = q.request
  const source = useAsync(() => (origin ? api.source(projectId, backend, origin) : Promise.resolve(null)), [projectId, backend, origin])
  const shape = useAsync(
    () => api.shape(projectId, { backend, fingerprint: q.statement.fingerprint, environment, hours: 24 }),
    [projectId, backend, q.statement.fingerprint, environment],
  )
  const regressions = useAsync(() => api.regressions(projectId, { backend, environment }), [projectId, backend, environment])
  return { issues, source, shape, regressions }
}

/** Everything the report says about one query, loaded and worked out, with its cards. */
function useReportModel(q: LiveQuery, project: Project | undefined) {
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

  return {
    problems,
    settings,
    verdict: <Verdict q={q} verdict={verdict(q, problems)} problems={problems} project={project} total={siblings.length} tables={tables} missing={missing} />,
    issuesError: <ErrorNote error={issues.error} />,
    fix: <Fix problems={problems} q={q} ai={ai} onAi={setWrittenAi} />,
    code: <CodeCard q={q} source={source.data} details={[...details.values()]} />,
    query: <QueryCard q={q} tables={tables} />,
    request: <RequestLog q={q} log={log} statements={siblings.length} />,
    history: <History shape={shape.data} report={regressions.data?.[0]} fingerprint={q.statement.fingerprint} error={shape.error} />,
  }
}

function Report({ q, project, muted }: { q: LiveQuery; project: Project | undefined; muted: Muted }) {
  const m = useReportModel(q, project)
  return (
    <div className="@container grid gap-4">
      {m.verdict}
      {m.issuesError}
      <Problems problems={m.problems} q={q} settings={m.settings} muted={muted} />
      {m.fix}
      {m.code}
      {m.query}
      {m.request}
      {m.history}
    </div>
  )
}

type Tab = 'problems' | 'fix' | 'code' | 'request' | 'history'
const TAB_KEY = 'querylens.report.tab'

function loadTab(): Tab {
  try {
    return (localStorage.getItem(TAB_KEY) as Tab | null) ?? 'problems'
  } catch {
    return 'problems'
  }
}

/** The same report in the Live page's side panel: the verdict, then the other cards as tabs. */
function PanelReport({ q, project, muted }: { q: LiveQuery; project: Project | undefined; muted: Muted }) {
  const m = useReportModel(q, project)
  const [chosen, setChosen] = useState<Tab>(loadTab)
  const hasProblems = m.problems.length > 0
  const tabs: [Tab, string][] = [
    ...(hasProblems
      ? ([
          ['problems', m.problems.length === 1 ? 'Problem' : `Problems ${m.problems.length}`],
          ['fix', 'Fix'],
        ] as [Tab, string][])
      : []),
    ['code', 'Code'],
    ['request', 'Request'],
    ['history', 'History'],
  ]
  // The tab you last chose stays chosen from query to query; one this query lacks falls back to the first.
  const tab = tabs.some(([t]) => t === chosen) ? chosen : tabs[0][0]
  const choose = (t: string) => {
    setChosen(t as Tab)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      // Not remembered: fine.
    }
  }
  return (
    <ReportChrome value="plain">
      <div className="@container grid gap-5">
        {m.verdict}
        {m.issuesError}
        <Tabs value={tab} onValueChange={choose}>
          <TabsList>
            {tabs.map(([t, label]) => (
              <TabsTrigger key={t} value={t}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {hasProblems && (
            <>
              <TabsContent value="problems">
                <Problems problems={m.problems} q={q} settings={m.settings} muted={muted} />
              </TabsContent>
              <TabsContent value="fix">{m.fix}</TabsContent>
            </>
          )}
          <TabsContent value="code" className="grid gap-4">
            {m.code}
            {m.query}
          </TabsContent>
          <TabsContent value="request">{m.request}</TabsContent>
          <TabsContent value="history">{m.history}</TabsContent>
        </Tabs>
      </div>
    </ReportChrome>
  )
}

/** A selected query beside the Live list. Closing it goes back to the list alone. */
export function QueryPanel({ at, projects, requests, muted }: { at: QueryRef; projects: Project[]; requests: LiveRequest[]; muted: Muted }) {
  const { request, error } = useRequest(at, requests)
  const q = request ? queriesOf(request).find((x) => x.ref.seq === at.seq) : undefined
  let body
  if (error) {
    body =
      error instanceof ApiError && error.status === 404 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">This query is no longer in the history: requests are kept for 7 days.</p>
      ) : (
        <ErrorNote error={error} />
      )
  } else if (!request) {
    body = (
      <div className="grid gap-3">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-20" />
        <Skeleton className="h-40" />
      </div>
    )
  } else if (!q) body = <p className="py-10 text-center text-sm text-muted-foreground">This request has no statement #{at.seq}.</p>
  else body = <PanelReport key={q.id} q={q} project={projects.find((p) => p.id === q.request.projectId)} muted={muted} />
  body = <div className="px-5">{body}</div>

  return (
    <aside aria-label="Query report" className="grid content-start gap-4 pb-5">
      {/* The selected row's wash and brand bar, carried over: this is that row, opened. */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-card px-5 py-2.5 shadow-[inset_2px_0_0_var(--primary)] [background-image:linear-gradient(color-mix(in_oklab,var(--primary)_7%,transparent),color-mix(in_oklab,var(--primary)_7%,transparent))]">
        <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {q ? (
            <>
              <span className="text-foreground">{q.request.name}</span>
              {q.statement.origin && <span>, {q.statement.origin}</span>}
            </>
          ) : (
            'Query report'
          )}
        </p>
        <span className="flex shrink-0 items-center gap-1">
          {request && <RequestExport iconOnly project={projects.find((p) => p.id === request.projectId)} request={request} />}
          <Button variant="ghost" size="icon" className="-my-1 size-7 shrink-0" aria-label="Close the report" asChild>
            <a href={href({ page: 'live' })} onClick={onLinkClick}>
              <XIcon />
            </a>
          </Button>
        </span>
      </div>
      {body}
    </aside>
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
      <div className="flex items-center justify-between gap-2">
        <BackLink />
        <RequestExport project={projects.find((p) => p.id === request.projectId)} request={request} />
      </div>
      <Report key={q.id} q={q} project={projects.find((p) => p.id === q.request.projectId)} muted={muted} />
    </div>
  )
}
