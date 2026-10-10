import { Input } from '@/components/ui/input'
import { useWorkspace } from '@/store/workspace'

/** Inputs for `$1…$n` placeholders, shown under the editor when the SQL has them. */
export function ParamsBar({ count }: { count: number }) {
  const params = useWorkspace((s) => s.params)
  const setParam = useWorkspace((s) => s.setParam)
  if (count === 0) return null
  return (
    <div className="flex shrink-0 items-center gap-3 overflow-x-auto border-t border-rule bg-panel px-3 py-2">
      <span className="shrink-0 text-[12px] font-semibold text-muted-foreground">Parameters</span>
      {Array.from({ length: count }, (_, i) => (
        <label key={i} className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[12px] text-signal">${i + 1}</span>
          <Input
            value={params[i] ?? ''}
            onChange={(e) => setParam(i, e.target.value)}
            placeholder="value"
            className="h-7 w-36 font-mono text-xs"
          />
        </label>
      ))}
      <span className="shrink-0 text-[11.5px] text-muted-foreground">Type NULL for a null value.</span>
    </div>
  )
}
