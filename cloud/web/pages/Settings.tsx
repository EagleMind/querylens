import { LogOutIcon, PencilIcon, RefreshCwIcon } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'

import type { Project } from '../../bindings/Project'
import { ConnectionStatus, CopyButton, ErrorNote, Facts } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { ORMS } from '@/lib/format'
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

function HostEditor({ current, dashboardUrl, onSaved, close }: { current: string; dashboardUrl: string; onSaved: () => void; close: () => void }) {
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const save = async (url: string | null) => {
    setBusy(true)
    setError(null)
    try {
      await api.savePublicUrl(url)
      onSaved()
      close()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
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

function KeyEditor({ project, onSaved, close }: { project: Project; onSaved: (p: Project) => void; close: () => void }) {
  const current = decodeURIComponent(new URL(project.dsn).username)
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const save = async (key?: string) => {
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.setKey(project.id, key))
      close()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (value.trim() === current) close()
    else void save(value.trim())
  }
  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid gap-2">
        <Label htmlFor={`key-${project.id}`}>Key</Label>
        <Input id={`key-${project.id}`} value={value} onChange={(e) => setValue(e.target.value)} className="font-mono" autoFocus />
        <p className="text-xs text-muted-foreground">
          16 to 64 letters, digits, - or _. Apps still using the old DSN stop reporting until you give them the new one.
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

function ProjectCard({ project, onSaved }: { project: Project; onSaved: (p: Project) => void }) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{project.name}</CardTitle>
        <CardDescription>
          Created {new Date(project.createdAt).toLocaleDateString([], { dateStyle: 'medium' })}
          {project.orm ? `. ORM recognised from its traffic: ${ORMS[project.orm]}.` : '. No traffic yet.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <p className="text-sm font-medium">DSN</p>
        <EditableValue value={project.dsn} label="DSN" editor={(close) => <KeyEditor project={project} onSaved={onSaved} close={close} />} />
        <p className="text-xs text-muted-foreground">
          Set it as <code className="font-mono">QUERYLENS_DSN</code> in the app’s environment. It lets the SDK send data
          to this project, nothing more.
        </p>
      </CardContent>
    </Card>
  )
}

export function SettingsPage({
  projects,
  connection,
  onProjects,
  onSignOut,
}: {
  projects: Project[]
  connection: Connection
  onProjects: (projects: Project[]) => void
  onSignOut: () => void
}) {
  const info = useAsync(() => api.info(), [])
  const settings = useAsync(() => api.settings(), [])
  const dashboardUrl = settings.data?.dashboardUrl ?? location.origin
  const host = settings.data?.publicUrl ?? dashboardUrl

  // A new host changes every DSN.
  const reload = () => {
    settings.reload()
    api.projects().then(onProjects, () => {})
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Where your apps send their queries, and this browser’s session.</p>
      </div>

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

      <div className="grid gap-3">
        <div className="grid gap-1">
          <h2 className="text-base font-semibold">Projects</h2>
          <p className="text-sm text-muted-foreground">One per application. Give each app its project’s DSN.</p>
        </div>
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} onSaved={(next) => onProjects(projects.map((x) => (x.id === next.id ? next : x)))} />
        ))}
      </div>

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
