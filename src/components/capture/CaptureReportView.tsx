import { CheckCheckIcon, GaugeIcon, Loader2Icon, Trash2Icon } from 'lucide-react'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'

import type { CaptureReport } from '@/bindings/CaptureReport'
import type { FingerprintStat } from '@/bindings/FingerprintStat'
import { EmptyState } from '@/components/shared/EmptyState'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ORMS } from '@/lib/capture'
import { fmtCount, fmtMs, fmtRelative } from '@/lib/format'
import { useProfileCapture } from '@/lib/queries'
import { useWorkspace } from '@/store/workspace'

import { FindingItem } from './FindingItem'
import { StatementsTable } from './StatementsTable'

/** A finished capture: findings with fixes, and every distinct statement. */
export function CaptureReportView({ report, onDelete }: { report: CaptureReport; onDelete: () => void }) {
  const navigate = useNavigate()
  const loadQuery = useWorkspace((s) => s.loadQuery)
  const setParams = useWorkspace((s) => s.setParams)
  const setConnectionId = useWorkspace((s) => s.setConnectionId)
  const profile = useProfileCapture()
  const stats = useMemo(() => new Map(report.fingerprints.map((s) => [s.fingerprint, s])), [report])
  const measured = report.planChecks.some((c) => c.mode === 'analyze')

  function open(stat: FingerprintStat) {
    loadQuery(stat.sampleSql, 'sql')
    setParams(stat.sampleParams.map((p) => p ?? 'NULL'))
    if (report.capture.connectionId) setConnectionId(report.capture.connectionId)
    navigate('/')
  }

  const facts = [
    `${fmtCount(report.statements)} statements`,
    `${fmtMs(report.totalMs)} of database time`,
    `${report.fingerprints.length} distinct`,
    ...(report.units > 0 ? [`${report.units} requests`] : []),
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold">{report.capture.name}</h2>
          <p className="text-[12px] text-muted-foreground">
            {facts.join(' · ')}
            {report.orm && (
              <>
                {' · '}
                <span className="font-semibold text-foreground/80">{ORMS[report.orm].label}</span>
              </>
            )}
            {' · '}
            {fmtRelative(report.capture.startedAt)}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={profile.isPending || measured || !report.capture.connectionId}
                onClick={() => profile.mutate(report.capture.id)}
              >
                {profile.isPending ? <Loader2Icon className="animate-spin" /> : <GaugeIcon />}
                {measured ? 'Plans measured' : 'Measure plans'}
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              Runs the flagged SELECTs once more inside a rolled-back, read-only transaction for real timings and tests
              candidate indexes. By default plans are estimates only.
            </TooltipContent>
          </Tooltip>
          <Button size="icon-sm" variant="ghost" onClick={onDelete} title="Delete capture">
            <Trash2Icon />
          </Button>
        </div>
      </div>

      <Tabs defaultValue="findings" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-5 mt-2">
          <TabsTrigger value="findings">Findings ({report.findings.length})</TabsTrigger>
          <TabsTrigger value="statements">Statements ({report.fingerprints.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="findings" className="min-h-0 flex-1">
          {report.findings.length === 0 ? (
            <EmptyState icon={CheckCheckIcon} title="No problems found">
              No N+1 queries, repeated statements, row-by-row writes, large results or plan problems in this capture.
            </EmptyState>
          ) : (
            <ScrollArea className="h-full">
              <div className="mx-auto max-w-4xl px-5 py-3">
                {report.findings.map((f, i) => (
                  <FindingItem
                    key={f.id}
                    finding={f}
                    index={i}
                    stat={stats.get(f.fingerprint)}
                    parent={f.parentFingerprint ? stats.get(f.parentFingerprint) : undefined}
                    onOpen={open}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </TabsContent>
        <TabsContent value="statements" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <StatementsTable stats={report.fingerprints} onOpen={open} />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  )
}
