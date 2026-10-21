// Settings for this QueryLens deployment as a whole: the address apps reach it at, and this
// browser's session. The project and its services are managed on the project page.
import { LogOutIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { ConnectionStatus, ErrorNote, Facts } from '@/components/common'
import { EditableValue, EditorActions, useChange } from '@/components/editing'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import type { Connection } from '@/lib/live'
import { useAsync } from '@/lib/useAsync'

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

export function SettingsPage({
  connection,
  onReload,
  onSignOut,
}: {
  connection: Connection
  /** Load the project again (a new host changes every DSN). */
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
        <p className="text-sm text-muted-foreground">Where your services reach this QueryLens server, and this browser’s session.</p>
      </div>

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Connected host</CardTitle>
          <CardDescription>
            The address your services reach this QueryLens server at; it goes into every DSN. Change it when the server runs behind
            your own domain or proxy.
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
              ['Server version', info.data?.version ?? '—'],
            ]}
          />
        </CardContent>
      </Card>

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>Signed in with the server’s admin token. Signing out removes it from this browser.</CardDescription>
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
