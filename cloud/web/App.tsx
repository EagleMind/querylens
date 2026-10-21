import { type FormEvent, useCallback, useEffect, useState } from 'react'

import type { Project } from '../bindings/Project'
import { Logo } from '@/components/Logo'
import { ErrorNote } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ApiError, api, getToken, setToken } from '@/lib/api'
import { useLiveFeed } from '@/lib/live'
import { useMuted } from '@/lib/muted'
import { type Route, href, onLinkClick, useRoute } from '@/lib/router'
import { cn } from '@/lib/utils'
import { LivePage } from '@/pages/Live'
import { DocsPage } from '@/pages/Docs'
import { QueryPage } from '@/pages/Query'
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

const NAV: { label: string; route: Route; pages: Route['page'][] }[] = [
  { label: 'Live', route: { page: 'live' }, pages: ['live', 'query'] },
  { label: 'Settings', route: { page: 'settings' }, pages: ['settings'] },
  { label: 'Docs', route: { page: 'docs' }, pages: ['docs'] },
]

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const route = useRoute()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const projectIds = projects?.map((p) => p.id) ?? []
  const feed = useLiveFeed(projectIds)
  const muted = useMuted(projectIds)

  useEffect(() => {
    api.projects().then(setProjects, (e) => (e instanceof ApiError && e.status === 401 ? onSignOut() : setError(e)))
  }, [onSignOut])

  let body
  if (error) body = <ErrorNote error={error} />
  else if (!projects) body = <p className="text-sm text-muted-foreground">Loading…</p>
  else if (projects.length === 0) body = <FirstProject onCreated={(p) => setProjects([p])} />
  else if (route.page === 'query') body = <QueryPage at={route} projects={projects} requests={feed.requests} muted={muted} />
  else if (route.page === 'docs') body = <DocsPage projects={projects} />
  else if (route.page === 'settings') body = <SettingsPage projects={projects} connection={feed.connection} onProjects={setProjects} onSignOut={onSignOut} />
  else body = <LivePage projects={projects} feed={feed} muted={muted} />

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between gap-4 px-4 sm:px-6">
          <a href={href({ page: 'live' })} onClick={onLinkClick} aria-label="QueryLens, live queries">
            <Logo />
          </a>
          <nav aria-label="Main" className="flex items-center gap-1">
            {NAV.map((n) => {
              const active = n.pages.includes(route.page)
              return (
                <a
                  key={n.label}
                  href={href(n.route)}
                  onClick={onLinkClick}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    active ? 'bg-primary/10 text-primary dark:bg-primary/15' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {n.label}
                </a>
              )
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">{body}</main>
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
