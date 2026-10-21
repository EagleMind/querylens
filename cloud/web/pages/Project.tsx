// The project page: its name, the services connected to it (each with its own DSN), the env
// file to give a service, and the limits that decide what gets flagged. Opened from the
// sidebar ("Manage services", under the services).
import { PencilIcon, PlugIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon, UnplugIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import type { Backend } from '../../bindings/Backend'
import type { Project } from '../../bindings/Project'
import type { ProjectSettings } from '../../bindings/ProjectSettings'
import { CodeBlock, ErrorNote } from '@/components/common'
import { EditableValue, EditorActions, NameEditor, useChange } from '@/components/editing'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { ENV_VARS, type EnvChoice, type EnvName, envFile, initialChoice, problem } from '@/lib/env'
import { ORMS, fmtRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

/** A service that reported within this long reads as live. */
const RECENT_MS = 15 * 60_000

function KeyEditor({ project, service, onSaved, close }: { project: Project; service: Backend; onSaved: (p: Project) => void; close: () => void }) {
  const current = service.dsn ? decodeURIComponent(new URL(service.dsn).username) : ''
  const [value, setValue] = useState(current)
  const { busy, error, run } = useChange()
  const save = (key?: string) =>
    run(async () => {
      onSaved(await api.setBackendKey(project.id, service.id, key))
      close()
    })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value.trim() === current) close()
    else void save(value.trim())
  }
  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-3">
      <div className="grid grid-cols-1 gap-2">
        <Label htmlFor={`key-${service.id}`}>Key</Label>
        <Input id={`key-${service.id}`} value={value} onChange={(e) => setValue(e.target.value)} className="font-mono" autoFocus />
      </div>
      <ErrorNote error={error} />
      <EditorActions busy={busy} onCancel={close}>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => save()}>
          <RefreshCwIcon /> Generate a new key
        </Button>
      </EditorActions>
    </form>
  )
}

/** Whether a service is reporting: a dot and a few words. */
function ServiceStatus({ service }: { service: Backend }) {
  const recent = service.lastSeen !== null && Date.now() - Date.parse(service.lastSeen) < RECENT_MS
  const [dot, text] = !service.dsn
    ? ['bg-muted-foreground/40', 'Disconnected']
    : service.lastSeen === null
      ? ['bg-warning', 'Waiting for its first event']
      : [recent ? 'bg-primary' : 'bg-muted-foreground', `Last event ${fmtRelative(service.lastSeen)}`]
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-1.5 rounded-full', dot, recent && 'ring-3 ring-primary/20')} aria-hidden />
      {text}
    </span>
  )
}

function ServiceRow({ project, service, onSaved }: { project: Project; service: Backend; onSaved: (p: Project) => void }) {
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const { busy, error, run } = useChange()
  const disconnect = () =>
    run(async () => {
      onSaved(await api.disconnectBackend(project.id, service.id))
      setConfirming(false)
    })
  const reconnect = () => run(async () => onSaved(await api.setBackendKey(project.id, service.id)))

  return (
    <li className="grid grid-cols-1 gap-3 px-4 py-4 sm:px-5">
      {renaming ? (
        <NameEditor
          id={`service-name-${service.id}`}
          label="Service name"
          current={service.name}
          save={async (name) => onSaved(await api.renameBackend(project.id, service.id, name))}
          close={() => setRenaming(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <p className={cn('text-[15px] font-semibold tracking-tight', !service.dsn && 'text-muted-foreground')}>{service.name}</p>
          <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            <ServiceStatus service={service} />
            {service.orm && <span className="rounded bg-muted px-1.5 py-px">{ORMS[service.orm]}</span>}
          </p>
          <span className="ml-auto flex items-center">
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setRenaming(true)}>
              <PencilIcon /> Rename
            </Button>
            {service.dsn ? (
              <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => setConfirming(true)}>
                <UnplugIcon /> Disconnect
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="text-primary" disabled={busy} onClick={reconnect}>
                <PlugIcon /> Reconnect
              </Button>
            )}
          </span>
        </div>
      )}
      {service.dsn && (
        <EditableValue
          value={service.dsn}
          label={`${service.name} DSN`}
          editor={(close) => <KeyEditor project={project} service={service} onSaved={onSaved} close={close} />}
        />
      )}
      {confirming && (
        <div className="grid grid-cols-1 gap-2 rounded-md border border-destructive/30 bg-destructive/[0.04] p-3 text-sm">
          <p>
            Disconnect <span className="font-medium">{service.name}</span>? Its DSN stops working at once. Its queries and issues stay, and
            reconnecting gives it a new DSN.
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={disconnect}>
              Disconnect
            </Button>
          </div>
        </div>
      )}
      <ErrorNote error={error} />
    </li>
  )
}

/** The list's last row: connect a service, then show what to give it. */
function ConnectService({ project, onSaved }: { project: Project; onSaved: (p: Project) => void }) {
  const first = project.backends.length === 0
  const [name, setName] = useState('')
  const [added, setAdded] = useState<Backend | null>(null)
  const { busy, error, run } = useChange()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const wanted = name.trim()
    void run(async () => {
      const next = await api.addBackend(project.id, wanted)
      onSaved(next)
      setAdded(next.backends.find((b) => b.name === wanted) ?? null)
      setName('')
    })
  }
  return (
    <div className={cn('grid grid-cols-1 gap-3 px-4 py-4 sm:px-5', first ? 'bg-primary/[0.04]' : 'border-t bg-muted/30')}>
      <form onSubmit={submit} className="grid grid-cols-1 gap-2">
        <Label htmlFor="service-name">{first ? 'Connect your first service' : 'Connect another service'}</Label>
        <div className="flex gap-2">
          <Input id="service-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. orders, billing, api" autoFocus={first} />
          <Button type="submit" disabled={busy || !name.trim()}>
            <PlusIcon /> Connect
          </Button>
        </div>
      </form>
      <ErrorNote error={error} />
      {added?.dsn && (
        <div className="grid grid-cols-1 gap-2 rounded-md border border-primary/25 bg-card p-3 text-sm">
          <p>
            <span className="font-medium">{added.name}</span> is connected. In that service, install the SDK, set its DSN and load the SDK
            first:
          </p>
          <CodeBlock code={`npm install querylens-node\nQUERYLENS_DSN=${added.dsn}\n\nrequire('querylens-node/register') // first line of the entry file`} wrap={false} />
        </div>
      )}
    </div>
  )
}

/** Pick a service and the variables to turn on; get the env file to paste into its environment. */
function EnvBuilder({ project }: { project: Project }) {
  const connected = project.backends.filter((b): b is Backend & { dsn: string } => b.dsn !== null)
  const [serviceId, setServiceId] = useState(connected[0]?.id ?? '')
  const [choice, setChoice] = useState<EnvChoice>(initialChoice)
  const service = connected.find((b) => b.id === serviceId) ?? connected[0]
  if (!service) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        Connect a service above, and its environment variables appear here.
      </p>
    )
  }
  const set = (name: EnvName, patch: Partial<{ on: boolean; value: string }>) =>
    setChoice((c) => ({ ...c, [name]: { on: false, value: '', ...c[name], ...patch } }))

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {connected.length > 1 && (
        <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-5">
          <Label htmlFor="env-service" className="text-sm">
            Service
          </Label>
          <Select value={service.id} onValueChange={setServiceId}>
            <SelectTrigger id="env-service" size="sm" className="min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {connected.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <ul className="divide-y">
        <li className="flex gap-3 px-4 py-3 sm:px-5">
          <Checkbox checked disabled aria-label="QUERYLENS_DSN, always set" className="mt-0.5" />
          <code className="font-mono text-[13px] font-medium" title={`Where ${service.name} reports. Always set: without it the SDK does nothing.`}>
            QUERYLENS_DSN
          </code>
        </li>
        {ENV_VARS.map((v) => {
          const c = choice[v.name] ?? { on: false, value: '' }
          const id = `env-${v.name}`
          const why = c.on ? problem(v, c.value) : null
          return (
            <li key={v.name} className={cn('flex gap-3 px-4 py-3 sm:px-5', c.on && 'bg-primary/[0.03]')}>
              <Checkbox id={id} checked={c.on} onCheckedChange={(on) => set(v.name, { on: on === true })} className="mt-0.5" />
              <div className="grid grid-cols-1 min-w-0 flex-1 gap-1.5">
                <div className="grid grid-cols-1 gap-0.5">
                  <label htmlFor={id} title={v.help} className="w-fit cursor-pointer font-mono text-[13px] font-medium">
                    {v.name}
                  </label>
                  {v.caution && c.on && (
                    <p className="flex items-center gap-1.5 text-xs">
                      <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" /> {v.caution}
                    </p>
                  )}
                </div>
                {c.on && v.kind !== 'flag' && (
                  <div className="grid grid-cols-1 gap-1">
                    <Input
                      value={c.value}
                      onChange={(e) => set(v.name, { value: e.target.value })}
                      placeholder={v.placeholder}
                      inputMode={v.kind === 'rate' ? 'decimal' : undefined}
                      aria-label={`${v.name} value`}
                      aria-invalid={why ? true : undefined}
                      className="h-8 max-w-xs font-mono text-[13px]"
                    />
                    {why && <p className="text-xs text-destructive">{why} It’s left out of the file below.</p>}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      <div className="grid grid-cols-1 border-t bg-muted/30 px-4 py-4 sm:px-5">
        <CodeBlock code={envFile(service, choice)} wrap={false} className="bg-card" />
      </div>
    </div>
  )
}

type Draft = Record<keyof ProjectSettings, string>

function draftOf(s: ProjectSettings): Draft {
  return {
    slowMs: String(s.slowMs),
    loopMin: String(s.loopMin),
    largeRows: String(s.largeRows),
    chatty: String(s.chatty),
    liveSampleRate: String(Math.round(s.liveSampleRate * 1000) / 10),
  }
}

/** A number field set inside a sentence. */
function Inline({ id, value, onChange, label, step = 1 }: { id: keyof ProjectSettings; value: string; onChange: (v: string) => void; label: string; step?: number }) {
  return (
    <Input
      id={`threshold-${id}`}
      type="number"
      inputMode="decimal"
      min={0}
      step={step}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className="mx-1 inline-flex h-7 w-[5.5rem] px-2 text-right font-medium tabular text-primary"
    />
  )
}

/** The project's limits, as the sentences they decide. The SDKs pick them up with their next report. */
function Thresholds({ project, onSaved }: { project: Project; onSaved: (p: Project) => void }) {
  const [draft, setDraft] = useState(() => draftOf(project.settings))
  const { busy, error, run } = useChange()
  const [saved, setSaved] = useState(false)
  const set = (key: keyof ProjectSettings) => (v: string) => {
    setSaved(false)
    setDraft((d) => ({ ...d, [key]: v }))
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(project.settings))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const settings = await api.updateSettings(project.id, {
        slowMs: Number(draft.slowMs),
        loopMin: Number(draft.loopMin),
        largeRows: Number(draft.largeRows),
        chatty: Number(draft.chatty),
        liveSampleRate: Number(draft.liveSampleRate) / 100,
      })
      onSaved({ ...project, settings })
      setDraft(draftOf(settings))
      setSaved(true)
    })
  }
  const line = 'leading-9 text-[15px]'
  return (
    <form onSubmit={submit} className="grid grid-cols-1 gap-4 rounded-lg border bg-card px-4 py-4 sm:px-5">
      <div className="grid grid-cols-1 gap-1">
        <p className={line}>
          A statement is slow when it takes more than
          <Inline id="slowMs" label="Slow statement limit, ms" value={draft.slowMs} onChange={set('slowMs')} />
          ms.
        </p>
        <p className={line}>
          The same statement running
          <Inline id="loopMin" label="Runs in a row that make a loop" value={draft.loopMin} onChange={set('loopMin')} />
          times in a row is an N+1, or a loop of writes.
        </p>
        <p className={line}>
          A result is large from
          <Inline id="largeRows" label="Rows that make a large result" value={draft.largeRows} onChange={set('largeRows')} />
          rows.
        </p>
        <p className={line}>
          A request is chatty from
          <Inline id="chatty" label="Statements that make a request chatty" value={draft.chatty} onChange={set('chatty')} />
          statements.
        </p>
        <p className={line}>
          In production, the SDK also sends
          <Inline id="liveSampleRate" label="Share of requests without problems sent, percent" value={draft.liveSampleRate} onChange={set('liveSampleRate')} step={0.1} />
          % of the requests without a problem, for the live feed.
        </p>
      </div>
      <ErrorNote error={error} />
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="text-xs" role="status">
          {saved && !dirty ? 'Saved' : ''}
        </p>
        <span className="flex gap-2">
          {dirty && (
            <Button type="button" variant="outline" size="sm" onClick={() => setDraft(draftOf(project.settings))}>
              Discard
            </Button>
          )}
          <Button type="submit" size="sm" disabled={busy || !dirty}>
            Save limits
          </Button>
        </span>
      </div>
    </form>
  )
}

export function ProjectPage({ project, onProject }: { project: Project; onProject: (p: Project) => void }) {
  const [renaming, setRenaming] = useState(false)
  return (
    <div className="mx-auto grid max-w-3xl grid-cols-1 gap-8">
      <header className="grid grid-cols-1 gap-1.5">
        {renaming ? (
          <NameEditor
            id="project-name"
            label="Project name"
            current={project.name}
            save={async (name) => onProject(await api.renameProject(project.id, name))}
            close={() => setRenaming(false)}
          />
        ) : (
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setRenaming(true)}>
              <PencilIcon /> Rename
            </Button>
          </div>
        )}
      </header>

      <section aria-labelledby="services" className="grid grid-cols-1 gap-3">
        <h2 id="services" className="text-base font-semibold">
          Services
        </h2>
        <div className="overflow-hidden rounded-lg border bg-card">
          {project.backends.length > 0 && (
            <ul className="divide-y">
              {project.backends.map((b) => (
                <ServiceRow key={b.id} project={project} service={b} onSaved={onProject} />
              ))}
            </ul>
          )}
          <ConnectService key={project.id} project={project} onSaved={onProject} />
        </div>
      </section>

      <section aria-labelledby="env" className="grid grid-cols-1 gap-3">
        <h2 id="env" className="text-base font-semibold">
          Environment variables
        </h2>
        <EnvBuilder key={project.id} project={project} />
      </section>

      <section aria-labelledby="limits" className="grid grid-cols-1 gap-3">
        <h2 id="limits" className="text-base font-semibold">
          What gets flagged
        </h2>
        <Thresholds key={project.id} project={project} onSaved={onProject} />
      </section>
    </div>
  )
}
