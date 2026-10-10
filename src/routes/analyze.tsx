import { useEffect } from 'react'

import { InsightsPanel } from '@/components/ai/InsightsPanel'
import { AnalyzeToolbar } from '@/components/editor/AnalyzeToolbar'
import { ParamsBar } from '@/components/editor/ParamsBar'
import { SqlEditor } from '@/components/editor/SqlEditor'
import { PlanView } from '@/components/plan/PlanView'
import { PageHeader } from '@/components/layout/PageHeader'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useAnalyze } from '@/hooks/useAnalyze'
import { useHotkey } from '@/hooks/useHotkey'
import type { ExplainMode } from '@/bindings/ExplainMode'
import type { IpcError } from '@/lib/ipc'
import { useConnections, useSettings } from '@/lib/queries'
import { paramValues, placeholderCount } from '@/lib/sql'
import { useWorkspace } from '@/store/workspace'

export function AnalyzeRoute() {
  const { data: connections = [] } = useConnections()
  const { data: settings } = useSettings()
  const sql = useWorkspace((s) => s.sql)
  const setSql = useWorkspace((s) => s.setSql)
  const connectionId = useWorkspace((s) => s.connectionId)
  const setConnectionId = useWorkspace((s) => s.setConnectionId)
  const analysis = useWorkspace((s) => s.analysis)
  const isReplay = useWorkspace((s) => s.isReplay)
  const analyze = useAnalyze()

  // Ctrl/⌘+Enter runs the primary action; adding Shift runs the other one.
  const primary: ExplainMode = settings?.analysis.defaultMode ?? 'analyze'
  const secondary: ExplainMode = primary === 'analyze' ? 'estimate' : 'analyze'
  const connection = connections.find((c) => c.id === connectionId) ?? null

  // Keep the selection valid: fall back to the most recently used connection.
  useEffect(() => {
    if (connections.length && !connection) {
      const recent = [...connections].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))[0]
      setConnectionId(recent.id)
    }
  }, [connections, connection, setConnectionId])

  const params = useWorkspace((s) => s.params)
  const paramCount = placeholderCount(sql)
  const canRun = !!connection && sql.trim().length > 0
  const run = (mode: ExplainMode) => {
    if (!canRun || analyze.isPending) return
    analyze.mutate({ connectionId: connection!.id, sql, mode, params: paramValues(params, paramCount) })
  }
  useHotkey('mod+enter', () => run(primary))
  useHotkey('mod+shift+enter', () => run(secondary))

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Workbench">
        <AnalyzeToolbar
          connections={connections}
          connectionId={connection?.id ?? null}
          onConnectionChange={setConnectionId}
          primary={primary}
          sql={sql}
          onRun={run}
          runningMode={analyze.isPending ? (analyze.variables?.mode ?? null) : null}
          canRun={canRun}
        />
      </PageHeader>

      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="32%" minSize="12%" className="bg-panel">
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <SqlEditor
                value={sql}
                onChange={setSql}
                onRun={(alt) => run(alt ? secondary : primary)}
                tables={analysis?.tables}
              />
            </div>
            <ParamsBar count={paramCount} />
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize="25%">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize="62%" minSize="35%">
              <PlanView
                analysis={analysis}
                isReplay={isReplay}
                running={analyze.isPending}
                error={(analyze.error as IpcError | null) ?? null}
              />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize="38%" minSize="22%">
              <InsightsPanel analysis={analyze.isPending ? null : analysis} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
