import { Loader2Icon, RadioIcon } from 'lucide-react'
import { useState } from 'react'

import { CaptureList } from '@/components/capture/CaptureList'
import { CaptureReportView } from '@/components/capture/CaptureReportView'
import { LiveCapture } from '@/components/capture/LiveCapture'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { ColorDot } from '@/components/shared/bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  useCaptureReport,
  useCaptures,
  useConnections,
  useDeleteCapture,
  useRunningCaptures,
  useStartCapture,
  useStopCapture,
} from '@/lib/queries'
import { useWorkspace } from '@/store/workspace'

/** Record what an application sends to PostgreSQL, then review findings and fixes. */
export function CaptureRoute() {
  const { data: connections = [] } = useConnections()
  const workspaceConnection = useWorkspace((s) => s.connectionId)
  const postgres = connections.filter((c) => c.engine === 'postgres')
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const conn = postgres.find((c) => c.id === (connectionId ?? workspaceConnection)) ?? postgres[0] ?? null
  const [port, setPort] = useState('6543')

  const { data: running = [] } = useRunningCaptures()
  const { data: captures = [] } = useCaptures()
  const [picked, setPicked] = useState<string | null>(null)
  const selected = picked ?? running[0]?.id ?? captures[0]?.id ?? null
  const live = running.find((r) => r.id === selected) ?? null
  const report = useCaptureReport(live ? null : selected)

  const start = useStartCapture()
  const stop = useStopCapture()
  const del = useDeleteCapture()

  function startCapture() {
    if (!conn) return
    const p = Number(port)
    start.mutate(
      { connectionId: conn.id, port: Number.isInteger(p) && p > 0 && p < 65536 ? p : null },
      { onSuccess: (l) => setPicked(l.id) },
    )
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Capture">
        {postgres.length > 0 && (
          <>
            <Select value={conn?.id} onValueChange={setConnectionId}>
              <SelectTrigger size="sm" className="w-48 text-xs">
                <SelectValue placeholder="PostgreSQL connection" />
              </SelectTrigger>
              <SelectContent>
                {postgres.map((c) => (
                  <SelectItem key={c.id} value={c.id} className="text-xs">
                    <ColorDot color={c.color} />
                    <span className="truncate">{c.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Port</span>
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                className="h-8 w-20 font-mono text-xs"
                aria-label="Proxy port"
              />
            </div>
            <Button size="sm" onClick={startCapture} disabled={!conn || start.isPending}>
              {start.isPending ? <Loader2Icon className="animate-spin" /> : <RadioIcon />} Start capture
            </Button>
          </>
        )}
      </PageHeader>

      {postgres.length === 0 ? (
        <EmptyState icon={RadioIcon} title="Add a PostgreSQL connection">
          Capture sits between your application and PostgreSQL and records every statement it sends: N+1 queries,
          repeated statements, row-by-row writes and missing indexes, with fixes for your ORM.
        </EmptyState>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
          <ScrollArea className="min-h-0 border-r">
            <CaptureList running={running} captures={captures} selected={selected} onSelect={setPicked} />
          </ScrollArea>
          <div className="min-h-0">
            {live ? (
              <LiveCapture live={live} stopping={stop.isPending} onStop={() => stop.mutate(live.id)} />
            ) : report.data ? (
              <CaptureReportView
                report={report.data}
                onDelete={() => {
                  del.mutate(report.data.capture.id)
                  setPicked(null)
                }}
              />
            ) : report.isLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : report.error ? (
              <EmptyState icon={RadioIcon} title="This capture can't be shown">
                <span data-selectable>{(report.error as Error).message}</span>
              </EmptyState>
            ) : (
              <EmptyState icon={RadioIcon} title="Record your app's queries">
                Start a capture, point your application at the proxy, and use it (or run its tests). Stop to see what it
                sent and what to fix. From a terminal: <code className="font-mono">querylens capture -- npm test</code>
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
