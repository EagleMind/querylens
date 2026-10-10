import { useEffect } from 'react'

import { SuggestionPanel } from '@/components/ai/SuggestionPanel'
import { AnalyzeToolbar } from '@/components/editor/AnalyzeToolbar'
import { SqlEditor } from '@/components/editor/SqlEditor'
import { PlanView } from '@/components/plan/PlanView'
import { PageHeader } from '@/components/layout/PageHeader'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { useAnalyze } from '@/hooks/useAnalyze'
import { useHotkey } from '@/hooks/useHotkey'
import type { IpcError } from '@/lib/ipc'
import { useConnections, useSettings } from '@/lib/queries'
import { useWorkspace } from '@/store/workspace'

export function AnalyzeRoute() {
  const { data: connections = [] } = useConnections()
  const { data: settings } = useSettings()
  const sql = useWorkspace((s) => s.sql)
  const setSql = useWorkspace((s) => s.setSql)
  const connectionId = useWorkspace((s) => s.connectionId)
  const setConnectionId = useWorkspace((s) => s.setConnectionId)
  const storedMode = useWorkspace((s) => s.mode)
  const setMode = useWorkspace((s) => s.setMode)
  const analysis = useWorkspace((s) => s.analysis)
  const isReplay = useWorkspace((s) => s.isReplay)
  const analyze = useAnalyze()

  const mode = storedMode ?? settings?.analysis.defaultMode ?? 'analyze'
  const connection = connections.find((c) => c.id === connectionId) ?? null

  // Keep the selection valid: fall back to the most recently used connection.
  useEffect(() => {
    if (connections.length && !connection) {
      const recent = [...connections].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))[0]
      setConnectionId(recent.id)
    }
  }, [connections, connection, setConnectionId])

  const canRun = !!connection && sql.trim().length > 0
  const run = () => {
    if (!canRun || analyze.isPending) return
    analyze.mutate({ connectionId: connection!.id, sql, mode })
  }
  useHotkey('mod+enter', run)

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Analyze">
        <AnalyzeToolbar
          connections={connections}
          connectionId={connection?.id ?? null}
          onConnectionChange={setConnectionId}
          mode={mode}
          onModeChange={setMode}
          onAnalyze={run}
          running={analyze.isPending}
          canRun={canRun}
        />
      </PageHeader>

      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="32%" minSize="12%" className="bg-panel">
          <SqlEditor value={sql} onChange={setSql} onRun={run} tables={analysis?.tables} />
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
              <SuggestionPanel analysis={analyze.isPending ? null : analysis} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
