// Regressions per statement shape: which statements got slower, or started failing, since the
// latest release (or, without releases, over the last day), from the hourly statistics the
// SDKs send for every statement. Statistics, not a model: a shape is compared with itself,
// before and after, and only with enough calls on both sides to mean something.
// Pure: the Durable Object gathers the totals; this decides what they show.
import type { StatementKind } from '../../bindings/StatementKind'
import type { Baseline, Regression, ShapeWindow } from '../../shared/api'

export const HOUR_MS = 3_600_000
/** How far back the "before" side reaches. */
export const BEFORE_HOURS = 7 * 24
/** Without releases: the last day is compared with the week before it. */
export const WINDOW_HOURS = 24

export interface Rules {
  /** Calls needed on each side for a shape to be compared at all. */
  minCalls: number
  /** Slower: the mean at least this many times the mean before… */
  slowerRatio: number
  /** …and at least this many ms more per call. */
  slowerMinDeltaMs: number
  /** Failing: at least this share of calls failing now… */
  failingMinRate: number
  /** …and this many failures… */
  failingMinErrors: number
  /** …and at least this many times the share before (plus half a percent, for shapes that never failed). */
  failingRatio: number
}

export const RULES: Rules = {
  minCalls: 30,
  slowerRatio: 1.5,
  slowerMinDeltaMs: 2,
  failingMinRate: 0.01,
  failingMinErrors: 5,
  failingRatio: 2,
}

/** Raw totals of one side of the comparison. */
export interface SideTotals {
  calls: number
  totalMs: number
  errors: number
  hours: number
}

export interface ShapeTotals {
  fingerprint: string
  sampleSql: string
  kind: StatementKind
  tables: string[]
  before: SideTotals
  after: SideTotals
}

export interface ReleaseSeen {
  release: string
  firstSeenMs: number
}

/** The baseline, and the hours (epoch hours, inclusive start) each side covers. */
export interface Comparison {
  baseline: Baseline
  beforeFrom: number
  /** First hour after the "before" side; the deploy's own hour is left out of both. */
  beforeTo: number
  afterFrom: number
}

/**
 * Compare across the latest release when the environment reports releases, else the last
 * day against the week before. `releases`: newest first.
 */
export function comparison(releases: ReleaseSeen[], nowMs: number): Comparison {
  const nowHour = Math.floor(nowMs / HOUR_MS)
  const [latest, previous] = releases
  if (latest) {
    const deployHour = Math.floor(latest.firstSeenMs / HOUR_MS)
    return {
      baseline: {
        kind: 'release',
        release: latest.release,
        previous: previous?.release ?? null,
        since: new Date(latest.firstSeenMs).toISOString(),
      },
      beforeFrom: deployHour - BEFORE_HOURS,
      beforeTo: deployHour,
      afterFrom: deployHour + 1,
    }
  }
  const split = nowHour - WINDOW_HOURS + 1
  return {
    baseline: { kind: 'window', since: new Date(split * HOUR_MS).toISOString() },
    beforeFrom: split - BEFORE_HOURS,
    beforeTo: split,
    afterFrom: split,
  }
}

function side(t: SideTotals): ShapeWindow {
  return {
    calls: t.calls,
    meanMs: t.calls > 0 ? t.totalMs / t.calls : 0,
    errorRate: t.calls > 0 ? t.errors / t.calls : 0,
    hours: t.hours,
  }
}

/** The regressions among `shapes`, the costliest first. */
export function judge(shapes: ShapeTotals[], rules: Rules = RULES): Omit<Regression, 'latest'>[] {
  const found: Omit<Regression, 'latest'>[] = []
  for (const s of shapes) {
    if (s.before.calls < rules.minCalls || s.after.calls < rules.minCalls) continue
    const before = side(s.before)
    const after = side(s.after)
    const perHour = after.calls / Math.max(1, after.hours)
    const base = { fingerprint: s.fingerprint, sampleSql: s.sampleSql, kind: s.kind, tables: s.tables, before, after }

    const delta = after.meanMs - before.meanMs
    if (after.meanMs >= before.meanMs * rules.slowerRatio && delta >= rules.slowerMinDeltaMs) {
      found.push({ ...base, regression: 'slower', costPerHour: delta * perHour })
    }
    if (
      after.errorRate >= rules.failingMinRate &&
      s.after.errors >= rules.failingMinErrors &&
      after.errorRate >= before.errorRate * rules.failingRatio + 0.005
    ) {
      found.push({ ...base, regression: 'failing', costPerHour: (after.errorRate - before.errorRate) * perHour })
    }
  }
  // Failures first (they break things), then by cost.
  return found.sort((a, b) => (a.regression === b.regression ? b.costPerHour - a.costPerHour : a.regression === 'failing' ? -1 : 1))
}
