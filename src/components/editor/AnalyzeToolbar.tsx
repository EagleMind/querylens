import { Loader2Icon, PlusIcon, Undo2Icon } from 'lucide-react'
import type { ReactNode } from 'react'

import type { Connection } from '@/bindings/Connection'
import type { ExplainMode } from '@/bindings/ExplainMode'
import { ColorDot, EngineBadge, Kbd } from '@/components/shared/bits'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { modKey } from '@/hooks/useHotkey'
import { ACTIONS } from '@/lib/constants'
import { writesData } from '@/lib/sql'
import { useUi } from '@/store/ui'

function ActionButton({
  mode,
  primary,
  running,
  disabled,
  onRun,
  shortcut,
}: {
  mode: ExplainMode
  primary: boolean
  running: boolean
  disabled: boolean
  onRun: (m: ExplainMode) => void
  shortcut: ReactNode
}) {
  const a = ACTIONS[mode]
  const Icon = running ? Loader2Icon : a.icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant={primary ? 'default' : 'outline'}
          disabled={disabled}
          onClick={() => onRun(mode)}
          className={primary ? 'min-w-28 font-semibold' : 'min-w-24'}
        >
          <Icon className={running ? 'animate-spin' : undefined} />
          {running ? a.busy : a.label}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 flex-col items-start gap-1 py-2">
        <p className="font-semibold">{a.title}</p>
        <p className="opacity-80">{a.body}</p>
        <p className="flex items-center gap-1 pt-0.5 opacity-80">{shortcut}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export function AnalyzeToolbar({
  connections,
  connectionId,
  onConnectionChange,
  primary,
  sql,
  onRun,
  runningMode,
  canRun,
}: {
  connections: Connection[]
  connectionId: string | null
  onConnectionChange: (id: string) => void
  /** Which action Ctrl/⌘+Enter triggers (Settings → Analysis). */
  primary: ExplainMode
  sql: string
  onRun: (mode: ExplainMode) => void
  /** The action currently in flight, if any. */
  runningMode: ExplainMode | null
  canRun: boolean
}) {
  const openDialog = useUi((s) => s.openConnectionDialog)
  const secondary: ExplainMode = primary === 'analyze' ? 'estimate' : 'analyze'
  const busy = runningMode !== null
  const dml = writesData(sql)

  const mainKeys = (
    <>
      <Kbd>{modKey}</Kbd>
      <Kbd>↵</Kbd>
    </>
  )
  const altKeys = (
    <>
      <Kbd>{modKey}</Kbd>
      <Kbd>⇧</Kbd>
      <Kbd>↵</Kbd>
    </>
  )

  return (
    <div className="flex items-center gap-2">
      {connections.length > 0 ? (
        <Select value={connectionId ?? undefined} onValueChange={onConnectionChange}>
          <SelectTrigger size="sm" className="w-52 text-xs">
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

      <span className="mx-1 h-5 w-px bg-rule" />

      {dml && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-default items-center gap-1 text-[12px] text-heat-medium">
              <Undo2Icon className="size-3.5" /> {dml} rolls back
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">
            Profile really runs this {dml}, then rolls the transaction back, so no data changes. Rows stay locked while
            it runs. Use Explain to avoid executing it at all.
          </TooltipContent>
        </Tooltip>
      )}

      <ActionButton
        mode={secondary}
        primary={false}
        running={runningMode === secondary}
        disabled={!canRun || busy}
        onRun={onRun}
        shortcut={altKeys}
      />
      <ActionButton
        mode={primary}
        primary
        running={runningMode === primary}
        disabled={!canRun || busy}
        onRun={onRun}
        shortcut={mainKeys}
      />
    </div>
  )
}
