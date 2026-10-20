import { CheckIcon, CopyIcon } from 'lucide-react'
import { type ButtonHTMLAttributes, type ReactNode, useState } from 'react'

import type { SuggestionSeverity } from '../../bindings/SuggestionSeverity'
import { SEVERITY } from '../lib/format'

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'ghost' | 'outline'

export function Button({
  variant = 'outline',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[3px] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'bg-signal text-signal-ink hover:bg-signal/90',
        variant === 'outline' && 'border border-border bg-panel hover:bg-raised',
        variant === 'ghost' && 'text-foreground/80 hover:bg-raised hover:text-foreground',
        className,
      )}
    />
  )
}

export function Severity({ severity, className }: { severity: SuggestionSeverity; className?: string }) {
  const s = SEVERITY[severity]
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-[12px] font-semibold', s.text, className)}>
      <span className={cx('size-2 rounded-[1px]', s.swatch)} />
      {s.label}
    </span>
  )
}

export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size="sm"
      variant="ghost"
      className={className}
      aria-label={label ?? 'Copy'}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      {label}
    </Button>
  )
}

export function CodeBlock({ code, label, className }: { code: string; label?: string; className?: string }) {
  return (
    <div className={cx('group relative rounded-[3px] border border-rule bg-background', className)}>
      {label && <span className="absolute top-2 left-3 text-[10.5px] font-semibold text-muted">{label}</span>}
      <pre
        className={cx(
          'max-h-80 overflow-auto px-3 py-2.5 pr-12 font-mono text-[12px]/relaxed whitespace-pre-wrap break-words text-foreground/90',
          label && 'pt-6',
        )}
      >
        {code}
      </pre>
      <CopyButton value={code} className="absolute top-1.5 right-1.5 opacity-60 group-hover:opacity-100" />
    </div>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[3px] border border-border bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-7 rounded-[2px] px-2.5 text-[12.5px] font-medium transition-colors',
            value === o.value ? 'bg-raised text-foreground' : 'text-muted hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Select({
  value,
  onChange,
  label,
  children,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  children: ReactNode
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-[3px] border border-border bg-panel px-2 text-[13px] text-foreground"
    >
      {children}
    </select>
  )
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="blueprint flex flex-col items-center justify-center gap-2 rounded-[3px] border border-dashed border-border px-6 py-14 text-center">
      {icon && <div className="text-muted [&_svg]:size-6">{icon}</div>}
      <p className="font-display text-[16px] font-semibold">{title}</p>
      {children && <div className="max-w-md text-[13px]/relaxed text-muted">{children}</div>}
    </div>
  )
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[3px] border border-rule bg-panel px-4 py-3">
      <p className="text-[12px] text-muted">{label}</p>
      <p className="mt-1 text-[22px] font-semibold tabular">{value}</p>
      {hint && <p className="mt-0.5 text-[11.5px] text-muted">{hint}</p>}
    </div>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p role="alert" className="rounded-[3px] border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
      {error instanceof Error ? error.message : String(error)}
    </p>
  )
}
