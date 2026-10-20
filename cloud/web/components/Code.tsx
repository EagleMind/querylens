// The app's own code: a snippet the SDK sent (source context), and a suggested change to it.
// Both number lines as the file does, so what's shown can be found in the editor.
import { useEffect, useRef } from 'react'

import type { SourceSnippet } from '../../bindings/SourceSnippet'
import { CopyButton } from '@/components/common'
import { cn } from '@/lib/utils'

const ROW = 'grid grid-cols-[3.5rem_minmax(0,1fr)] font-mono text-[12.5px] leading-relaxed'
const GUTTER = 'select-none border-r pr-3 text-right text-muted-foreground tabular'

/** The line `origin` (`file:line`) points at. */
export function originLine(origin: string): number {
  return Number(origin.slice(origin.lastIndexOf(':') + 1))
}

/** The snippet, numbered, its origin's line marked and scrolled into view. */
export function CodeSnippet({ snippet, className }: { snippet: SourceSnippet; className?: string }) {
  const target = originLine(snippet.origin)
  const box = useRef<HTMLDivElement>(null)
  const marked = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Scroll the box only, not the page.
    if (box.current && marked.current) box.current.scrollTop = marked.current.offsetTop - box.current.clientHeight / 2
  }, [snippet])
  return (
    <div ref={box} className={cn('relative max-h-72 overflow-auto rounded-md border bg-muted/40 py-2', className)}>
      {snippet.lines.map((line, i) => {
        const n = snippet.firstLine + i
        const here = n === target
        return (
          <div
            key={n}
            ref={here ? marked : undefined}
            aria-current={here ? 'true' : undefined}
            className={cn(ROW, here && 'bg-primary/[0.09] shadow-[inset_2px_0_0_var(--primary)]')}
          >
            <span className={cn(GUTTER, here && 'font-semibold text-primary')}>{n}</span>
            <span className="pl-3 pr-3 whitespace-pre">{line || ' '}</span>
          </div>
        )
      })}
    </div>
  )
}

/** A change to `file`: the lines replaced from `line` on, then their replacement. */
export function CodeChange({ file, line, before, after }: { file: string; line: number; before: string; after: string }) {
  const removed = before.split('\n')
  const added = after.split('\n')
  return (
    <div className="min-w-0 overflow-hidden rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 py-1 pr-1 pl-3">
        <code className="min-w-0 truncate font-mono text-xs font-medium" title={`${file}:${line}`}>
          {file}:{line}
        </code>
        <CopyButton value={after} label="Copy the new code" />
      </div>
      <div className="overflow-x-auto py-2" role="group" aria-label="Suggested change">
        {removed.map((text, i) => (
          <div key={`-${i}`} className={cn(ROW, 'bg-destructive/[0.08]')}>
            <span className={GUTTER}>{line + i}</span>
            <span className="pr-3 pl-1.5 whitespace-pre">
              <span className="mr-1.5 text-destructive select-none" aria-label="removed">−</span>
              {text}
            </span>
          </div>
        ))}
        {added.map((text, i) => (
          <div key={`+${i}`} className={cn(ROW, 'bg-success/[0.09]')}>
            <span className={GUTTER}>{line + i}</span>
            <span className="pr-3 pl-1.5 whitespace-pre">
              <span className="mr-1.5 text-success select-none" aria-label="added">+</span>
              {text}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
