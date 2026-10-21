// Values edited in place, shared by the Project and Settings pages.
import { PencilIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'

import { CopyButton, ErrorNote } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/** Runs a change, tracking whether it's in flight and how it failed. */
export function useChange() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const run = async (change: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await change()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

/** A value shown with copy and edit buttons, edited in place. */
export function EditableValue({
  value,
  label,
  accent,
  editor,
}: {
  value: string
  label: string
  accent?: boolean
  editor: (close: () => void) => ReactNode
}) {
  const [editing, setEditing] = useState(false)
  if (editing) return <>{editor(() => setEditing(false))}</>
  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-md border py-1 pr-1 pl-3',
        accent ? 'border-primary/25 bg-primary/[0.06]' : 'bg-muted/40',
      )}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={value}>
        {value}
      </code>
      <CopyButton value={value} label={`Copy ${label}`} />
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setEditing(true)}>
        <PencilIcon /> Edit
      </Button>
    </div>
  )
}

/** Save / cancel row for the inline editors. */
export function EditorActions({ busy, onCancel, children }: { busy: boolean; onCancel: () => void; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}
      <span className="ml-auto flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          Save
        </Button>
      </span>
    </div>
  )
}

/** A name edited in place (the project's or a service's). */
export function NameEditor({ id, label, current, save, close }: { id: string; label: string; current: string; save: (name: string) => Promise<void>; close: () => void }) {
  const [value, setValue] = useState(current)
  const { busy, error, run } = useChange()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value.trim() === current) close()
    else
      void run(async () => {
        await save(value.trim())
        close()
      })
  }
  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid gap-2">
        <Label htmlFor={id}>{label}</Label>
        <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </div>
      <ErrorNote error={error} />
      <EditorActions busy={busy || !value.trim()} onCancel={close} />
    </form>
  )
}
