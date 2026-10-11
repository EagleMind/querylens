/**
 * Capture commands for the browser-only mock backend. The report fixture is real:
 * `querylens report <id> --json` on a capture of `dev/sequelize-demo`'s tests.
 */
import type { CaptureLive } from '@/bindings/CaptureLive'
import type { CaptureReport } from '@/bindings/CaptureReport'
import type { CaptureSummary } from '@/bindings/CaptureSummary'
import type { CapturedStatement } from '@/bindings/CapturedStatement'

import fixture from './fixtures/capture-report.json'

const demoReport = fixture as unknown as CaptureReport
const reports = new Map<string, CaptureReport>([[demoReport.capture.id, demoReport]])
const running = new Map<string, { live: CaptureLive; startedAt: number }>()

export const UNHANDLED = Symbol('unhandled')

function summaries(): CaptureSummary[] {
  const live = [...running.values()].map(({ live }) => ({
    ...demoReport.capture,
    id: live.id,
    name: 'dev-shop · recording',
    stoppedAt: null,
  }))
  return [...live, ...[...reports.values()].map((r) => r.capture)]
}

/** Grow the live counters as if the app were sending traffic. */
function tick(entry: { live: CaptureLive; startedAt: number }): CaptureLive {
  const seconds = (Date.now() - entry.startedAt) / 1000
  const statements = Math.floor(seconds * 7)
  const samples = demoReport.fingerprints
  const recent: CapturedStatement[] = Array.from({ length: Math.min(statements, 40) }, (_, i) => {
    const s = samples[(statements - i) % samples.length]
    return {
      seq: statements - i,
      conn: 1 + (i % 3),
      atMs: seconds * 1000 - i * 140,
      durationMs: s.meanMs,
      fingerprint: s.fingerprint,
      sql: s.sampleSql,
      params: s.sampleParams,
      rows: s.rows / s.calls,
      bytes: s.bytes / s.calls,
      error: null,
      unit: null,
      origin: s.origins[0]?.origin ?? null,
      route: null,
    }
  })
  return { ...entry.live, statements, totalMs: statements * 19.4, sdkProcesses: statements > 0 ? 1 : 0, recent }
}

export function mockCapture(command: string, args: Record<string, unknown>): unknown {
  switch (command) {
    case 'start_capture': {
      const id = crypto.randomUUID()
      const port = (args.port as number | null) ?? 6543
      const live: CaptureLive = {
        id,
        statements: 0,
        totalMs: 0,
        errors: 0,
        openConnections: 0,
        totalConnections: 0,
        sdkProcesses: 0,
        appUrl: `postgres://querylens@127.0.0.1:${port}/shop?sslmode=disable`,
        collectorUrl: 'http://127.0.0.1:7343',
        recent: [],
      }
      running.set(id, { live, startedAt: Date.now() })
      return live
    }
    case 'stop_capture': {
      const id = args.id as string
      running.delete(id)
      const report: CaptureReport = {
        ...demoReport,
        capture: { ...demoReport.capture, id, name: 'dev-shop · just now', startedAt: new Date().toISOString() },
      }
      reports.set(id, report)
      return report
    }
    case 'running_captures':
      return [...running.values()].map(tick)
    case 'capture_live': {
      const entry = running.get(args.id as string)
      return entry ? tick(entry) : null
    }
    case 'list_captures':
      return summaries()
    case 'capture_report': {
      const report = reports.get(args.id as string)
      if (!report) throw { kind: 'not_found', message: 'Capture not found' }
      return args.profile
        ? { ...report, planChecks: report.planChecks.map((c) => ({ ...c, mode: 'analyze' as const })) }
        : report
    }
    case 'capture_executions':
      return []
    case 'delete_capture':
      reports.delete(args.id as string)
      running.delete(args.id as string)
      return null
    default:
      return UNHANDLED
  }
}
