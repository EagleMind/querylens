// The Live page: the query history and its live tail, for the project, backend and environment
// chosen in the sidebar. Grouped by query shape (one row per fingerprint) or one row per run. A
// selected query's report opens beside the list on wide screens, and in its place on narrow.
import { BellOffIcon, PauseIcon, PencilIcon, PlayIcon, PlusIcon, SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import type { LiveFinding } from '../../bindings/LiveFinding'
import type { Project } from '../../bindings/Project'
import { FilterDialog } from '@/components/FilterDialog'
import { Regressions } from '@/components/Regressions'
import { Sql } from '@/components/Sql'
import { ACTION_FILL, CodeBlock, ErrorNote, SeverityDot, SlowMark } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import { FINDING_KINDS, fmtCount, fmtMs, fmtRelative, fmtTime } from '@/lib/format'
import type { LiveFeed } from '@/lib/live'
import type { Muted } from '@/lib/muted'
import {
  type LiveQuery,
  type LiveRequest,
  type MutedMode,
  type QueryGroup,
  STATEMENT_ACTION,
  applyMuted,
  flatten,
  groupByShape,
  groupKey,
  isHousekeeping,
  mergeRequests,
  summarizeSql,
} from '@/lib/queries'
import { type QueryRef, href, navigate, onLinkClick } from '@/lib/router'
import { ALL, type Scope, scopedBackend } from '@/lib/scope'
import { cn } from '@/lib/utils'
import { QueryPage, QueryPanel } from '@/pages/Query'

/** Rows rendered at once; the rest are a click away. */
const PAGE = 300
const VIEW_KEY = 'querylens.live'
/** The selected view wears the brand colour. */
const ACTIVE_VIEW = 'data-[state=on]:bg-primary/10 data-[state=on]:text-primary dark:data-[state=on]:bg-primary/15'
/** Where the report opens beside the list rather than in its place (Tailwind's `lg`). */
const WIDE = '(min-width: 64rem)'

type Grouping = 'shape' | 'runs'

interface View {
  /** A preset, or a custom filter's id. */
  filter: string
  mutedIssues: MutedMode
  grouping: Grouping
}

const DEFAULT_VIEW: View = { filter: 'all', mutedIssues: 'hide', grouping: 'shape' }

function loadView(): View {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}')
    return { filter: saved.filter ?? DEFAULT_VIEW.filter, mutedIssues: saved.mutedIssues ?? DEFAULT_VIEW.mutedIssues, grouping: saved.grouping ?? DEFAULT_VIEW.grouping }
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

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query)
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
  )
}

function open(q: LiveQuery) {
  navigate({ page: 'query', ...q.ref })
}

function justArrived(q: LiveQuery): boolean {
  return q.request.arrivedAt !== undefined && Date.now() - q.request.arrivedAt < 1500
}

/**
 * The query, linked to its report, as verb and tables (the full statement is in its tooltip and
 * the report); under it, what's wrong with it and where it runs in your code. Transactions and
 * session settings are muted unless something's wrong with them.
 */
function QueryCell({ q, findings, muted, failed }: { q: LiveQuery; findings: LiveFinding[]; muted: number[]; failed: string | null }) {
  const s = q.statement
  // One badge per kind of problem: a shape can carry two N+1 issues (under different parents).
  const kinds = findings.filter((f, i) => findings.findIndex((x) => x.kind === f.kind) === i)
  const quiet = isHousekeeping(s.sql) && kinds.length === 0 && !failed
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('size-2 shrink-0 rounded-[2px]', ACTION_FILL[STATEMENT_ACTION[q.type]])} aria-hidden />
        <a
          href={href({ page: 'query', ...q.ref })}
          onClick={(e) => {
            e.stopPropagation()
            onLinkClick(e)
          }}
          className={cn('truncate font-mono text-xs outline-none hover:underline focus-visible:underline', quiet && 'opacity-55')}
          title={s.sql}
        >
          <Sql sql={summarizeSql(s.sql)} />
        </a>
      </div>
      {(s.origin || kinds.length > 0 || failed) && (
        <div className="flex min-w-0 items-center gap-1.5 pl-4">
          {failed && (
            <Badge variant="outline" className="h-5 shrink-0 border-destructive/40 py-0 text-[11px] text-destructive">
              {failed}
            </Badge>
          )}
          {kinds.map((f) =>
            muted.includes(f.issueId) ? (
              <Badge key={f.issueId} variant="outline" className="h-5 shrink-0 py-0 text-[11px] text-muted-foreground" title="Muted issue">
                <BellOffIcon />
                {FINDING_KINDS[f.kind]}
              </Badge>
            ) : (
              <Badge key={f.issueId} variant="outline" className="h-5 shrink-0 py-0 text-[11px]">
                <SeverityDot severity={f.severity} />
                {FINDING_KINDS[f.kind]}
              </Badge>
            ),
          )}
          {s.origin && (
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={s.origin}>
              {s.origin}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** Selected: a bar of the brand colour at the row's start, and a wash. */
const SELECTED_ROW = 'bg-primary/[0.07] shadow-[inset_2px_0_0_var(--primary)] hover:bg-primary/10'

interface RowProps {
  project: Project
  /** Which backend sent it, when the list shows several. */
  showBackend: boolean
  selected: boolean
}

function BackendName({ project, id }: { project: Project; id: string }) {
  return <span className="block truncate text-xs text-muted-foreground">{project.backends.find((b) => b.id === id)?.name ?? 'Unknown backend'}</span>
}

function RunRow({ q, project, showBackend, selected }: RowProps & { q: LiveQuery }) {
  const s = q.statement
  const slow = s.durationMs >= project.settings.slowMs
  return (
    <TableRow
      className={cn('cursor-pointer', justArrived(q) && 'animate-arrive', selected && SELECTED_ROW)}
      aria-selected={selected}
      onClick={() => open(q)}
    >
      <TableCell className="font-mono text-xs text-muted-foreground tabular">{fmtTime(q.at)}</TableCell>
      <TableCell className="max-w-0">
        <QueryCell q={q} findings={q.findings} muted={q.muted} failed={s.error ? 'Failed' : null} />
      </TableCell>
      <TableCell className="hidden max-w-0 @3xl:table-cell">
        <span className="block truncate text-xs" title={q.request.name}>
          {q.request.name}
        </span>
        {showBackend && <BackendName project={project} id={q.request.backend} />}
      </TableCell>
      <TableCell className={cn('text-right text-xs tabular', slow && 'font-medium')}>
        <span className="inline-flex items-center justify-end gap-1.5">
          {slow && <SlowMark slowMs={project.settings.slowMs} />}
          {fmtMs(s.durationMs)}
        </span>
      </TableCell>
      <TableCell className="hidden text-right text-xs text-muted-foreground tabular @md:table-cell">{fmtCount(s.rows)}</TableCell>
    </TableRow>
  )
}

function ShapeRow({ g, project, showBackend, selected }: RowProps & { g: QueryGroup }) {
  const q = g.latest
  const slow = g.maxMs >= project.settings.slowMs
  const others = g.requests.length - 1
  return (
    <TableRow
      className={cn('cursor-pointer', justArrived(q) && 'animate-arrive', selected && SELECTED_ROW)}
      aria-selected={selected}
      onClick={() => open(q)}
    >
      <TableCell className="text-xs text-muted-foreground tabular" title={fmtTime(q.at)}>
        {fmtRelative(new Date(q.at).toISOString())}
      </TableCell>
      <TableCell className="max-w-0">
        <QueryCell q={q} findings={g.findings} muted={g.muted} failed={g.failed === 0 ? null : g.failed === g.runs ? 'Failed' : `${fmtCount(g.failed)} failed`} />
      </TableCell>
      <TableCell className="hidden max-w-0 @3xl:table-cell">
        <span className="block truncate text-xs" title={g.requests.join('\n')}>
          {q.request.name}
          {others > 0 && <span className="ml-1.5 rounded bg-muted px-1 py-px text-[11px] text-muted-foreground tabular">+{others}</span>}
        </span>
        {showBackend && <BackendName project={project} id={q.request.backend} />}
      </TableCell>
      <TableCell className="text-right text-xs font-medium tabular">{fmtCount(g.runs)}</TableCell>
      <TableCell className={cn('hidden text-right text-xs tabular @md:table-cell', slow && 'font-medium')}>
        <span className="inline-flex items-center justify-end gap-1.5">
          {slow && <SlowMark slowMs={project.settings.slowMs} />}
          {fmtMs(g.totalMs / g.runs)}
        </span>
      </TableCell>
    </TableRow>
  )
}

function Waiting({ project, backend }: { project: Project; backend: string }) {
  const connected = project.backends.filter((b) => b.dsn && (backend === ALL || b.id === backend))
  if (project.backends.length === 0) {
    return (
      <div className="mx-auto grid max-w-md justify-items-center gap-3 px-6 py-14 text-center text-sm">
        <p className="text-base font-medium">Connect a backend</p>
        <p className="text-muted-foreground">
          {project.name} has no backend yet. Connect each service of the app; each gets its own DSN to give the SDK.
        </p>
        <Button size="sm" asChild>
          <a href={href({ page: 'settings' })} onClick={onLinkClick}>
            <PlusIcon /> Connect a backend
          </a>
        </Button>
      </div>
    )
  }
  return (
    <div className="mx-auto grid max-w-2xl gap-4 px-6 py-14 text-sm">
      <div className="grid gap-1.5 text-center">
        <p className="text-base font-medium">Waiting for queries</p>
        <p className="text-muted-foreground">
          Queries appear here as your backends send them. The SDK always sends requests with a problem, and a sample of
          the others ({Math.round(project.settings.liveSampleRate * 100)}% in production, all of them in development).
        </p>
      </div>
      {connected.map((b) => (
        <div key={b.id} className="grid gap-1.5">
          <p className="text-muted-foreground">
            DSN for <span className="font-medium text-foreground">{b.name}</span>
          </p>
          <CodeBlock code={b.dsn!} />
        </div>
      ))}
    </div>
  )
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function LivePage({
  project,
  feed,
  muted,
  scope,
  onScope,
  selected,
}: {
  project: Project
  feed: LiveFeed
  muted: Muted
  scope: Scope
  onScope: (patch: Partial<Scope>) => void
  /** The query whose report is open. */
  selected: QueryRef | null
}) {
  const [view, setView] = useView()
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<CustomFilter[]>(loadFilters)
  const [dialog, setDialog] = useState<{ open: boolean; editing: CustomFilter | null }>({ open: false, editing: null })
  const [frozen, setFrozen] = useState<LiveRequest[] | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const wide = useMediaQuery(WIDE)
  // Re-render now and then so "Last run" (8m ago) stays true while nothing new arrives.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(timer)
  }, [])

  const backend = scopedBackend(scope, project)
  const environment = scope.environment
  const custom = filters.find((f) => f.id === view.filter) ?? null
  const preset: Preset | null = custom ? null : (PRESETS.find((p) => p.id === view.filter)?.id ?? 'all')

  const requests = frozen ?? feed.requests
  const scoped = useMemo(
    () =>
      flatten(requests)
        .filter((q) => (backend === ALL || q.request.backend === backend) && (environment === ALL || q.request.environment === environment))
        .map((q) => applyMuted(q, muted.isMuted, view.mutedIssues)),
    [requests, backend, environment, view.mutedIssues, muted.isMuted],
  )
  /** Newest first: what "the last release" means when a filter is described. */
  const releases = useMemo(() => [...new Set(feed.requests.flatMap((r) => (r.release ? [r.release] : [])))], [feed.requests])
  const searched = useMemo(() => scoped.filter((q) => matchesSearch(q, search)), [scoped, search])
  const slowMs = project.settings.slowMs
  const counts = useMemo(
    () => Object.fromEntries(PRESETS.map((p) => [p.id, searched.filter((q) => matchesPreset(p.id, q, slowMs)).length])),
    [searched, slowMs],
  )
  const shown = useMemo(
    () => searched.filter((q) => (custom ? matchesFilter(q, custom) : matchesPreset(preset ?? 'all', q, slowMs))),
    [searched, custom, preset, slowMs],
  )
  const groups = useMemo(() => (view.grouping === 'shape' ? groupByShape(shown) : []), [shown, view.grouping])
  useEffect(() => {
    setLimit(PAGE)
  }, [view, search, scope])

  const newWhilePaused = frozen ? feed.requests.findIndex((r) => r.id === frozen[0]?.id) : 0
  const pending = frozen ? (newWhilePaused === -1 ? feed.requests.length : newWhilePaused) : 0
  const showBackend = backend === ALL && project.backends.length > 1
  const filtered = search.trim() !== '' || view.filter !== 'all' || environment !== ALL || backend !== ALL

  const scopeIds = [project.id]
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

  const selectedRun = selected ? `${selected.project}:${selected.request}:${selected.seq}` : null
  const selectedShape = useMemo(() => {
    if (!selected) return null
    const q = flatten(requests).find((x) => x.request.projectId === selected.project && x.request.id === selected.request && x.ref.seq === selected.seq)
    return q ? groupKey(q.request, q.statement.fingerprint) : null
  }, [selected, requests])

  // On a narrow screen the report takes the list's place; the list keeps its state meanwhile.
  if (selected && !wide) return <QueryPage at={selected} projects={[project]} requests={feed.requests} muted={muted} />
  const rows = view.grouping === 'shape' ? groups.length : shown.length
  const noun = view.grouping === 'shape' ? (rows === 1 ? 'query shape' : 'query shapes') : rows === 1 ? 'query' : 'queries'

  const list = (
    <div className="grid min-w-0 content-start gap-4">
      <Regressions project={project} backend={backend === ALL ? null : backend} environment={environment === ALL ? null : environment} />

      {/* One frame for the list and the selected query's report: the report is the row's detail, not a column of its own. */}
      <div className={cn('overflow-clip rounded-lg border bg-card', selected && 'grid grid-cols-[minmax(0,1fr)_minmax(26rem,46%)] items-start')}>
        <div className="@container min-w-0">
        {!feed.loaded && feed.requests.length === 0 ? (
          <div className="grid gap-3 p-4" aria-label="Loading queries">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        ) : feed.requests.length === 0 && !frozen ? (
          <Waiting project={project} backend={backend} />
        ) : shown.length === 0 ? (
          <div className="grid justify-items-center gap-3 px-6 py-14 text-center text-sm">
            <p className="text-base font-medium">No queries match</p>
            <p className="text-muted-foreground">
              None of the {fmtCount(feed.size)} loaded queries match the current backend, environment, search and view.
            </p>
            {filtered && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch('')
                  setView({ filter: 'all', mutedIssues: 'hide' })
                  onScope({ backend: ALL, environment: ALL })
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        ) : view.grouping === 'shape' ? (
          <Table className="table-fixed">
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-20">Last run</TableHead>
                <TableHead>Query</TableHead>
                <TableHead className="hidden w-[22%] @3xl:table-cell">Requests</TableHead>
                <TableHead className="w-16 text-right">Runs</TableHead>
                <TableHead className="hidden w-24 text-right @md:table-cell">Average</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.slice(0, limit).map((g) => (
                <ShapeRow key={g.id} g={g} project={project} showBackend={showBackend} selected={g.id === selectedShape} />
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table className="table-fixed">
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-24 @md:w-28">Time</TableHead>
                <TableHead>Query</TableHead>
                <TableHead className="hidden w-[22%] @3xl:table-cell">Request</TableHead>
                <TableHead className="w-24 text-right">Duration</TableHead>
                <TableHead className="hidden w-16 text-right @md:table-cell">Rows</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.slice(0, limit).map((q) => (
                <RunRow key={q.id} q={q} project={project} showBackend={showBackend} selected={`${q.ref.project}:${q.ref.request}:${q.ref.seq}` === selectedRun} />
              ))}
            </TableBody>
          </Table>
        )}
        </div>
        {selected && (
          <div
            key={selectedRun}
            className="sticky top-0 max-h-dvh self-stretch overflow-y-auto border-l bg-muted/40 shadow-[-8px_0_16px_-12px_rgb(0_0_0/0.25)] dark:bg-muted/50"
          >
            <QueryPanel at={selected} projects={[project]} requests={feed.requests} muted={muted} />
          </div>
        )}
      </div>

      {(rows > 0 || older) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="tabular">
            {rows > limit
              ? `Showing ${limit.toLocaleString()} of ${rows.toLocaleString()} matching ${noun}.`
              : view.grouping === 'shape'
                ? `${rows.toLocaleString()} ${noun} from ${shown.length.toLocaleString()} of ${feed.size.toLocaleString()} loaded queries.`
                : `${rows.toLocaleString()} matching ${noun} of ${feed.size.toLocaleString()} loaded.`}
          </span>
          {rows > limit ? (
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
    </div>
  )

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Live queries</h1>
        <Button variant="outline" size="sm" onClick={() => setFrozen(frozen ? null : feed.requests)}>
          {frozen ? <PlayIcon /> : <PauseIcon />}
          {frozen ? (pending > 0 ? `Resume (${fmtCount(pending)} new requests)` : 'Resume') : 'Pause'}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1 basis-60">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search SQL, file or route"
            aria-label="Search queries"
            className="h-8 pl-8"
          />
        </div>
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
        <div className="flex items-center">
          {custom && (
            <IconAction label="Edit filter" onClick={() => setDialog({ open: true, editing: custom })}>
              <PencilIcon />
            </IconAction>
          )}
          <IconAction label="New filter" onClick={() => setDialog({ open: true, editing: null })}>
            <PlusIcon />
          </IconAction>
          <Tooltip>
            <TooltipTrigger asChild>
              <Toggle
                size="sm"
                className={cn('size-8 px-0', ACTIVE_VIEW)}
                aria-label="Show muted issues"
                pressed={view.mutedIssues === 'show'}
                onPressedChange={(on) => setView({ mutedIssues: on ? 'show' : 'hide' })}
              >
                <BellOffIcon />
              </Toggle>
            </TooltipTrigger>
            <TooltipContent>{view.mutedIssues === 'show' ? 'Showing muted issues' : 'Show muted issues'}</TooltipContent>
          </Tooltip>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={view.grouping}
          onValueChange={(v) => v && setView({ grouping: v as Grouping })}
          aria-label="Rows"
          className="ml-auto"
        >
          <ToggleGroupItem value="shape" className={cn('px-3', ACTIVE_VIEW)}>
            Grouped
          </ToggleGroupItem>
          <ToggleGroupItem value="runs" className={cn('px-3', ACTIVE_VIEW)}>
            Every run
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {list}

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
