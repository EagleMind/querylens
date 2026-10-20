import { useEffect, useRef, useState } from 'react'

import type { Minute } from '../lib/live'
import { fmtCount, fmtMs } from '../lib/format'

const SLOTS = 30
const HEIGHT = 120
/** Room above the plot for the top tick label. */
const TOP = 8
const AXIS = 34
const MINUTE = 60_000

function niceMax(v: number): number {
  if (v <= 0) return 10
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

/** Statements per minute over the last half hour, from the SDKs' statistics reports. */
export function ThroughputChart({ minutes }: { minutes: Minute[] }) {
  const [hover, setHover] = useState<number | null>(null)
  // Drawn at its real pixel width, so labels keep their size on a phone.
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const end = Math.floor(Date.now() / MINUTE) * MINUTE
  const slots = Array.from({ length: SLOTS }, (_, i) => {
    const at = end - (SLOTS - 1 - i) * MINUTE
    return minutes.find((m) => m.at === at) ?? { at, statements: 0, dbMs: 0, errors: 0 }
  })
  const max = niceMax(Math.max(...slots.map((s) => s.statements)))
  const band = (width - AXIS) / SLOTS
  const bar = Math.min(24, band - 2)
  const y = (v: number) => TOP + (HEIGHT - TOP) - (v / max) * (HEIGHT - TOP)
  const shown = hover === null ? null : slots[hover]

  return (
    <figure className="rounded-[3px] border border-rule bg-panel p-4">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-semibold">Statements per minute</span>
        <span className="text-[11.5px] text-muted">last 30 minutes · every statement, from SDK statistics</span>
      </figcaption>
      <div ref={box} className="relative mt-3">
        <svg viewBox={`0 0 ${width} ${HEIGHT + 18}`} className="block h-auto w-full" role="img" aria-label="Statements per minute, last 30 minutes">
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={AXIS} x2={width} y1={y(max * f)} y2={y(max * f)} stroke="var(--rule)" strokeWidth="1" />
              <text x={AXIS - 6} y={y(max * f) + 3.5} textAnchor="end" className="fill-muted text-[10px] tabular">
                {fmtCount(max * f)}
              </text>
            </g>
          ))}
          {slots.map((s, i) => {
            const x = AXIS + i * band + (band - bar) / 2
            const top = y(s.statements)
            const h = HEIGHT - top
            const r = Math.min(4, h)
            return (
              <g key={s.at} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                {/* The hit target is the whole column, not just the bar. */}
                <rect x={AXIS + i * band} y={0} width={band} height={HEIGHT} fill="transparent" />
                {h > 0 && (
                  <path
                    d={`M${x},${HEIGHT} V${top + r} Q${x},${top} ${x + r},${top} H${x + bar - r} Q${x + bar},${top} ${x + bar},${top + r} V${HEIGHT} Z`}
                    fill="var(--bar)"
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                )}
              </g>
            )
          })}
          <line x1={AXIS} x2={width} y1={HEIGHT} y2={HEIGHT} stroke="var(--border)" strokeWidth="1" />
          <text x={AXIS} y={HEIGHT + 14} className="fill-muted text-[10px]">
            −30 min
          </text>
          <text x={width} y={HEIGHT + 14} textAnchor="end" className="fill-muted text-[10px]">
            now
          </text>
        </svg>
        {shown && hover !== null && (
          <div
            className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-[3px] border border-border bg-raised px-2.5 py-1.5 text-[12px] shadow-lg"
            style={{ left: `${((AXIS + (hover + 0.5) * band) / width) * 100}%` }}
          >
            <p className="font-semibold tabular">{fmtCount(shown.statements)} statements</p>
            <p className="text-muted tabular">
              {fmtMs(shown.dbMs)} DB time{shown.errors >= 0.5 ? ` · ${fmtCount(shown.errors)} failed` : ''}
            </p>
            <p className="text-[11px] text-muted">{new Date(shown.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</p>
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>Statements per minute</caption>
        <thead>
          <tr>
            <th>Minute</th>
            <th>Statements</th>
            <th>DB time</th>
            <th>Failed</th>
          </tr>
        </thead>
        <tbody>
          {slots.map((s) => (
            <tr key={s.at}>
              <td>{new Date(s.at).toLocaleTimeString()}</td>
              <td>{s.statements}</td>
              <td>{fmtMs(s.dbMs)}</td>
              <td>{s.errors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
