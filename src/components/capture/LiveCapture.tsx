import { Loader2Icon, SquareIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import type { CaptureLive } from '@/bindings/CaptureLive'
import { CopyButton } from '@/components/shared/CopyButton'
import { PaneLabel } from '@/components/shared/bits'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SDK_URL, maskUrl } from '@/lib/capture'
import { fmtCount, fmtMs } from '@/lib/format'
import { cn } from '@/lib/utils'

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2">
      <span className="font-display text-[15px] font-semibold text-foreground/40 tabular">{n}</span>
      <div className="min-w-0 space-y-1.5">
        <p className="text-[13px] font-medium">{title}</p>
        {children}
      </div>
    </div>
  )
}

function CopyLine({ shown, value }: { shown: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-[3px] bg-background py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/90" data-selectable>
        {shown}
      </code>
      <CopyButton value={value} />
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="space-y-0.5">
      <PaneLabel>{label}</PaneLabel>
      <p className={cn('font-mono text-[18px] tabular', warn && 'text-heat-medium')}>{value}</p>
    </div>
  )
}

/** A capture that is recording: how to connect, and what's coming through. */
export function LiveCapture({ live, onStop, stopping }: { live: CaptureLive; onStop: () => void; stopping: boolean }) {
  // Another capture holds the default port: SDK apps must be told where to report.
  const customUrl = live.collectorUrl && live.collectorUrl !== SDK_URL ? live.collectorUrl : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-5 py-3">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-heat-high opacity-60" />
          <span className="relative inline-flex size-2.5 rounded-full bg-heat-high" />
        </span>
        <h2 className="text-[15px] font-semibold">Recording</h2>
        <Button className="ml-auto" size="sm" onClick={onStop} disabled={stopping}>
          {stopping ? <Loader2Icon className="animate-spin" /> : <SquareIcon />}
          {stopping ? 'Analyzing…' : 'Stop and analyze'}
        </Button>
      </div>

      <div className="grid gap-5 border-b px-5 py-4 lg:grid-cols-2">
        <Step n={1} title="Node.js apps: just run them">
          <CopyLine shown="npx querylens-cli init" value="npx querylens-cli init" />
          <p className="text-[12px] text-muted-foreground">
            Once per project: adds the <code className="font-mono">querylens-node</code> SDK (Sequelize, Knex, TypeORM,
            Drizzle on <code className="font-mono">pg</code>). Then start your app as usual; its queries show up here
            with the line of code that sent them.
          </p>
          {customUrl && <CopyLine shown={`QUERYLENS_URL=${customUrl}`} value={`QUERYLENS_URL=${customUrl}`} />}
          <p className={cn('text-[12px] font-medium', live.sdkProcesses > 0 ? 'text-ok' : 'text-muted-foreground')}>
            {live.sdkProcesses > 0
              ? `${live.sdkProcesses} app ${live.sdkProcesses === 1 ? 'process' : 'processes'} reporting`
              : 'Waiting for an app…'}
          </p>
        </Step>
        {live.appUrl && (
          <Step n={2} title="Any other app: point it at the proxy">
            <CopyLine shown={maskUrl(live.appUrl)} value={live.appUrl} />
            <p className="text-[12px] text-muted-foreground">
              Use it where the app reads its database URL (e.g. <code className="font-mono">DATABASE_URL</code>). TLS
              stays between the proxy and the database.
            </p>
          </Step>
        )}
      </div>

      <div className="flex gap-10 border-b px-5 py-3">
        <Stat label="Statements" value={fmtCount(live.statements)} />
        <Stat label="Database time" value={fmtMs(live.totalMs)} />
        <Stat label="App processes" value={fmtCount(live.sdkProcesses)} />
        <Stat label="Proxy connections" value={`${live.openConnections} open · ${live.totalConnections}`} />
        <Stat label="Errors" value={fmtCount(live.errors)} warn={live.errors > 0} />
      </div>

      <div className="flex items-center px-5 pt-3 pb-2">
        <PaneLabel>Latest statements</PaneLabel>
      </div>
      {live.recent.length === 0 ? (
        <p className="px-5 text-[13px] text-muted-foreground">Waiting for the first statement…</p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {live.recent.map((s) => (
            <div
              key={s.seq}
              className="grid grid-cols-[70px_60px_minmax(0,1fr)_minmax(0,180px)] items-center gap-3 border-b border-rule px-5 py-1.5"
            >
              <span className="text-right font-mono text-[12px] tabular">{fmtMs(s.durationMs)}</span>
              <span className="text-right font-mono text-[11.5px] text-muted-foreground tabular">
                {fmtCount(s.rows)} rows
              </span>
              <p className={cn('truncate font-mono text-[12px] text-foreground/85', s.error && 'text-heat-high')}>
                {s.sql}
              </p>
              <span className="truncate text-right font-mono text-[11px] text-muted-foreground">{s.origin}</span>
            </div>
          ))}
        </ScrollArea>
      )}
    </div>
  )
}
