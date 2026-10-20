// Numbers as the dashboard and the backend's prompts write them.

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '–'
  if (ms < 1) return `${ms.toFixed(2)} ms`
  if (ms < 100) return `${ms.toFixed(1)} ms`
  if (ms < 10_000) return `${Math.round(ms)} ms`
  if (ms < 120_000) return `${(ms / 1000).toFixed(1)} s`
  return `${(ms / 60_000).toFixed(1)} min`
}

export function fmtCount(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}
