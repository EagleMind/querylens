import type { CaptureLive } from '@/bindings/CaptureLive'
import type { CaptureSummary } from '@/bindings/CaptureSummary'
import { PaneLabel } from '@/components/shared/bits'
import { fmtCount, fmtMs, fmtRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

function Item({
  active,
  onClick,
  title,
  meta,
  live,
}: {
  active: boolean
  onClick: () => void
  title: string
  meta: string
  live?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative w-full border-b border-rule px-4 py-2.5 text-left hover:bg-accent/40',
        active && 'bg-accent/50 before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:bg-signal',
      )}
    >
      <div className="flex items-center gap-2">
        {live && <span className="size-2 shrink-0 animate-pulse rounded-full bg-heat-high" />}
        <p className="truncate text-[13px] font-medium">{title}</p>
      </div>
      <p className="truncate font-mono text-[11px] text-muted-foreground">{meta}</p>
    </button>
  )
}

/** Running captures, then recent ones. */
export function CaptureList({
  running,
  captures,
  selected,
  onSelect,
}: {
  running: CaptureLive[]
  captures: CaptureSummary[]
  selected: string | null
  onSelect: (id: string) => void
}) {
  const runningIds = new Set(running.map((r) => r.id))
  const finished = captures.filter((c) => !runningIds.has(c.id))
  const names = new Map(captures.map((c) => [c.id, c.name]))

  return (
    <div>
      {running.length > 0 && (
        <>
          <PaneLabel className="block px-4 pt-3 pb-1.5">Recording</PaneLabel>
          {running.map((r) => (
            <Item
              key={r.id}
              live
              active={selected === r.id}
              onClick={() => onSelect(r.id)}
              title={names.get(r.id) ?? 'Capture'}
              meta={`${fmtCount(r.statements)} statements · ${fmtMs(r.totalMs)}`}
            />
          ))}
        </>
      )}
      <PaneLabel className="block px-4 pt-3 pb-1.5">Recent</PaneLabel>
      {finished.length === 0 && <p className="px-4 text-[12px] text-muted-foreground">No captures yet.</p>}
      {finished.map((c) => (
        <Item
          key={c.id}
          active={selected === c.id}
          onClick={() => onSelect(c.id)}
          title={c.name}
          meta={`${fmtRelative(c.startedAt)} · ${fmtCount(c.statements)} statements · ${c.source}`}
        />
      ))}
    </div>
  )
}
