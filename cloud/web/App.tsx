import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'

import type { Project } from '../bindings/Project'
import { Sidebar, useSidebarCollapsed } from '@/components/Sidebar'
import { ErrorNote } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError, api, getToken, setToken } from '@/lib/api'
import { useLiveFeed } from '@/lib/live'
import { useMuted } from '@/lib/muted'
import { useRoute } from '@/lib/router'
import { ALL, scopedProject, useScope } from '@/lib/scope'
import { cn } from '@/lib/utils'
import { LivePage } from '@/pages/Live'
import { DocsPage } from '@/pages/Docs'
import { SettingsPage } from '@/pages/Settings'
import { SignIn } from '@/pages/SignIn'

function FirstProject({ onCreated }: { onCreated: (p: Project) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<unknown>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      onCreated(await api.createProject(name.trim()))
    } catch (err) {
      setError(err)
    }
  }
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-lg">Create your first project</CardTitle>
          <CardDescription>A project is one application. It gets a DSN to give the SDK.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="project-name">Name</Label>
              <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Shop API" />
            </div>
            <ErrorNote error={error} />
            <Button type="submit" disabled={!name.trim()}>
              Create project
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const route = useRoute()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const projectIds = projects?.map((p) => p.id) ?? []
  const feed = useLiveFeed(projectIds)
  const muted = useMuted(projectIds)
  const [scope, setScope] = useScope()
  const [collapsed, setCollapsed] = useSidebarCollapsed()

  useEffect(() => {
    api.projects().then(setProjects, (e) => (e instanceof ApiError && e.status === 401 ? onSignOut() : setError(e)))
  }, [onSignOut])

  const environments = useMemo(
    () => [...new Set([...feed.requests.map((r) => r.environment), ...(scope.environment !== ALL ? [scope.environment] : [])])].sort(),
    [feed.requests, scope.environment],
  )

  let body
  if (error) body = <ErrorNote error={error} />
  else if (!projects) body = <p className="text-sm text-muted-foreground">Loading…</p>
  else if (projects.length === 0) body = <FirstProject onCreated={(p) => setProjects([p])} />
  else if (route.page === 'docs') body = <DocsPage projects={projects} />
  else if (route.page === 'settings') body = <SettingsPage projects={projects} connection={feed.connection} onProjects={setProjects} onSignOut={onSignOut} />
  // One element for the list and a selected query, so pausing and paging survive opening a report.
  else body = <LivePage projects={projects} feed={feed} muted={muted} scope={scope} onScope={setScope} selected={route.page === 'query' ? route : null} />

  return (
    <div
      className={cn(
        'min-h-dvh lg:grid lg:transition-[grid-template-columns] lg:duration-200',
        collapsed ? 'lg:grid-cols-[3.25rem_minmax(0,1fr)]' : 'lg:grid-cols-[15rem_minmax(0,1fr)]',
      )}
    >
      <Sidebar
        collapsed={collapsed}
        onCollapsed={setCollapsed}
        route={route}
        projects={projects ?? []}
        scope={{ ...scope, project: scopedProject(scope, projects ?? []) }}
        onScope={setScope}
        environments={environments}
        connection={feed.connection}
        size={feed.size}
      />
      <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-6">{body}</main>
    </div>
  )
}

export function App() {
  const [token, setTokenState] = useState(getToken())
  const [configured, setConfigured] = useState(true)
  useEffect(() => {
    api.info().then((i) => setConfigured(i.configured), () => {})
  }, [])
  const signOut = useCallback(() => {
    setToken(null)
    setTokenState('')
  }, [])
  return (
    <TooltipProvider delayDuration={300}>
      {token ? (
        <Dashboard onSignOut={signOut} />
      ) : (
        <SignIn
          configured={configured}
          onSignedIn={(t) => {
            setToken(t)
            setTokenState(t)
          }}
        />
      )}
    </TooltipProvider>
  )
}
