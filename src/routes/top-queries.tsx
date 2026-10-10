import { useQuery } from '@tanstack/react-query'
import { FlameIcon, Loader2Icon, RotateCcwIcon } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'

import type { TopQuery } from '@/bindings/TopQuery'
import type { TopQueryOrder } from '@/bindings/TopQueryOrder'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ColorDot, EngineBadge } from '@/components/shared/bits'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fmtCount, fmtMs, fmtPct } from '@/lib/format'
import { api } from '@/lib/ipc'
import { useConnections } from '@/lib/queries'
import { placeholderCount } from '@/lib/sql'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/store/workspace'

const ORDERS: { id: TopQueryOrder; label: string }[] = [
  { id: 'total', label: 'Total time' },
  { id: 'mean', label: 'Time per call' },
  { id: 'calls', label: 'Calls' },
]

const GRID = 'grid grid-cols-[110px_minmax(0,1fr)_80px_90px_100px_80px] items-center gap-4'

function Row({ q, onOpen }: { q: TopQuery; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(GRID, 'w-full border-b border-rule px-4 py-3 text-left hover:bg-accent/40')}
    >
      <div className="space-y-1">
        <div className="h-1.5 bg-rule">
          <div className="h-full bg-heat-high" style={{ width: `${Math.max(q.share * 100, 1)}%` }} />
        </div>
        <span className="font-mono text-[11.5px] text-muted-foreground tabular">{fmtPct(q.share)} of time</span>
      </div>
      <p className="line-clamp-2 font-mono text-[12px]/relaxed text-foreground/85">{q.query}</p>
      <span className="text-right font-mono text-[12.5px] tabular">{fmtCount(q.calls)}</span>
      <span className="text-right font-mono text-[12.5px] tabular">{fmtMs(q.meanMs)}</span>
      <span className="text-right font-mono text-[12.5px] tabular">{fmtMs(q.totalMs)}</span>
      <span
        className={cn(
          'text-right font-mono text-[12.5px] tabular',
          q.hitRatio != null && q.hitRatio < 0.9 ? 'text-heat-medium' : 'text-muted-foreground',
        )}
      >
        {q.hitRatio != null ? fmtPct(q.hitRatio) : '—'}
      </span>
    </button>
  )
}

/** The statements costing the most time on a connection, from pg_stat_statements. */
export function TopQueriesRoute() {
  const { data: connections = [] } = useConnections()
  const connectionId = useWorkspace((s) => s.connectionId)
  const setConnectionId = useWorkspace((s) => s.setConnectionId)
  const setSql = useWorkspace((s) => s.setSql)
  const setParams = useWorkspace((s) => s.setParams)
  const navigate = useNavigate()
  const [order, setOrder] = useState<TopQueryOrder>('total')
  const conn = connections.find((c) => c.id === connectionId) ?? null

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['top-queries', conn?.id, order],
    queryFn: () => api.topQueries(conn!.id, order),
    enabled: conn?.engine === 'postgres',
    retry: false,
  })

  function open(q: TopQuery) {
    setSql(q.query)
    // Normalized statements carry $n placeholders; start with empty values.
    setParams(Array.from({ length: placeholderCount(q.query) }, () => ''))
    navigate('/')
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Top queries">
        {connections.length > 0 && (
          <Select value={conn?.id} onValueChange={setConnectionId}>
            <SelectTrigger size="sm" className="w-48 text-xs">
              <SelectValue placeholder="Choose a connection" />
            </SelectTrigger>
            <SelectContent>
              {connections.map((c) => (
                <SelectItem key={c.id} value={c.id} className="text-xs">
                  <ColorDot color={c.color} />
                  <span className="truncate">{c.name}</span>
                  <EngineBadge engine={c.engine} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={order} onValueChange={(v) => setOrder(v as TopQueryOrder)}>
          <SelectTrigger size="sm" className="w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ORDERS.map((o) => (
              <SelectItem key={o.id} value={o.id} className="text-xs">
                Sort: {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={!conn || isFetching}>
          {isFetching ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon />} Refresh
        </Button>
      </PageHeader>

      {!conn ? (
        <EmptyState icon={FlameIcon} title="Choose a connection">
          Top queries lists the statements costing the most time on a PostgreSQL server.
        </EmptyState>
      ) : conn.engine !== 'postgres' ? (
        <EmptyState icon={FlameIcon} title="PostgreSQL only">
          DuckDB doesn't keep a statement history. Choose a PostgreSQL connection.
        </EmptyState>
      ) : error ? (
        <EmptyState icon={FlameIcon} title="Statement statistics aren't available">
          <span data-selectable>{(error as Error).message}</span>
        </EmptyState>
      ) : data && data.length === 0 ? (
        <EmptyState icon={FlameIcon} title="No statements recorded yet">
          pg_stat_statements hasn't seen any queries in this database since it was last reset.
        </EmptyState>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className={cn(GRID, 'border-b bg-panel px-4 py-2 text-[12px] font-semibold text-muted-foreground')}>
            <span>Share</span>
            <span>Statement</span>
            <span className="text-right">Calls</span>
            <span className="text-right">Per call</span>
            <span className="text-right">Total</span>
            <span className="text-right">Cache hit</span>
          </div>
          {data?.map((q) => (
            <Row key={q.queryId} q={q} onOpen={() => open(q)} />
          ))}
          {data && (
            <p className="px-4 py-3 text-[12px] text-muted-foreground">
              Click a statement to open it in the Workbench. Its literals are $n parameters there: fill them in, then
              use Try other values to see whether the plan changes with the value.
            </p>
          )}
        </ScrollArea>
      )}
    </div>
  )
}
