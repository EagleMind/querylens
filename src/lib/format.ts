export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  if (ms >= 100) return `${ms.toFixed(0)} ms`
  if (ms >= 10) return `${ms.toFixed(1)} ms`
  if (ms >= 0.01) return `${ms.toFixed(2)} ms`
  return ms === 0 ? '0 ms' : '<0.01 ms'
}

export function fmtCount(n: number | null | undefined): string {
  if (n == null) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e4) return `${(n / 1e3).toFixed(0)}k`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function fmtBytes(b: number | null | undefined): string {
  if (b == null) return '—'
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let v = b
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function fmtPct(share: number): string {
  const p = share * 100
  if (p >= 10) return `${p.toFixed(0)}%`
  if (p >= 0.1) return `${p.toFixed(1)}%`
  return p === 0 ? '0%' : '<0.1%'
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function fmtRelative(iso: string): string {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return 'just now'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
  return new Date(iso).toLocaleDateString()
}

/** Row-estimate error factor (≥ 1), or null when not comparable. */
export function estimateFactor(estimated: number | null, actual: number | null): number | null {
  if (estimated == null || actual == null || estimated <= 0) return null
  const hi = Math.max(estimated, actual)
  const lo = Math.max(Math.min(estimated, actual), 1)
  return hi / lo
}
