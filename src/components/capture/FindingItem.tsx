import { ChevronRightIcon, ScanSearchIcon } from 'lucide-react'
import { useState } from 'react'

import type { CaptureFinding } from '@/bindings/CaptureFinding'
import type { FingerprintStat } from '@/bindings/FingerprintStat'
import { CopyButton } from '@/components/shared/CopyButton'
import { Button } from '@/components/ui/button'
import { FINDING_KINDS, ORMS, SEVERITIES } from '@/lib/capture'
import { fmtMs } from '@/lib/format'
import { cn } from '@/lib/utils'

function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="group/code relative rounded-[3px] bg-background">
      {label && (
        <span className="absolute top-2 left-3 text-[10.5px] font-semibold text-muted-foreground">{label}</span>
      )}
      <pre
        className={cn(
          'max-h-72 overflow-auto px-3 py-2.5 pr-20 font-mono text-[12px]/relaxed whitespace-pre-wrap text-foreground/90',
          label && 'pt-6',
        )}
        data-selectable
      >
        {code}
      </pre>
      <CopyButton value={code} className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100" />
    </div>
  )
}

/** One finding of a capture report: what, where, and the fix. */
export function FindingItem({
  finding: f,
  index,
  stat,
  parent,
  onOpen,
}: {
  finding: CaptureFinding
  index: number
  stat?: FingerprintStat
  parent?: FingerprintStat
  /** Open a statement in the Workbench. */
  onOpen?: (stat: FingerprintStat) => void
}) {
  const [open, setOpen] = useState(index < 3)
  const sev = SEVERITIES[f.severity]
  const fix = f.fix

  return (
    <article className="grid grid-cols-[2.25rem_minmax(0,1fr)] border-t border-rule pt-3.5 pb-4">
      <span
        className="font-display text-[22px] leading-none font-semibold text-foreground/35 tabular"
        style={{ fontStretch: '80%' }}
      >
        {String(index + 1).padStart(2, '0')}
      </span>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
          <span className={cn('inline-flex items-center gap-1.5 font-semibold', sev.text)}>
            <span className={cn('size-2 rounded-[1px]', sev.swatch)} />
            {sev.label}
          </span>
          <span className="font-semibold text-foreground/70">{FINDING_KINDS[f.kind]}</span>
          {f.impactMs > 0 && <span className="font-mono text-muted-foreground tabular">{fmtMs(f.impactMs)}</span>}
        </div>

        <button type="button" onClick={() => setOpen(!open)} className="flex items-start gap-1 text-left">
          <ChevronRightIcon
            className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
          <h3 className="text-[14.5px]/snug font-semibold text-pretty">{f.title}</h3>
        </button>

        <p className="text-[13px]/relaxed text-pretty text-foreground/80" data-selectable>
          {f.detail}
        </p>

        {f.origins.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {f.origins.map((o) => (
              <span
                key={o.origin}
                className="rounded-[3px] border border-rule px-1.5 py-0.5 font-mono text-[11.5px] text-foreground/85"
                data-selectable
              >
                {o.origin}
                {o.count > 1 && <span className="text-muted-foreground"> ×{o.count}</span>}
              </span>
            ))}
          </div>
        )}

        {open && (
          <div className="space-y-3 pt-1">
            {stat && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold text-muted-foreground">Statement</span>
                  {onOpen && (
                    <Button size="xs" variant="ghost" onClick={() => onOpen(stat)}>
                      <ScanSearchIcon /> Open in Workbench
                    </Button>
                  )}
                </div>
                <CodeBlock code={stat.sampleSql} />
              </div>
            )}
            {parent && (
              <div className="space-y-1.5">
                <span className="text-[12px] font-semibold text-muted-foreground">Runs once per row of</span>
                <CodeBlock code={parent.sampleSql} />
              </div>
            )}
            {fix && (
              <div className="space-y-2 border-l-2 border-signal pl-3">
                <p className="text-[12px] font-semibold">Fix{fix.orm ? ` · ${ORMS[fix.orm].label}` : ''}</p>
                <p className="text-[13px]/relaxed text-pretty text-foreground/85" data-selectable>
                  {fix.text}
                </p>
                {fix.code && <CodeBlock code={fix.code} />}
                {fix.ddl && <CodeBlock code={`${fix.ddl};`} label="SQL" />}
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
