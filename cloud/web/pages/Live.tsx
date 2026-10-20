import { BellOffIcon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { Project } from '../../bindings/Project'
import { FilterDialog } from '@/components/FilterDialog'
import { Regressions } from '@/components/Regressions'
import { Sql } from '@/components/Sql'
import { CodeBlock, ConnectionStatus, ErrorNote, SeverityDot, SlowMark, StatementTypeLabel } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  type CustomFilter,
  PRESETS,
  type Preset,
  loadFilters,
  matchesFilter,
  matchesPreset,
  matchesSearch,
  saveFilters,
} from '@/lib/filters'
import { FINDING_KINDS, fmtCount, fmtMs, fmtTime } from '@/lib/format'
import type { LiveFeed } from '@/lib/live'
import type { Muted } from '@/lib/muted'
import { type LiveQuery, type LiveRequest, type MutedMode, applyMuted, flatten, mergeRequests } from '@/lib/queries'
import { href, navigate, onLinkClick } from '@/lib/router'
import { cn } from '@/lib/utils'

/** Rows rendered at once; the rest are a click away. */
const PAGE = 300
const ALL = 'all'
const VIEW_KEY = 'querylens.live'
/** The selected view wears the brand colour. */
const ACTIVE_VIEW = 'data-[state=on]:bg-primary/10 data-[state=on]:text-primary dark:data-[state=on]:bg-primary/15'

interface View {
  project: string
  environment: string
  /** A preset, or a custom filter's id. */
  filter: string
  mutedIssues: MutedMode
}

const DEFAULT_VIEW: View = { project: ALL, environment: ALL, filter: 'all', mutedIssues: 'hide' }

function loadView(): View {
  try {
    return { ...DEFAULT_VIEW, ...JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') }
  } catch {
    return DEFAULT_VIEW
  }
}

function useView(): [View, (patch: Partial<View>) => void] {
  const [view, setView] = useState(loadView)
  const update = (patch: Partial<View>) =>
    setView((v) => {
      const next = { ...v, ...patch }
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify(next))
      } catch {
        // Not remembered: fine.
      }
      return next
    })
  return [view, update]
}

function open(q: LiveQuery) {
  navigate({ page: 'query', ...q.ref })
}

function QueryRow({ q, project, showProject }: { q: LiveQuery; project: Project | undefined; showProject: boolean }) {
  const s = q.statement
  const slow = project ? s.durationMs >= project.settings.slowMs : false
  return (
    <TableRow
      className={cn('cursor-pointer', q.request.arrivedAt !== undefined && Date.now() - q.request.arrivedAt < 1500 && 'animate-arrive')}
      onClick={() => open(q)}
    >
      <TableCell className="font-mono text-xs text-muted-foreground tabular">{fmtTime(q.at)}</TableCell>
      <TableCell className="hidden sm:table-cell">
        <StatementTypeLabel type={q.type} />
      </TableCell>
      <TableCell className="max-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <a
            href={href({ page: 'query', ...q.ref })}
            onClick={(e) => {
              e.stopPropagation()
              onLinkClick(e)
            }}
            className="truncate font-mono text-xs outline-none hover:underline focus-visible:underline"
            title={s.sql}
          >
            <Sql sql={s.sql} />
          </a>
          {s.error && (
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              Failed
            </Badge>
          )}
          {q.findings.map((f) =>
            q.muted.includes(f.issueId) ? (
              <Badge key={f.issueId} variant="outline" className="hidden text-muted-foreground md:inline-flex" title="Muted issue">
                <BellOffIcon />
                {FINDING_KINDS[f.kind]}
              </Badge>
            ) : (
              <Badge key={f.issueId} variant="outline" className="hidden md:inline-flex">
                <SeverityDot severity={f.severity} />
                {FINDING_KINDS[f.kind]}
              </Badge>
            ),
          )}
        </div>
      </TableCell>
      <TableCell className="hidden max-w-0 lg:table-cell">
        <span className="block truncate font-mono text-xs text-muted-foreground" title={s.origin ?? undefined}>
          {s.origin ?? '—'}
        </span>
      </TableCell>
      <TableCell className="hidden max-w-0 md:table-cell">
        <span className="block truncate text-xs" title={q.request.name}>
          {q.request.name}
        </span>
        {showProject && <span className="block truncate text-xs text-muted-foreground">{project?.name ?? 'Unknown project'}</span>}
      </TableCell>
      <TableCell className={cn('text-right text-xs tabular', slow && 'font-medium')}>
        <span className="inline-flex items-center justify-end gap-1.5">
          {slow && project && <SlowMark slowMs={project.settings.slowMs} />}
          {fmtMs(s.durationMs)}
        </span>
      </TableCell>
      <TableCell className="hidden w-20 text-right text-xs text-muted-foreground tabular sm:table-cell">{fmtCount(s.rows)}</TableCell>
    </TableRow>
  )
}

function Waiting({ projects }: { projects: Project[] }) {
  return (
    <div className="mx-auto grid max-w-2xl gap-4 px-6 py-14 text-sm">
      <div className="grid gap-1.5 text-center">
        <p className="text-base font-medium">Waiting for queries</p>
        <p className="text-muted-foreground">
          Queries appear here as your app sends them. The SDK always sends requests with a problem, and a sample of the
          others ({Math.round((projects[0]?.settings.liveSampleRate ?? 0.05) * 100)}% in production, all of them in
          development).
        </p>
      </div>
      {projects.map((p) => (
        <div key={p.id} className="grid gap-1.5">
          <p className="text-muted-foreground">
            DSN for <span className="font-medium text-foreground">{p.name}</span>
          </p>
          <CodeBlock code={p.dsn} />
        </div>
      ))}
    </div>
  )
}

export function LivePage({ projects, feed, muted }: { projects: Project[]; feed: LiveFeed; muted: Muted }) {
  const [view, setView] = useView()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<CustomFilter[]>(loadFilters)
  const [dialog, setDialog] = useState<{ open: boolean; editing: CustomFilter | null }>({ open: false, editing: null })
  const [frozen, setFrozen] = useState<LiveRequest[] | null>(null)
  const [limit, setLimit] = useState(PAGE)

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const projectId = view.project !== ALL && byId.has(view.project) ? view.project : ALL
  const custom = filters.find((f) => f.id === view.filter) ?? null
  const preset: Preset | null = custom ? null : (PRESETS.find((p) => p.id === view.filter)?.id ?? 'all')

  const requests = frozen ?? feed.requests
  const scoped = useMemo(
    () =>
      flatten(requests)
        .filter((q) => (projectId === ALL || q.request.projectId === projectId) && (view.environment === ALL || q.request.environment === view.environment))
        .map((q) => applyMuted(q, muted.isMuted, view.mutedIssues)),
    [requests, projectId, view.environment, view.mutedIssues, muted.isMuted],
  )
  const environments = useMemo(() => [...new Set(feed.requests.map((r) => r.environment))].sort(), [feed.requests])
  /** Newest first: what "the last release" means when a filter is described. */
  const releases = useMemo(() => [...new Set(feed.requests.flatMap((r) => (r.release ? [r.release] : [])))], [feed.requests])
  const scopeProjects = useMemo(() => (projectId === ALL ? projects : projects.filter((p) => p.id === projectId)), [projects, projectId])
  const searched = useMemo(() => scoped.filter((q) => matchesSearch(q, search)), [scoped, search])
  const slowMs = (q: LiveQuery) => byId.get(q.request.projectId)?.settings.slowMs ?? Infinity
  const counts = useMemo(
    () => Object.fromEntries(PRESETS.map((p) => [p.id, searched.filter((q) => matchesPreset(p.id, q, slowMs(q))).length])),
    [searched, byId],
  )
  const shown = useMemo(
    () => searched.filter((q) => (custom ? matchesFilter(q, custom) : matchesPreset(preset ?? 'all', q, slowMs(q)))),
    [searched, custom, preset, byId],
  )
  useEffect(() => {
    setLimit(PAGE)
  }, [view, search])

  const newWhilePaused = frozen ? feed.requests.findIndex((r) => r.id === frozen[0]?.id) : 0
  const pending = frozen ? (newWhilePaused === -1 ? feed.requests.length : newWhilePaused) : 0
  const showProject = projectId === ALL && projects.length > 1
  const filtered = search.trim() !== '' || view.filter !== 'all' || view.environment !== ALL || projectId !== ALL

  const scopeIds = projectId === ALL ? projects.map((p) => p.id) : [projectId]
  const older = feed.loaded && feed.hasOlder(scopeIds)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState<unknown>(null)
  const loadOlder = async () => {
    setLoadingOlder(true)
    setOlderError(null)
    try {
      const page = await feed.loadOlder(scopeIds)
      // While paused, older requests still join the frozen list.
      setFrozen((f) => (f ? mergeRequests(f, page) : f))
    } catch (e) {
      setOlderError(e)
    } finally {
      setLoadingOlder(false)
    }
  }

  const saveFilter = (f: CustomFilter) => {
    const next = filters.some((x) => x.id === f.id) ? filters.map((x) => (x.id === f.id ? f : x)) : [...filters, f]
    setFilters(next)
    saveFilters(next)
    setView({ filter: f.id })
  }
  const deleteFilter = (id: string) => {
    const next = filters.filter((x) => x.id !== id)
    setFilters(next)
    saveFilters(next)
    if (view.filter === id) setView({ filter: 'all' })
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Live queries</h1>
          <p className="text-sm text-muted-foreground">Every statement of the requests your apps send, newest first, kept for 7 days.</p>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionStatus state={feed.connection} />
          <Button variant="outline" size="sm" onClick={() => setFrozen(frozen ? null : feed.requests)}>
            {frozen ? <PlayIcon /> : <PauseIcon />}
            {frozen ? (pending > 0 ? `Resume (${fmtCount(pending)} new requests)` : 'Resume') : 'Pause'}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
          <Select value={projectId} onValueChange={(v) => setView({ project: v })}>
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All projects</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={view.environment} onValueChange={(v) => setView({ environment: v })}>
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Environment">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All environments</SelectItem>
              {[...new Set([...environments, ...(view.environment !== ALL ? [view.environment] : [])])].map((e) => (
                <SelectItem key={e} value={e}>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={view.mutedIssues} onValueChange={(v) => setView({ mutedIssues: v as MutedMode })}>
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Muted issues">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hide">Hide muted issues</SelectItem>
              <SelectItem value="show">Show muted issues</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="relative min-w-52 flex-1 sm:max-w-80">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search SQL, file or route"
            aria-label="Search queries"
            className="h-8 pl-8"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={view.filter}
          onValueChange={(v) => v && setView({ filter: v })}
          aria-label="View"
          className="flex-wrap"
        >
          {PRESETS.map((p) => (
            <ToggleGroupItem key={p.id} value={p.id} className={cn('group/view gap-1.5 px-3', ACTIVE_VIEW)}>
              {p.label}
              <span className="text-muted-foreground tabular group-data-[state=on]/view:text-primary/70">{fmtCount(counts[p.id] ?? 0)}</span>
            </ToggleGroupItem>
          ))}
          {filters.map((f) => (
            <ToggleGroupItem key={f.id} value={f.id} className={cn('px-3', ACTIVE_VIEW)}>
              {f.name}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {custom && (
          <Button variant="ghost" size="sm" onClick={() => setDialog({ open: true, editing: custom })}>
            <PencilIcon /> Edit filter
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setDialog({ open: true, editing: null })}>
          <PlusIcon /> New filter
        </Button>
      </div>

      <Regressions projects={scopeProjects} environment={view.environment === ALL ? null : view.environment} />

      <div className="overflow-hidden rounded-lg border">
        {!feed.loaded && feed.requests.length === 0 ? (
          <div className="grid gap-3 p-4" aria-label="Loading queries">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        ) : feed.requests.length === 0 && !frozen ? (
          <Waiting projects={projectId === ALL ? projects : projects.filter((p) => p.id === projectId)} />
        ) : shown.length === 0 ? (
          <div className="grid justify-items-center gap-3 px-6 py-14 text-center text-sm">
            <p className="text-base font-medium">No queries match</p>
            <p className="text-muted-foreground">
              None of the {fmtCount(feed.size)} loaded queries match the current project, environment, search and view.
            </p>
            {filtered && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch('')
                  setView({ project: ALL, environment: ALL, filter: 'all', mutedIssues: 'hide' })
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <Table className="table-fixed">
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-24 sm:w-28">Time</TableHead>
                <TableHead className="hidden w-24 sm:table-cell">Type</TableHead>
                <TableHead>Query</TableHead>
                <TableHead className="hidden w-[22%] lg:table-cell">Code location</TableHead>
                <TableHead className="hidden w-[18%] md:table-cell">Request</TableHead>
                <TableHead className="w-24 text-right">Duration</TableHead>
                <TableHead className="hidden w-20 text-right sm:table-cell">Rows</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.slice(0, limit).map((q) => (
                <QueryRow key={q.id} q={q} project={byId.get(q.request.projectId)} showProject={showProject} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {(shown.length > 0 || older) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="tabular">
            {shown.length > limit
              ? `Showing ${limit.toLocaleString()} of ${shown.length.toLocaleString()} matching queries.`
              : `${shown.length.toLocaleString()} matching ${shown.length === 1 ? 'query' : 'queries'} of ${feed.size.toLocaleString()} loaded.`}
          </span>
          {shown.length > limit ? (
            <Button variant="outline" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
              Show more
            </Button>
          ) : (
            older && (
              <Button variant="outline" size="sm" disabled={loadingOlder} onClick={loadOlder}>
                {loadingOlder ? 'Loading…' : 'Load older queries'}
              </Button>
            )
          )}
        </div>
      )}
      <ErrorNote error={olderError} />

      <FilterDialog
        open={dialog.open}
        onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))}
        editing={dialog.editing}
        queries={scoped}
        releases={releases}
        onSave={saveFilter}
        onDelete={deleteFilter}
      />
    </div>
  )
}
