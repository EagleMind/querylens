import {
  HistoryIcon,
  Loader2Icon,
  PencilLineIcon,
  SearchIcon,
  NotebookPenIcon,
  Trash2Icon,
  TriangleAlertIcon,
  CheckIcon,
  GitCompareArrowsIcon,
} from 'lucide-react'
import { useDeferredValue, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'

import type { HistoryEntry } from '@/bindings/HistoryEntry'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ColorDot, EngineBadge } from '@/components/shared/bits'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fmtCount, fmtMs, fmtRelative } from '@/lib/format'
import { api } from '@/lib/ipc'
import { useClearHistory, useConnections, useDeleteAnalysis, useHistory } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'

const GRID = 'grid grid-cols-[20px_minmax(0,1fr)_110px_90px_auto] items-center gap-4'

function Row({
  entry,
  color,
  onOpen,
  opening,
  checked,
  onToggle,
}: {
  entry: HistoryEntry
  color: string
  onOpen: () => void
  opening: boolean
  checked: boolean
  onToggle: () => void
}) {
  const del = useDeleteAnalysis()
  const setSql = useWorkspace((s) => s.setSql)
  const setConnectionId = useWorkspace((s) => s.setConnectionId)
  const navigate = useNavigate()

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className={cn(
        GRID,
        'group border-b px-4 py-3 outline-none hover:bg-accent/40 focus-visible:bg-accent/50',
        checked && 'bg-accent/50',
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label="Select for comparison"
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        className={cn(
          'flex size-4 items-center justify-center rounded-[2px] border border-foreground/30 transition',
          checked ? 'border-signal bg-signal text-signal-foreground' : 'opacity-40 group-hover:opacity-100',
        )}
      >
        {checked && <CheckIcon className="size-3" strokeWidth={3} />}
      </button>
      <div className="min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ColorDot color={color} />
          <span className="text-foreground/90">{entry.connectionName}</span>
          <EngineBadge engine={entry.engine} />
          <span className="italic">{entry.mode === 'analyze' ? 'executed' : 'estimated'}</span>
          {entry.hasSuggestions && <NotebookPenIcon className="size-3 text-foreground/70" />}
        </div>
        <p className="line-clamp-2 font-mono text-xs/relaxed text-foreground/85">{entry.sqlPreview}</p>
      </div>
      <div className="text-right font-mono text-sm tabular">
        {entry.mode === 'analyze' ? (
          fmtMs(entry.executionTimeMs)
        ) : (
          <span className="text-muted-foreground">cost {fmtCount(entry.totalCost)}</span>
        )}
      </div>
      <div
        className={cn(
          'flex items-center justify-end gap-1 font-mono text-xs',
          entry.warningsCount ? 'text-heat-medium' : 'text-muted-foreground',
        )}
      >
        {entry.warningsCount > 0 && <TriangleAlertIcon className="size-3.5" />}
        {entry.warningsCount || '—'}
      </div>
      <div className="flex w-36 items-center justify-end gap-1">
        {opening ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <span className="text-xs text-muted-foreground group-hover:hidden">{fmtRelative(entry.createdAt)}</span>
        )}
        <div className="hidden gap-1 group-hover:flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={async (e) => {
                  e.stopPropagation()
                  // The list only carries a preview; fetch the full statement.
                  const full = await api.getAnalysis(entry.id).catch(() => null)
                  setSql(full?.sql ?? entry.sqlPreview)
                  setConnectionId(entry.connectionId)
                  navigate('/')
                }}
              >
                <PencilLineIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Load SQL into the editor</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                className="hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation()
                  del.mutate(entry.id)
                }}
              >
                <Trash2Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

export function HistoryRoute() {
  const [search, setSearch] = useState('')
  const deferred = useDeferredValue(search)
  const { data: entries, isLoading } = useHistory(deferred)
  const { data: connections } = useConnections()
  const clear = useClearHistory()
  const navigate = useNavigate()
  const setAnalysis = useWorkspace((s) => s.setAnalysis)
  const setSql = useWorkspace((s) => s.setSql)
  const setConnectionId = useWorkspace((s) => s.setConnectionId)
  const [opening, setOpening] = useState<string | null>(null)
  // Pick two analyses to compare; the third pick replaces the oldest pick.
  const [picked, setPicked] = useState<string[]>([])
  const openCompare = useUi((s) => s.openCompare)
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)))
  function compare() {
    const byTime = picked
      .map((id) => entries?.find((e) => e.id === id))
      .filter((e): e is HistoryEntry => !!e)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (byTime.length === 2) openCompare(byTime[0].id, byTime[1].id)
  }

  async function open(id: string) {
    setOpening(id)
    try {
      const analysis = await api.getAnalysis(id)
      setAnalysis(analysis, { replay: true })
      setSql(analysis.sql)
      if (connections?.some((c) => c.id === analysis.connectionId)) setConnectionId(analysis.connectionId)
      navigate('/')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setOpening(null)
    }
  }

  const colorOf = (id: string) => connections?.find((c) => c.id === id)?.color ?? '#64748b'

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="History">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search SQL or connection…"
            className="h-7 w-64 pl-8 text-xs"
          />
        </div>
        <Button
          size="sm"
          variant={picked.length === 2 ? 'default' : 'outline'}
          disabled={picked.length !== 2}
          onClick={compare}
        >
          <GitCompareArrowsIcon /> Compare {picked.length > 0 && `(${picked.length}/2)`}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="ghost" disabled={!entries?.length}>
              <Trash2Icon /> Clear
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Clear all history?</AlertDialogTitle>
              <AlertDialogDescription>Every saved analysis and its suggestions will be deleted.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => clear.mutate()}>
                Clear history
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </PageHeader>

      {!isLoading && entries?.length === 0 ? (
        <EmptyState icon={HistoryIcon} title={deferred ? 'No matches' : 'No analyses yet'}>
          {deferred
            ? `Nothing in history matches “${deferred}”.`
            : 'Every analysis is saved here automatically (newest 200).'}
        </EmptyState>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className={cn(GRID, 'border-b bg-panel px-4 py-2 text-[12px] font-semibold text-muted-foreground')}>
            <span />
            <span>Query</span>
            <span className="text-right">Time</span>
            <span className="text-right">Warnings</span>
            <span className="w-36 text-right">When</span>
          </div>
          {entries?.map((e) => (
            <Row
              key={e.id}
              entry={e}
              color={colorOf(e.connectionId)}
              onOpen={() => open(e.id)}
              opening={opening === e.id}
              checked={picked.includes(e.id)}
              onToggle={() => toggle(e.id)}
            />
          ))}
        </ScrollArea>
      )}
    </div>
  )
}
