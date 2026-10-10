import { CheckIcon, ChevronRightIcon, Loader2Icon } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/utils'
import type { Activity } from '@/store/workspace'

function Entry({ a, running }: { a: Activity; running: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="animate-rise">
      <button
        type="button"
        disabled={!a.detail}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 py-1 text-left text-xs disabled:cursor-default"
      >
        {running ? (
          <Loader2Icon className="size-3 shrink-0 animate-spin text-primary" />
        ) : (
          <CheckIcon className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className={cn(running ? 'text-foreground' : 'text-muted-foreground')}>{a.label}</span>
        {a.detail && (
          <ChevronRightIcon
            className={cn('ml-auto size-3 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
        )}
      </button>
      {open && a.detail && (
        <pre
          className="mb-1 ml-5 max-h-40 overflow-auto rounded border bg-background/70 px-2 py-1.5 font-mono text-[10.5px]/relaxed whitespace-pre-wrap text-muted-foreground"
          data-selectable
        >
          {a.detail}
        </pre>
      )}
    </li>
  )
}

/** What the model is doing besides writing: tool calls, reasoning. */
export function ActivityLog({ activities, live }: { activities: Activity[]; live: boolean }) {
  if (!activities.length) return null
  return (
    <ol className="rounded-lg border border-dashed px-3 py-1.5">
      {activities.map((a, i) => (
        <Entry key={a.id} a={a} running={live && i === activities.length - 1} />
      ))}
    </ol>
  )
}
