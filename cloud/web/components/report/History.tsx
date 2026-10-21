// Card 7: this query over the last 24 hours, every run (not only the requests sent), and
// whether it got slower or started failing since the latest release.
import type { QueryShape } from '../../../bindings/QueryShape'
import type { RegressionReport } from '../../../shared/api'
import { ErrorNote } from '@/components/common'
import { Figure, Pairs, ReportCard } from '@/components/report/ReportCard'
import { Skeleton } from '@/components/ui/skeleton'
import { fmtCount, fmtMs } from '@/lib/format'

const pct = (r: number) => `${(r * 100).toFixed(1)}%`

export function History({
  shape,
  report,
  fingerprint,
  error,
}: {
  /** `undefined` while loading, `null` with no statistics yet. */
  shape: QueryShape | null | undefined
  report: RegressionReport | undefined
  fingerprint: string
  error: unknown
}) {
  const regressions = report?.regressions.filter((g) => g.fingerprint === fingerprint) ?? []
  const since = report?.baseline.kind === 'release' ? `since release ${report.baseline.release}` : 'over the last day'
  return (
    <ReportCard
      label="This query, last 24 hours"
      details={
        shape ? (
          <Pairs
            items={[
              ['Total time', fmtMs(shape.totalMs)],
              ['Rows', `${fmtCount(shape.rows)} returned or written`],
              ...regressions.flatMap((g): [string, string][] => [
                [
                  report?.baseline.kind === 'release' ? `Before ${report.baseline.release}` : 'The week before',
                  `${fmtCount(g.before.calls)} runs, ${fmtMs(g.before.meanMs)} on average, ${pct(g.before.errorRate)} failing`,
                ],
                [
                  report?.baseline.kind === 'release' ? `Since ${report.baseline.release}` : 'The last day',
                  `${fmtCount(g.after.calls)} runs, ${fmtMs(g.after.meanMs)} on average, ${pct(g.after.errorRate)} failing`,
                ],
              ]),
              ['Counted from', 'every run of this query, from the statistics the SDK sends each minute (or 5 in production)'],
            ]}
          />
        ) : undefined
      }
      detailsLabel="Details: totals, release comparison"
    >
      {error ? (
        <ErrorNote error={error} />
      ) : shape === undefined ? (
        <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : shape === null ? (
        <p className="text-sm text-muted-foreground">No statistics for this query yet. The SDK sends them every minute (every 5 in production).</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4">
          <Figure label="Runs" value={fmtCount(shape.calls)} />
          <Figure label="Average" value={fmtMs(shape.meanMs)} />
          <Figure label="Slowest" value={fmtMs(shape.maxMs)} />
          <Figure label="Failed" value={fmtCount(shape.errors)} flag={shape.errors > 0 ? 'danger' : undefined} />
        </div>
      )}
      {regressions.map((g) => (
        <p key={g.regression} className="flex items-start gap-2 text-sm">
          <span className={`mt-1.5 size-2 shrink-0 rounded-full ${g.regression === 'failing' ? 'bg-destructive' : 'bg-warning'}`} aria-hidden />
          {g.regression === 'slower'
            ? `Slower ${since}: ${fmtMs(g.before.meanMs)} per run before, ${fmtMs(g.after.meanMs)} now.`
            : `Failing more ${since}: ${pct(g.before.errorRate)} of runs before, ${pct(g.after.errorRate)} now.`}
        </p>
      ))}
    </ReportCard>
  )
}
