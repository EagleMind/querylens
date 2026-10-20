import type { CapturedStatement } from '../../../src/bindings/CapturedStatement'
import { fmtCount, fmtMs } from '../lib/format'
import { cx } from './ui'

/** A request's statements in order: what ran, how long, how many rows, from where. */
export function Statements({ statements, highlight }: { statements: CapturedStatement[]; highlight?: string }) {
  const max = Math.max(...statements.map((s) => s.durationMs), 0.001)
  return (
    <div className="overflow-x-auto rounded-[3px] border border-rule">
      <table className="w-full min-w-[640px] border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-rule text-left text-[11.5px] text-muted">
            <th className="w-10 px-3 py-1.5 font-medium">#</th>
            <th className="px-3 py-1.5 font-medium">Statement</th>
            <th className="w-28 px-3 py-1.5 text-right font-medium">Time</th>
            <th className="w-16 px-3 py-1.5 text-right font-medium">Rows</th>
            <th className="w-48 px-3 py-1.5 font-medium">Origin</th>
          </tr>
        </thead>
        <tbody>
          {statements.map((s) => (
            <tr
              key={s.seq}
              className={cx(
                'border-b border-rule/60 align-top last:border-0',
                highlight && s.fingerprint === highlight && 'bg-sev-medium/[0.06]',
              )}
            >
              <td className="px-3 py-1.5 text-muted tabular">{s.seq}</td>
              <td className="px-3 py-1.5">
                <code className="line-clamp-2 font-mono text-[11.5px] break-all text-foreground/85" title={s.sql}>
                  {s.sql}
                </code>
                {s.error && <p className="mt-0.5 font-mono text-[11px] text-danger">{s.error}</p>}
              </td>
              <td className="px-3 py-1.5 text-right tabular">
                <div className="flex items-center justify-end gap-2">
                  <span
                    aria-hidden
                    className="h-1.5 rounded-full bg-bar/70"
                    style={{ width: `${Math.max(2, (s.durationMs / max) * 40)}px` }}
                  />
                  {fmtMs(s.durationMs)}
                </div>
              </td>
              <td className="px-3 py-1.5 text-right text-muted tabular">{fmtCount(s.rows)}</td>
              <td className="truncate px-3 py-1.5 font-mono text-[11.5px] text-muted" title={s.origin ?? ''}>
                {s.origin ?? '–'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
