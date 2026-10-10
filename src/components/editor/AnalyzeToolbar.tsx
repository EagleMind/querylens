import { GaugeIcon, Loader2Icon, PlayIcon, PlusIcon, ShieldCheckIcon } from 'lucide-react'

import type { Connection } from '@/bindings/Connection'
import type { ExplainMode } from '@/bindings/ExplainMode'
import { ColorDot, EngineBadge, Kbd } from '@/components/shared/bits'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { modKey } from '@/hooks/useHotkey'
import { useUi } from '@/store/ui'

export function AnalyzeToolbar({
  connections,
  connectionId,
  onConnectionChange,
  mode,
  onModeChange,
  onAnalyze,
  running,
  canRun,
}: {
  connections: Connection[]
  connectionId: string | null
  onConnectionChange: (id: string) => void
  mode: ExplainMode
  onModeChange: (m: ExplainMode) => void
  onAnalyze: () => void
  running: boolean
  canRun: boolean
}) {
  const openDialog = useUi((s) => s.openConnectionDialog)

  return (
    <div className="flex items-center gap-2">
      {connections.length > 0 ? (
        <Select value={connectionId ?? undefined} onValueChange={onConnectionChange}>
          <SelectTrigger size="sm" className="w-56 text-xs">
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
      ) : (
        <Button size="sm" variant="outline" onClick={() => openDialog()}>
          <PlusIcon /> Add connection
        </Button>
      )}

      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        spacing={0}
        value={mode}
        onValueChange={(v) => v && onModeChange(v as ExplainMode)}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <ToggleGroupItem value="analyze" className="gap-1.5 px-2.5 text-xs">
              <ShieldCheckIcon className="size-3.5" /> Analyze
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            EXPLAIN ANALYZE: really executes the statement inside a transaction that is always rolled back, with a
            statement timeout. Gives real timings.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <ToggleGroupItem value="estimate" className="gap-1.5 px-2.5 text-xs">
              <GaugeIcon className="size-3.5" /> Estimate
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            Plain EXPLAIN: planner estimates only. Never executes anything — safe on production.
          </TooltipContent>
        </Tooltip>
      </ToggleGroup>

      <Button size="sm" onClick={onAnalyze} disabled={!canRun || running} className="ml-1 min-w-28">
        {running ? <Loader2Icon className="animate-spin" /> : <PlayIcon className="fill-current" />}
        {running ? 'Running…' : mode === 'analyze' ? 'Analyze' : 'Explain'}
        {!running && (
          <span className="ml-1 flex gap-0.5">
            <Kbd>{modKey}</Kbd>
            <Kbd>↵</Kbd>
          </span>
        )}
      </Button>
    </div>
  )
}
