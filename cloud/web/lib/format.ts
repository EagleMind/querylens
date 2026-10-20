import type { SuggestionSeverity } from '../../bindings/SuggestionSeverity'

export { FINDING_KINDS, ORMS } from '../../shared/labels'
export { fmtCount, fmtMs } from '../../shared/format'

export function fmtRelative(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** 14:02:11.482 */
export function fmtTime(epochMs: number): string {
  const d = new Date(epochMs)
  const hms = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  return `${hms}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

export function fmtDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' })
}

export const SEVERITY: Record<SuggestionSeverity, { label: string; dot: string }> = {
  high: { label: 'High', dot: 'bg-destructive' },
  medium: { label: 'Medium', dot: 'bg-warning' },
  low: { label: 'Low', dot: 'bg-muted-foreground' },
}
