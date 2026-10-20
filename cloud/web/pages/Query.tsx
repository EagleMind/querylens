import { ArrowLeftIcon, BellIcon, BellOffIcon, FileCode2Icon } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import type { LiveFinding } from '../../bindings/LiveFinding'
import type { Project } from '../../bindings/Project'
import { ACTION_FILL, CodeBlock, CopyButton, ErrorNote, Facts, Prose, SeverityDot, SlowMark, StatementTypeLabel } from '@/components/common'
import { Sql } from '@/components/Sql'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '@/lib/api'
import { FINDING_KINDS, ORMS, SEVERITY, fmtCount, fmtDateTime, fmtMs, fmtRelative } from '@/lib/format'
import {
  type LiveQuery,
  type LiveRequest,
  STATEMENT_ACTION,
  STATEMENT_TYPES,
  STORED_STATEMENT_LIMIT,
  queriesOf,
  valuesSent,
  withProject,
} from '@/lib/queries'
import { ApiError } from '@/lib/api'
import { type QueryRef, href, navigate, onLinkClick } from '@/lib/router'
import type { Muted } from '@/lib/muted'
import { useAsync } from '@/lib/useAsync'
import { cn } from '@/lib/utils'

function BackLink() {
  return (
    <Button variant="ghost" size="sm" className="-ml-2 w-fit text-muted-foreground" asChild>
      <a href={href({ page: 'live' })} onClick={onLinkClick}>
        <ArrowLeftIcon /> Live queries
      </a>
    </Button>
  )
}

function CalledFrom({ q, project }: { q: LiveQuery; project: Project | undefined }) {
  const origin = q.statement.origin
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Called from</CardTitle>
        <CardDescription>The first line of your code on the stack when the query ran.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {origin ? (
          <div className="flex items-center gap-2 rounded-md border border-primary/25 bg-primary/[0.06] py-1 pr-1 pl-3">
            <FileCode2Icon className="size-4 shrink-0 text-primary" aria-hidden />
            <code className="min-w-0 flex-1 truncate font-mono text-sm font-medium" title={origin}>
              {origin}
            </code>
            <CopyButton value={origin} label="Copy location" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No line of your code was on the stack: the query ran from a library, a scheduled callback or outside the
            project directory.
          </p>
        )}
        <Facts
          items={[
            ['Request', <span className="font-mono text-xs">{q.request.name}</span>],
            ['Project', project?.name ?? 'Unknown'],
            ['Environment', q.request.environment],
            ['Release', q.request.release ?? '—'],
            ['Connection', `#${q.statement.conn}`],
          ]}
        />
      </CardContent>
    </Card>
  )
}

function Execution({ q, project, total }: { q: LiveQuery; project: Project | undefined; total: number }) {
  const s = q.statement
  const slowMs = project?.settings.slowMs
  const slow = slowMs !== undefined && s.durationMs >= slowMs
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Execution</CardTitle>
      </CardHeader>
      <CardContent>
        <Facts
          items={[
            ['Started', fmtDateTime(q.at)],
            ['Into the request', `+${fmtMs(s.atMs)}`],
            [
              'Duration',
              <span className="inline-flex flex-col items-end">
                <span className={cn('inline-flex items-center gap-1.5', slow && 'font-medium')}>
                  {slow && <SlowMark slowMs={slowMs} />}
                  {fmtMs(s.durationMs)}
                </span>
                {slow && <span className="text-xs font-normal text-muted-foreground">slow: at least {fmtMs(slowMs)}</span>}
              </span>,
            ],
            ['Rows', fmtCount(s.rows)],
            ['Position', `${s.seq} of ${total} statements`],
          ]}
        />
      </CardContent>
    </Card>
  )
}

function LastDay({ q }: { q: LiveQuery }) {
  const shape = useAsync(
    () => api.shape(q.request.projectId, { fingerprint: q.statement.fingerprint, environment: q.request.environment, hours: 24 }),
    [q.request.projectId, q.statement.fingerprint, q.request.environment],
  )
  const s = shape.data
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>Last 24 hours</CardTitle>
        <CardDescription>
          Every run of this statement in {q.request.environment}, from the SDK’s per-minute statistics.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {shape.error ? (
          <ErrorNote error={shape.error} />
        ) : shape.loading && s === undefined ? (
          <div className="grid gap-2.5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-4" />
            ))}
          </div>
        ) : s ? (
          <Facts
            items={[
              ['Runs', fmtCount(s.calls)],
              ['Total time', fmtMs(s.totalMs)],
              ['Average', fmtMs(s.meanMs)],
              ['Slowest', fmtMs(s.maxMs)],
              ['Failed', <span className={cn(s.errors > 0 && 'text-destructive')}>{fmtCount(s.errors)}</span>],
              ['Rows returned', fmtCount(s.rows)],
              ...(s.tables.length ? [['Tables', <span className="font-mono text-xs">{s.tables.join(', ')}</span>] as [string, ReactNode]] : []),
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">No statistics for this statement yet. The SDK reports them once a minute.</p>
        )}
      </CardContent>
    </Card>
  )
}

function Statement({ q }: { q: LiveQuery }) {
  const s = q.statement
  const sent = valuesSent(s)
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>SQL</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <CodeBlock code={s.sql} sql />
        {s.error && (
          <div className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm">
            <p className="font-medium text-destructive">The database returned an error</p>
            <p className="font-mono text-xs break-words">{s.error}</p>
          </div>
        )}
        {!sent ? (
          <p className="text-sm text-muted-foreground">
            Parameter values stay in your app: the SDK sends the statement with its values replaced. Set{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] whitespace-nowrap">sendValues: true</code> to send them,
            for example in development.
          </p>
        ) : (
          s.params.length > 0 && (
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-20">Parameter</TableHead>
                    <TableHead>Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.params.map((p, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs text-muted-foreground">${i + 1}</TableCell>
                      <TableCell className="font-mono text-xs break-all whitespace-normal">
                        {p === null ? <span className="text-muted-foreground">NULL</span> : p}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        )}
      </CardContent>
    </Card>
  )
}

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
    <span className="ml-auto inline-flex items-center gap-2">
      {error !== null && <span className="text-xs text-destructive">{error instanceof Error ? error.message : 'Failed'}</span>}
      <Button variant="outline" size="sm" disabled={busy} onClick={toggle}>
        {isMuted ? <BellIcon /> : <BellOffIcon />}
        {isMuted ? 'Unmute' : 'Mute'}
      </Button>
    </span>
  )
}

function IssueCard({ projectId, finding, muted }: { projectId: string; finding: LiveFinding; muted: Muted }) {
  const detail = useAsync(() => api.issue(projectId, finding.issueId), [projectId, finding.issueId])
  const d = detail.data
  const isMuted = muted.isMuted(projectId, finding.issueId)
  return (
    <Card className="gap-4">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="outline">
            <SeverityDot severity={finding.severity} />
            {SEVERITY[finding.severity].label}
          </Badge>
          <span className="text-muted-foreground">{FINDING_KINDS[finding.kind]}</span>
          {isMuted && (
            <Badge variant="secondary">
              <BellOffIcon /> Muted
            </Badge>
          )}
          <MuteButton projectId={projectId} issueId={finding.issueId} muted={muted} />
        </div>
        <CardTitle className="text-base leading-snug">{finding.title}</CardTitle>
        {d && (
          <CardDescription>
            Seen in {fmtCount(d.issue.timesSeen)} {d.issue.timesSeen === 1 ? 'request' : 'requests'}, first{' '}
            {fmtRelative(d.issue.firstSeen)}, last {fmtRelative(d.issue.lastSeen)}. Time spent: {fmtMs(d.issue.impactMs)}.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="grid gap-4 text-sm [&>*]:min-w-0">
        {detail.error ? (
          <ErrorNote error={detail.error} />
        ) : !d ? (
          <div className="grid gap-2">
            <Skeleton className="h-4" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <>
            <p className="leading-relaxed text-muted-foreground">
              <Prose text={d.issue.detail} />
            </p>
            {d.fix && (
              <div className="grid min-w-0 gap-3">
                <p className="font-medium">How to fix it{d.fix.orm ? ` with ${ORMS[d.fix.orm]}` : ''}</p>
                <p className="leading-relaxed">
                  <Prose text={d.fix.text} />
                </p>
                {d.fix.code && <CodeBlock code={d.fix.code} wrap={false} />}
                {d.fix.ddl && <CodeBlock code={`${d.fix.ddl};`} sql />}
              </div>
            )}
            {d.parentSql && (
              <div className="grid gap-2">
                <p className="font-medium">It runs once per row of</p>
                <CodeBlock code={d.parentSql} sql />
              </div>
            )}
            {d.origins.length > 0 && (
              <div className="grid gap-2">
                <p className="font-medium">Lines where it happens</p>
                <ul className="grid gap-1">
                  {d.origins.map((o) => (
                    <li key={o.origin} className="flex items-center justify-between gap-4 font-mono text-xs">
                      <span className="truncate">{o.origin}</span>
                      <span className="shrink-0 text-muted-foreground tabular">{fmtCount(o.count)}×</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function RequestStatements({ q, siblings }: { q: LiveQuery; siblings: LiveQuery[] }) {
  const same = siblings.filter((x) => x.statement.fingerprint === q.statement.fingerprint)
  const sameMs = same.reduce((n, x) => n + x.statement.durationMs, 0)
  /** The timeline's extent: the request, or its last statement if that ends later. */
  const span = Math.max(q.request.durationMs, ...siblings.map((x) => x.statement.atMs + x.statement.durationMs), 0.001)
  const r = q.request
  const go = (x: LiveQuery) => navigate({ page: 'query', ...x.ref })
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>
          The request: <span className="font-mono text-sm font-medium">{r.name}</span>
        </CardTitle>
        <CardDescription>
          {fmtMs(r.durationMs)} in total, {fmtMs(r.dbMs)} in the database across {siblings.length} statements.
          {same.length > 1 && ` This statement ran ${same.length} times in it, ${fmtMs(sameMs)} together; those runs are in bold.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="hidden flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground md:flex" aria-label="Timeline legend">
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-read" />Read</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-write" />Write</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-[2px] bg-muted-foreground/50" />Other</span>
          <span>Full colour: runs of this statement. Ringed: this run.</span>
        </div>
        <div className="overflow-hidden rounded-md border">
          <Table className="table-fixed">
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-12">#</TableHead>
                <TableHead className="hidden w-20 text-right sm:table-cell">Start</TableHead>
                <TableHead>Query</TableHead>
                <TableHead className="hidden w-[22%] lg:table-cell">Code location</TableHead>
                <TableHead className="hidden w-[26%] md:table-cell">
                  <span className="flex justify-between font-normal text-muted-foreground tabular">
                    <span>0</span>
                    <span>{fmtMs(span)}</span>
                  </span>
                </TableHead>
                <TableHead className="w-20 text-right">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {siblings.map((x) => {
                const current = x.id === q.id
                const shape = x.statement.fingerprint === q.statement.fingerprint
                return (
                  <TableRow
                    key={x.id}
                    data-state={current ? 'selected' : undefined}
                    aria-current={current ? 'true' : undefined}
                    className={cn(current ? 'shadow-[inset_2px_0_0_var(--primary)] data-[state=selected]:bg-primary/[0.07]' : 'cursor-pointer')}
                    onClick={() => !current && go(x)}
                  >
                    <TableCell className={cn('text-xs tabular', current ? 'font-semibold text-foreground' : 'text-muted-foreground')}>{x.statement.seq}</TableCell>
                    <TableCell className="hidden text-right text-xs text-muted-foreground tabular sm:table-cell">
                      +{fmtMs(x.statement.atMs)}
                    </TableCell>
                    <TableCell className="max-w-0">
                      <span
                        className={cn('block truncate font-mono text-xs', shape ? 'font-semibold' : 'text-muted-foreground', x.statement.error && 'text-destructive')}
                        title={x.statement.sql}
                      >
                        <Sql sql={x.statement.sql} plain={!shape || x.statement.error !== null} />
                      </span>
                    </TableCell>
                    <TableCell className="hidden max-w-0 lg:table-cell">
                      <span className="block truncate font-mono text-xs text-muted-foreground">{x.statement.origin ?? '—'}</span>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="relative h-2" title={`+${fmtMs(x.statement.atMs)}, ${fmtMs(x.statement.durationMs)}`}>
                        <div
                          className={cn(
                            'absolute inset-y-0 rounded-[2px]',
                            ACTION_FILL[STATEMENT_ACTION[x.type]],
                            !shape && 'opacity-40',
                            current && 'ring-2 ring-primary ring-offset-2 ring-offset-card',
                          )}
                          style={{ left: `${(x.statement.atMs / span) * 100}%`, width: `max(3px, ${(x.statement.durationMs / span) * 100}%)` }}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular">{fmtMs(x.statement.durationMs)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        {siblings.length >= STORED_STATEMENT_LIMIT && (
          <p className="text-xs text-muted-foreground">QueryLens keeps the first {STORED_STATEMENT_LIMIT} statements of a request.</p>
        )}
      </CardContent>
    </Card>
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
      <div className="grid gap-6">
        <BackLink />
        <div className="grid gap-4">
          <Skeleton className="h-7 w-80" />
          <Skeleton className="h-48" />
        </div>
      </div>
    )
  }
  const q = queriesOf(request).find((x) => x.ref.seq === at.seq)
  if (!q) return <Missing title="No such query">This request has no statement #{at.seq}.</Missing>

  const project = projects.find((p) => p.id === q.request.projectId)
  const siblings = queriesOf(q.request)
  const s = q.statement

  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <BackLink />
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="py-1">
            <StatementTypeLabel type={q.type} className="text-foreground" />
          </Badge>
          {s.error && (
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              Failed
            </Badge>
          )}
          {q.findings.map((f) => (
            <Badge key={f.issueId} variant="outline">
              <SeverityDot severity={f.severity} />
              {FINDING_KINDS[f.kind]}
            </Badge>
          ))}
        </div>
        <h1 className="text-xl font-semibold tracking-tight">
          {fmtMs(s.durationMs)} {STATEMENT_TYPES[q.type] === 'Other' ? 'statement' : STATEMENT_TYPES[q.type]} in{' '}
          <span className="font-mono text-lg">{q.request.name}</span>
        </h1>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 gap-6">
          <Statement q={q} />
          {q.findings.map((f) => (
            <IssueCard key={f.issueId} projectId={q.request.projectId} finding={f} muted={muted} />
          ))}
          <RequestStatements q={q} siblings={siblings} />
        </div>
        <div className="order-first grid min-w-0 gap-6 lg:order-none">
          <CalledFrom q={q} project={project} />
          <Execution q={q} project={project} total={siblings.length} />
          <LastDay q={q} />
        </div>
      </div>
    </div>
  )
}
