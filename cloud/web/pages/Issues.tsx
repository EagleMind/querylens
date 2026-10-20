import { ArchiveIcon, CheckCircle2Icon, RotateCcwIcon, SearchIcon, ShieldCheckIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { Issue } from '../../../src/bindings/Issue'
import type { IssueStatus } from '../../../src/bindings/IssueStatus'
import type { Project } from '../../../src/bindings/Project'
import { Prose } from '../components/Prose'
import { Statements } from '../components/Statements'
import { Button, CodeBlock, Empty, ErrorNote, Segmented, Select, Severity, cx } from '../components/ui'
import { type IssueSort, api } from '../lib/api'
import { FINDING_KINDS, ORMS, fmtCount, fmtMs, fmtRelative } from '../lib/format'
import { href, navigate, onLinkClick } from '../lib/router'
import { useAsync } from '../lib/useAsync'

function IssueRow({ issue, active }: { issue: Issue; active: boolean }) {
  return (
    <li>
      <a
        href={href({ page: 'issues', issue: issue.id })}
        onClick={onLinkClick}
        aria-current={active ? 'true' : undefined}
        className={cx(
          'block border-b border-l-2 border-b-rule px-3 py-2.5 hover:bg-raised/60',
          active ? 'border-l-signal bg-raised/60' : 'border-l-transparent',
        )}
      >
        <div className="flex items-center gap-3 text-[11.5px]">
          <Severity severity={issue.severity} />
          <span className="font-semibold text-foreground/70">{FINDING_KINDS[issue.kind]}</span>
          {issue.regressed && <span className="rounded-[2px] bg-sev-high/15 px-1.5 text-sev-high">Regressed</span>}
          <span className="ml-auto text-muted">{fmtRelative(issue.lastSeen)}</span>
        </div>
        <p className="mt-1 line-clamp-2 text-[13.5px]/snug font-semibold">{issue.title}</p>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11.5px] text-muted">
          {issue.culprit && <span className="font-mono">{issue.culprit}</span>}
          {issue.transaction && <span className="font-mono">{issue.transaction}</span>}
          <span className="tabular">{fmtCount(issue.timesSeen)} requests</span>
        </div>
      </a>
    </li>
  )
}

function IssueDetailPanel({ project, id, onChanged }: { project: Project; id: number; onChanged: () => void }) {
  const detail = useAsync(() => api.issue(project.id, id), [project.id, id])
  const events = useAsync(() => api.events(project.id, id), [project.id, id])
  const [eventIndex, setEventIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => setEventIndex(0), [id])

  if (detail.error) return <ErrorNote error={detail.error} />
  const d = detail.data
  if (!d) return <p className="p-6 text-[13px] text-muted">Loading…</p>
  const i = d.issue
  const event = events.data?.[eventIndex]

  const setStatus = async (status: IssueStatus) => {
    setBusy(true)
    setError(null)
    try {
      await api.setStatus(project.id, id, status)
      detail.reload()
      onChanged()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="space-y-5">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <Severity severity={i.severity} />
          <span className="font-semibold text-foreground/70">{FINDING_KINDS[i.kind]}</span>
          <span className="text-muted">{i.environment}</span>
          {i.status !== 'unresolved' && <span className="rounded-[2px] bg-raised px-1.5 text-muted capitalize">{i.status}</span>}
          {i.regressed && <span className="rounded-[2px] bg-sev-high/15 px-1.5 text-sev-high">Regressed</span>}
        </div>
        <h2 className="text-[20px]/tight font-semibold text-pretty">{i.title}</h2>
        <p className="text-[13.5px]/relaxed text-foreground/80">
          <Prose text={i.detail} />
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {i.status === 'unresolved' ? (
            <>
              <Button variant="primary" disabled={busy} onClick={() => setStatus('resolved')}>
                <CheckCircle2Icon /> Resolve
              </Button>
              <Button disabled={busy} onClick={() => setStatus('ignored')}>
                <ArchiveIcon /> Ignore
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => setStatus('unresolved')}>
              <RotateCcwIcon /> Reopen
            </Button>
          )}
        </div>
        <ErrorNote error={error} />
      </header>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[3px] border border-rule bg-rule sm:grid-cols-4">
        {[
          ['Requests', fmtCount(i.timesSeen)],
          ['Occurrences', fmtCount(i.occurrences)],
          ['Time spent', fmtMs(i.impactMs)],
          ['First seen', fmtRelative(i.firstSeen)],
          ['Last seen', fmtRelative(i.lastSeen)],
          ['First release', i.firstRelease ?? '–'],
          ['Last release', i.lastRelease ?? '–'],
          ['Route', i.transaction ?? '–'],
        ].map(([k, v]) => (
          <div key={k} className="bg-panel px-3 py-2">
            <dt className="text-[11.5px] text-muted">{k}</dt>
            <dd className="mt-0.5 truncate text-[13px] font-semibold tabular" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>

      {d.fix && (
        <section className="space-y-2 border-l-2 border-signal pl-4">
          <h3 className="text-[14px] font-semibold">How to fix it{d.fix.orm ? ` · ${ORMS[d.fix.orm]}` : ''}</h3>
          <p className="text-[13.5px]/relaxed text-foreground/85">
            <Prose text={d.fix.text} />
          </p>
          {d.fix.code && <CodeBlock code={d.fix.code} />}
          {d.fix.ddl && <CodeBlock code={`${d.fix.ddl};`} label="SQL" />}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-[14px] font-semibold">Statement</h3>
        <CodeBlock code={d.sampleSql} />
        {d.parentSql && (
          <>
            <p className="pt-1 text-[12.5px] font-semibold text-muted">Runs once per row of</p>
            <CodeBlock code={d.parentSql} />
          </>
        )}
      </section>

      {d.origins.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[14px] font-semibold">Where in your code</h3>
          <ul className="flex flex-wrap gap-1.5">
            {d.origins.map((o) => (
              <li key={o.origin} className="rounded-[3px] border border-rule px-2 py-0.5 font-mono text-[12px]">
                {o.origin}
                <span className="text-muted"> ×{fmtCount(o.count)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto text-[14px] font-semibold">Latest requests</h3>
          {events.data && events.data.length > 1 && (
            <Select label="Request" value={String(eventIndex)} onChange={(v) => setEventIndex(Number(v))}>
              {events.data.map((e, n) => (
                <option key={e.id} value={n}>
                  {fmtRelative(e.at)} · {e.transaction ?? 'background'} · {e.statements.length} statements
                </option>
              ))}
            </Select>
          )}
        </div>
        {event ? (
          <>
            <p className="text-[12px] text-muted">
              {event.transaction ?? 'background'} · {fmtMs(event.durationMs)} · {new Date(event.at).toLocaleString()}
              {event.release ? ` · release ${event.release}` : ''}
            </p>
            <Statements statements={event.statements} highlight={d.fingerprint} />
          </>
        ) : (
          <p className="text-[13px] text-muted">{events.loading ? 'Loading…' : 'No stored requests.'}</p>
        )}
      </section>
    </article>
  )
}

export function IssuesPage({ project, selected, refreshKey }: { project: Project; selected: number | null; refreshKey: number }) {
  const [status, setStatus] = useState<IssueStatus>('unresolved')
  const [env, setEnv] = useState('')
  const [sort, setSort] = useState<IssueSort>('last_seen')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250)
    return () => clearTimeout(t)
  }, [search])

  const environments = useAsync(() => api.environments(project.id), [project.id, refreshKey])
  const issues = useAsync(
    () => api.issues(project.id, { status, environment: env || undefined, sort, query: debounced || undefined }),
    [project.id, status, env, sort, debounced, refreshKey],
  )
  const list = issues.data ?? []

  // Open the first issue on wide screens when none is selected.
  useEffect(() => {
    if (selected === null && list.length > 0 && window.matchMedia('(min-width: 1024px)').matches) {
      history.replaceState(null, '', href({ page: 'issues', issue: list[0].id }))
      window.dispatchEvent(new PopStateEvent('popstate'))
    }
  }, [selected, list])

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
      <section aria-label="Issues" className={cx('min-w-0 rounded-[3px] border border-rule bg-panel', selected !== null && 'hidden lg:block')}>
        <div className="space-y-2 border-b border-rule p-3">
          <Segmented
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'unresolved', label: 'Unresolved' },
              { value: 'resolved', label: 'Resolved' },
              { value: 'ignored', label: 'Ignored' },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search issues</span>
              <SearchIcon className="pointer-events-none absolute top-2 left-2 size-4 text-muted" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search title, SQL, file, route"
                className="h-8 w-full rounded-[3px] border border-border bg-background pr-2 pl-8 text-[13px] placeholder:text-muted"
              />
            </label>
            <Select label="Sort" value={sort} onChange={(v) => setSort(v as IssueSort)}>
              <option value="last_seen">Last seen</option>
              <option value="first_seen">Newest</option>
              <option value="times_seen">Most requests</option>
              <option value="impact">Most time</option>
            </Select>
            {(environments.data?.length ?? 0) > 1 && (
              <Select label="Environment" value={env} onChange={setEnv}>
                <option value="">All environments</option>
                {environments.data?.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>
        <ErrorNote error={issues.error} />
        {list.length === 0 && !issues.loading ? (
          <div className="p-3">
            <Empty title={status === 'unresolved' ? 'No open issues' : `No ${status} issues`} icon={<ShieldCheckIcon />}>
              {status === 'unresolved'
                ? 'Problems the SDK reports (N+1 queries, writes in a loop, slow or failing statements…) show up here, grouped across requests.'
                : null}
            </Empty>
          </div>
        ) : (
          <ul className="max-h-[calc(100vh-13rem)] overflow-y-auto">
            {list.map((i) => (
              <IssueRow key={i.id} issue={i} active={i.id === selected} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Issue" className={cx('min-w-0', selected === null && 'hidden lg:block')}>
        {selected !== null ? (
          <>
            <Button size="sm" variant="ghost" className="mb-3 lg:hidden" onClick={() => navigate({ page: 'issues', issue: null })}>
              ← All issues
            </Button>
            <IssueDetailPanel project={project} id={selected} onChanged={issues.reload} />
          </>
        ) : (
          list.length > 0 && <Empty title="Pick an issue">Its fix, the statement and the latest requests that showed it.</Empty>
        )}
      </section>
    </div>
  )
}
