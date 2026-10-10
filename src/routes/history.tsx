import {
  HistoryIcon,
  Loader2Icon,
  PencilLineIcon,
  SearchIcon,
  LightbulbIcon,
  Trash2Icon,
  TriangleAlertIcon,
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
import { useWorkspace } from '@/store/workspace'

function Row({
  entry,
  color,
  onOpen,
  opening,
}: {
  entry: HistoryEntry
  color: string
  onOpen: () => void
  opening: boolean
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
      className="group grid grid-cols-[minmax(0,1fr)_110px_90px_auto] items-center gap-4 border-b px-4 py-3 outline-none hover:bg-accent/40 focus-visible:bg-accent/50"
    >
      <div className="min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ColorDot color={color} />
          <span className="text-foreground/90">{entry.connectionName}</span>
          <EngineBadge engine={entry.engine} />
          <span className="font-mono text-[9px] tracking-wider uppercase">{entry.mode}</span>
          {entry.hasSuggestions && <LightbulbIcon className="size-3 text-primary" />}
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
          <div className="grid grid-cols-[minmax(0,1fr)_110px_90px_auto] gap-4 border-b bg-panel px-4 py-2 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
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
            />
          ))}
        </ScrollArea>
      )}
    </div>
  )
}
