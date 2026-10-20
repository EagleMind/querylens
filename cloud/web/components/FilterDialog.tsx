import { PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  type Condition,
  type CustomFilter,
  FIELD_KEYS,
  FIELDS,
  type FieldKey,
  OPERATORS,
  type Operator,
  isComplete,
  matchesFilter,
  newCondition,
} from '@/lib/filters'
import type { LiveQuery } from '@/lib/queries'

function blank(): CustomFilter {
  return { id: crypto.randomUUID(), name: '', match: 'all', conditions: [newCondition()] }
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
  removable,
}: {
  condition: Condition
  onChange: (c: Condition) => void
  onRemove: () => void
  removable: boolean
}) {
  const field = FIELDS[condition.field]
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:grid-cols-[9.5rem_9.5rem_minmax(0,1fr)_auto]">
      <Select value={condition.field} onValueChange={(v) => onChange(newCondition(v as FieldKey))}>
        <SelectTrigger className="w-full" aria-label="Field">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FIELD_KEYS.map((k) => (
            <SelectItem key={k} value={k}>
              {FIELDS[k].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground sm:order-last"
        aria-label="Remove condition"
        disabled={!removable}
        onClick={onRemove}
      >
        <XIcon />
      </Button>
      <Select value={condition.op} onValueChange={(v) => onChange({ ...condition, op: v as Operator })}>
        <SelectTrigger className="w-full" aria-label="Operator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {field.ops.map((op) => (
            <SelectItem key={op} value={op}>
              {OPERATORS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="col-span-2 sm:col-span-1">
        {field.input.kind === 'choice' ? (
          <Select value={condition.value} onValueChange={(v) => onChange({ ...condition, value: v })}>
            <SelectTrigger className="w-full" aria-label="Value">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {field.input.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="relative">
            <Input
              aria-label="Value"
              value={condition.value}
              onChange={(e) => onChange({ ...condition, value: e.target.value })}
              inputMode={field.input.kind === 'number' ? 'decimal' : undefined}
              placeholder={field.input.kind === 'text' ? field.input.placeholder : '0'}
              className={field.input.kind === 'number' ? 'pr-12 tabular' : undefined}
            />
            {field.input.kind === 'number' && (
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                {field.input.unit}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Create or edit a custom filter. `queries` is the current list, for the match count. */
export function FilterDialog({
  open,
  onOpenChange,
  editing,
  queries,
  onSave,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: CustomFilter | null
  queries: LiveQuery[]
  onSave: (f: CustomFilter) => void
  onDelete: (id: string) => void
}) {
  const [draft, setDraft] = useState<CustomFilter>(blank)
  useEffect(() => {
    if (open) setDraft(editing ? structuredClone(editing) : blank())
  }, [open, editing])

  const complete = draft.conditions.filter(isComplete)
  const valid = draft.name.trim() !== '' && complete.length > 0
  const matching = useMemo(
    () => (complete.length ? queries.filter((q) => matchesFilter(q, draft)).length : null),
    [queries, draft, complete.length],
  )

  const setCondition = (i: number, c: Condition) =>
    setDraft((d) => ({ ...d, conditions: d.conditions.map((x, n) => (n === i ? c : x)) }))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    onSave({ ...draft, name: draft.name.trim(), conditions: complete })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit filter' : 'New filter'}</DialogTitle>
            <DialogDescription>Saved in this browser. It appears next to the built-in views on the Live page.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="filter-name">Name</Label>
            <Input
              id="filter-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Slow checkout queries"
              autoFocus
            />
          </div>

          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Show queries that match</span>
              <Select value={draft.match} onValueChange={(v) => setDraft({ ...draft, match: v as CustomFilter['match'] })}>
                <SelectTrigger size="sm" aria-label="Match">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all</SelectItem>
                  <SelectItem value="any">any</SelectItem>
                </SelectContent>
              </Select>
              <span>of these conditions</span>
            </div>
            <div className="grid gap-3">
              {draft.conditions.map((c, i) => (
                <ConditionRow
                  key={i}
                  condition={c}
                  onChange={(next) => setCondition(i, next)}
                  onRemove={() => setDraft((d) => ({ ...d, conditions: d.conditions.filter((_, n) => n !== i) }))}
                  removable={draft.conditions.length > 1}
                />
              ))}
            </div>
            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDraft((d) => ({ ...d, conditions: [...d.conditions, newCondition()] }))}
              >
                <PlusIcon /> Add condition
              </Button>
              {matching !== null && (
                <span className="text-sm text-muted-foreground tabular">
                  Matches {matching} of {queries.length} queries in the list
                </span>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  onDelete(editing.id)
                  onOpenChange(false)
                }}
              >
                <Trash2Icon /> Delete filter
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid}>
                {editing ? 'Save changes' : 'Save filter'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
