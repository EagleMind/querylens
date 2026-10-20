import { DatabaseIcon } from 'lucide-react'
import { useState } from 'react'

import type { Project } from '../../../src/bindings/Project'
import { Empty, ErrorNote, Segmented, Select } from '../components/ui'
import { api } from '../lib/api'
import { fmtCount, fmtMs, fmtRelative } from '../lib/format'
import { useAsync } from '../lib/useAsync'

const PERIODS = [
  { value: '1', label: '1h' },
  { value: '24', label: '24h' },
  { value: '168', label: '7d' },
  { value: '720', label: '30d' },
] as const

/** Statement shapes by total time: where the database time goes, every statement counted. */
export function QueriesPage({ project, refreshKey }: { project: Project; refreshKey: number }) {
  const [hours, setHours] = useState<string>('24')
  const [env, setEnv] = useState('')
  const environments = useAsync(() => api.environments(project.id), [project.id, refreshKey])
  const shapes = useAsync(
    () => api.queries(project.id, { hours: Number(hours), environment: env || undefined }),
    [project.id, hours, env, refreshKey],
  )
  const rows = shapes.data ?? []
  const total = rows.reduce((n, r) => n + r.totalMs, 0)

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Period" value={hours} onChange={setHours} options={PERIODS.map((p) => ({ ...p }))} />
        {(environments.data?.length ?? 0) > 1 && (
          <Select label="Environment" value={env} onChange={setEnv}>
            <option value="">All environments</option>
            {environments.data?.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </Select>
        )}
        <p className="ml-auto text-[12px] text-muted">From the SDKs’ per-minute statistics, values removed.</p>
      </div>
      <ErrorNote error={shapes.error} />
      {rows.length === 0 && !shapes.loading ? (
        <Empty title="No statistics yet" icon={<DatabaseIcon />}>
          Each SDK reports totals for every statement shape once a minute.
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-[3px] border border-rule bg-panel">
          <table className="w-full min-w-[760px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-rule text-left text-[11.5px] text-muted">
                <th className="px-3 py-2 font-medium">Statement</th>
                <th className="w-24 px-3 py-2 text-right font-medium">Calls</th>
                <th className="w-32 px-3 py-2 text-right font-medium">Total time</th>
                <th className="w-24 px-3 py-2 text-right font-medium">Mean</th>
                <th className="w-24 px-3 py-2 text-right font-medium">Max</th>
                <th className="w-20 px-3 py-2 text-right font-medium">Failed</th>
                <th className="w-24 px-3 py-2 text-right font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const share = total > 0 ? r.totalMs / total : 0
                return (
                  <tr key={r.fingerprint} className="border-b border-rule/60 align-top last:border-0">
                    <td className="px-3 py-2">
                      <code className="line-clamp-2 font-mono text-[12px] break-all text-foreground/85" title={r.sampleSql}>
                        {r.sampleSql}
                      </code>
                      {r.tables.length > 0 && <p className="mt-0.5 text-[11.5px] text-muted">{r.tables.join(', ')}</p>}
                    </td>
                    <td className="px-3 py-2 text-right tabular">{fmtCount(r.calls)}</td>
                    <td className="px-3 py-2 text-right tabular">
                      {fmtMs(r.totalMs)}
                      <div className="mt-1 ml-auto h-1 w-20 rounded-full bg-rule" aria-hidden>
                        <div className="h-1 rounded-full bg-bar" style={{ width: `${Math.max(2, share * 100)}%` }} />
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-muted tabular">{fmtMs(r.meanMs)}</td>
                    <td className="px-3 py-2 text-right text-muted tabular">{fmtMs(r.maxMs)}</td>
                    <td className={`px-3 py-2 text-right tabular ${r.errors > 0 ? 'text-danger' : 'text-muted'}`}>{fmtCount(r.errors)}</td>
                    <td className="px-3 py-2 text-right text-muted">{fmtRelative(r.lastSeen)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
