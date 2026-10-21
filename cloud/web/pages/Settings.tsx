import { LogOutIcon, PencilIcon, PlugIcon, PlusIcon, RefreshCwIcon, UnplugIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'

import type { Backend } from '../../bindings/Backend'
import type { Project } from '../../bindings/Project'
import { CodeBlock, ConnectionStatus, CopyButton, ErrorNote, Facts } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { ORMS, fmtRelative } from '@/lib/format'
import type { Connection } from '@/lib/live'
import { useAsync } from '@/lib/useAsync'
import { cn } from '@/lib/utils'

/** A value shown with copy and edit buttons, edited in place. */
function EditableValue({
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
function EditorActions({ busy, onCancel, children }: { busy: boolean; onCancel: () => void; children?: ReactNode }) {
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

/** Runs a change, tracking whether it's in flight and how it failed. */
function useChange() {
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

function HostEditor({ current, dashboardUrl, onSaved, close }: { current: string; dashboardUrl: string; onSaved: () => void; close: () => void }) {
  const [value, setValue] = useState(current)
  const { busy, error, run } = useChange()
  const save = (url: string | null) =>
    run(async () => {
      await api.savePublicUrl(url)
      onSaved()
      close()
    })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void save(value.trim() || null)
  }
  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid gap-2">
        <Label htmlFor="public-url">Host</Label>
        <Input id="public-url" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://querylens.example.com" autoFocus />
      </div>
      <ErrorNote error={error} />
      <EditorActions busy={busy} onCancel={close}>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => save(null)}>
          Use {new URL(dashboardUrl).host}
        </Button>
      </EditorActions>
    </form>
  )
}

/** A name edited in place (a project's or a backend's). */
function NameEditor({ id, label, current, save, close }: { id: string; label: string; current: string; save: (name: string) => Promise<void>; close: () => void }) {
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

function KeyEditor({ project, backend, onSaved, close }: { project: Project; backend: Backend; onSaved: (p: Project) => void; close: () => void }) {
  const current = backend.dsn ? decodeURIComponent(new URL(backend.dsn).username) : ''
  const [value, setValue] = useState(current)
  const { busy, error, run } = useChange()
  const save = (key?: string) =>
    run(async () => {
      onSaved(await api.setBackendKey(project.id, backend.id, key))
      close()
    })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value.trim() === current) close()
    else void save(value.trim())
  }
  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid gap-2">
        <Label htmlFor={`key-${backend.id}`}>Key</Label>
        <Input id={`key-${backend.id}`} value={value} onChange={(e) => setValue(e.target.value)} className="font-mono" autoFocus />
        <p className="text-xs text-muted-foreground">
          16 to 64 letters, digits, - or _. {backend.name} stops reporting until it’s given the new DSN.
        </p>
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

/** Whether a backend is reporting: a dot and a few words. */
function BackendStatus({ backend }: { backend: Backend }) {
  const recent = backend.lastSeen !== null && Date.now() - Date.parse(backend.lastSeen) < 15 * 60_000
  const [dot, text] = !backend.dsn
    ? ['bg-muted-foreground/40', 'Disconnected']
    : backend.lastSeen === null
      ? ['bg-warning', 'Waiting for its first event']
      : [recent ? 'bg-primary' : 'bg-muted-foreground', `Last event ${fmtRelative(backend.lastSeen)}`]
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-1.5 rounded-full', dot)} aria-hidden />
      {text}
    </span>
  )
}

function BackendItem({ project, backend, onSaved }: { project: Project; backend: Backend; onSaved: (p: Project) => void }) {
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const { busy, error, run } = useChange()
  const disconnect = () =>
    run(async () => {
      onSaved(await api.disconnectBackend(project.id, backend.id))
      setConfirming(false)
    })
  const reconnect = () => run(async () => onSaved(await api.setBackendKey(project.id, backend.id)))

  return (
    <li className="grid gap-3 px-4 py-3.5">
      {renaming ? (
        <NameEditor
          id={`backend-name-${backend.id}`}
          label="Backend name"
          current={backend.name}
          save={async (name) => onSaved(await api.renameBackend(project.id, backend.id, name))}
          close={() => setRenaming(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className={cn('font-medium', !backend.dsn && 'text-muted-foreground')}>{backend.name}</p>
          <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            <BackendStatus backend={backend} />
            {backend.orm && <span>{ORMS[backend.orm]}</span>}
          </p>
          <span className="ml-auto flex items-center">
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setRenaming(true)}>
              <PencilIcon /> Rename
            </Button>
            {backend.dsn ? (
              <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => setConfirming(true)}>
                <UnplugIcon /> Disconnect
              </Button>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy} onClick={reconnect}>
                <PlugIcon /> Reconnect
              </Button>
            )}
          </span>
        </div>
      )}
      {backend.dsn && (
        <EditableValue
          value={backend.dsn}
          label={`${backend.name} DSN`}
          editor={(close) => <KeyEditor project={project} backend={backend} onSaved={onSaved} close={close} />}
        />
      )}
      {confirming && (
        <div className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/[0.04] p-3 text-sm">
          <p>
            Disconnect <span className="font-medium">{backend.name}</span>? Its DSN stops working at once. Its queries and issues stay,
            and reconnecting gives it a new DSN.
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

/** Connect a backend, then show what to give it. */
function ConnectBackend({ project, onSaved, first }: { project: Project; onSaved: (p: Project) => void; first: boolean }) {
  const [name, setName] = useState('')
  const [added, setAdded] = useState<Backend | null>(null)
  const { busy, error, run } = useChange()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run(async () => {
      const next = await api.addBackend(project.id, name.trim())
      onSaved(next)
      setAdded(next.backends.find((b) => b.name === name.trim()) ?? null)
      setName('')
    })
  }
  return (
    <div className={cn('grid gap-3 px-4 py-4', !first && 'border-t bg-muted/20')}>
      <form onSubmit={submit} className="grid gap-2">
        <Label htmlFor="backend-name">{first ? 'Name your first backend' : 'Connect another backend'}</Label>
        <div className="flex gap-2">
          <Input id="backend-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. orders, billing, api" autoFocus={first} />
          <Button type="submit" disabled={busy || !name.trim()}>
            <PlusIcon /> Connect
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">One per service of the app. Each gets its own DSN, so you can revoke one without the others.</p>
      </form>
      <ErrorNote error={error} />
      {added?.dsn && (
        <div className="grid gap-2 rounded-md border border-primary/25 bg-primary/[0.05] p-3 text-sm">
          <p>
            <span className="font-medium">{added.name}</span> is connected. In that service, install the SDK, set its DSN and load it first:
          </p>
          <CodeBlock code={`npm install querylens-node\nQUERYLENS_DSN=${added.dsn}\n\nrequire('querylens-node/register') // first line of the entry file`} wrap={false} />
        </div>
      )}
    </div>
  )
}

function ProjectCard({ project, onSaved }: { project: Project; onSaved: (p: Project) => void }) {
  const [renaming, setRenaming] = useState(false)
  const connected = project.backends.filter((b) => b.dsn).length
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        {renaming ? (
          <NameEditor
            id="project-name"
            label="Project name"
            current={project.name}
            save={async (name) => onSaved(await api.renameProject(project.id, name))}
            close={() => setRenaming(false)}
          />
        ) : (
          <>
            <CardTitle>{project.name}</CardTitle>
            <CardDescription>
              Created {new Date(project.createdAt).toLocaleDateString([], { dateStyle: 'medium' })}.{' '}
              {project.backends.length === 0
                ? 'No backend connected yet.'
                : `${connected} ${connected === 1 ? 'backend' : 'backends'} connected${connected < project.backends.length ? `, ${project.backends.length - connected} disconnected` : ''}.`}
            </CardDescription>
            <CardAction>
              <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setRenaming(true)}>
                <PencilIcon /> Rename
              </Button>
            </CardAction>
          </>
        )}
      </CardHeader>
      <CardContent className="px-0">
        {project.backends.length > 0 && (
          <ul className="divide-y" aria-label="Backends">
            {project.backends.map((b) => (
              <BackendItem key={b.id} project={project} backend={b} onSaved={onSaved} />
            ))}
          </ul>
        )}
        <ConnectBackend key={project.id} project={project} onSaved={onSaved} first={project.backends.length === 0} />
      </CardContent>
    </Card>
  )
}

export function SettingsPage({
  project,
  projects,
  connection,
  onProject,
  onReload,
  onSignOut,
}: {
  /** The project chosen in the sidebar. */
  project: Project | null
  projects: Project[]
  connection: Connection
  onProject: (p: Project) => void
  /** Load the projects again (a new host changes every DSN). */
  onReload: () => void
  onSignOut: () => void
}) {
  const info = useAsync(() => api.info(), [])
  const settings = useAsync(() => api.settings(), [])
  const dashboardUrl = settings.data?.dashboardUrl ?? location.origin
  const host = settings.data?.publicUrl ?? dashboardUrl

  const reload = () => {
    settings.reload()
    onReload()
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">The project’s backends, where they send their queries, and this browser’s session.</p>
      </div>

      {project && (
        <div className="grid gap-3">
          <div className="grid gap-1">
            <h2 className="text-base font-semibold">Project</h2>
            <p className="text-sm text-muted-foreground">
              Connect each service of the app as a backend, and set its DSN as <code className="font-mono">QUERYLENS_DSN</code> in
              that service’s environment. A DSN lets the SDK send data to this project, nothing more.
            </p>
          </div>
          <ProjectCard project={project} onSaved={onProject} />
        </div>
      )}

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Connected host</CardTitle>
          <CardDescription>
            The address your apps reach this QueryLens backend at; it goes into every DSN. Change it when the backend
            runs behind your own domain or proxy.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ErrorNote error={settings.error} />
          <EditableValue
            value={host}
            label="host"
            accent
            editor={(close) => <HostEditor current={host} dashboardUrl={dashboardUrl} onSaved={reload} close={close} />}
          />
          <Facts
            items={[
              ['Live feed', <ConnectionStatus state={connection} />],
              ['Backend version', info.data?.version ?? '—'],
              ['Projects', String(projects.length)],
            ]}
          />
        </CardContent>
      </Card>

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>Signed in with the backend’s admin token. Signing out removes it from this browser.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button variant="outline" onClick={onSignOut}>
            <LogOutIcon /> Sign out
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
