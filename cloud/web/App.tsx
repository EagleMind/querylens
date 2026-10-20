import { FolderPlusIcon } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useState } from 'react'

import type { Project } from '../../src/bindings/Project'
import { Logo } from './components/Logo'
import { Button, Empty, ErrorNote, Select, cx } from './components/ui'
import { ApiError, api, getToken, setToken } from './lib/api'
import { type Connection, useLiveFeed } from './lib/live'
import { type Route, href, onLinkClick, useRoute } from './lib/router'
import { IssuesPage } from './pages/Issues'
import { LivePage } from './pages/Live'
import { QueriesPage } from './pages/Queries'
import { SettingsPage } from './pages/Settings'
import { SignIn } from './pages/SignIn'

const PROJECT_KEY = 'querylens.project'

function remembered(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY)
  } catch {
    return null
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(PROJECT_KEY, id)
  } catch {
    // Fine: the first project is picked next time.
  }
}

const NAV: { route: Route; label: string; match: Route['page'][] }[] = [
  { route: { page: 'live' }, label: 'Live', match: ['live'] },
  { route: { page: 'issues', issue: null }, label: 'Evaluation', match: ['issues', 'queries'] },
  { route: { page: 'settings' }, label: 'Settings', match: ['settings'] },
]

function ConnectionDot({ state }: { state: Connection }) {
  const label = { live: 'Live', connecting: 'Connecting', offline: 'Reconnecting' }[state]
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted" role="status">
      <span className={cx('size-2 rounded-full', state === 'live' ? 'animate-live bg-ok' : state === 'offline' ? 'bg-danger' : 'bg-sev-medium')} />
      {label}
    </span>
  )
}

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
    <main className="mx-auto max-w-lg px-4 py-16">
      <Empty title="Create your first project" icon={<FolderPlusIcon />}>
        <p>A project is one application. It gets a DSN for the SDK, and its own issues and live feed.</p>
        <form onSubmit={submit} className="mt-4 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Shop API"
            aria-label="Project name"
            className="h-8 min-w-0 flex-1 rounded-[3px] border border-border bg-background px-2 text-[13px] text-foreground placeholder:text-muted"
          />
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Create
          </Button>
        </form>
        <div className="mt-3 text-left">
          <ErrorNote error={error} />
        </div>
      </Empty>
    </main>
  )
}

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
  const route = useRoute()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [projectId, setProjectId] = useState<string | null>(remembered())
  const [error, setError] = useState<unknown>(null)
  const [paused, setPaused] = useState(false)
  const project = projects?.find((p) => p.id === projectId) ?? projects?.[0] ?? null
  const live = useLiveFeed(project?.id ?? null, paused)
  // New issues from the live feed refresh the evaluation views.
  const refreshKey = live.issues.length

  useEffect(() => {
    api.projects().then(setProjects, (e) => (e instanceof ApiError && e.status === 401 ? onSignOut() : setError(e)))
  }, [onSignOut])

  const choose = (id: string) => {
    setProjectId(id)
    remember(id)
  }
  const upsert = (p: Project) => {
    setProjects((all) => (all?.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? p : x)) : [...(all ?? []), p]))
    choose(p.id)
  }

  if (error) return <main className="p-6"><ErrorNote error={error} /></main>
  if (!projects) return <main className="p-6 text-[13px] text-muted">Loading…</main>
  if (!project) return <FirstProject onCreated={upsert} />

  const evaluation = route.page === 'issues' || route.page === 'queries'

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-rule bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
          <a href="/" onClick={onLinkClick} aria-label="QueryLens, live">
            <Logo />
          </a>
          {projects.length > 1 ? (
            <Select label="Project" value={project.id} onChange={choose}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : (
            <span className="text-[13px] font-semibold text-foreground/85">{project.name}</span>
          )}
          <nav aria-label="Main" className="order-last flex w-full gap-1 sm:order-none sm:w-auto">
            {NAV.map((n) => {
              const active = n.match.includes(route.page)
              return (
                <a
                  key={n.label}
                  href={href(n.route)}
                  onClick={onLinkClick}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'rounded-[3px] px-3 py-1.5 text-[13px] font-medium transition-colors',
                    active ? 'bg-raised text-foreground' : 'text-muted hover:text-foreground',
                  )}
                >
                  {n.label}
                </a>
              )
            })}
          </nav>
          <span className="ml-auto">
            <ConnectionDot state={live.connection} />
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-5">
        {evaluation && (
          <nav aria-label="Evaluation" className="mb-4 flex gap-4 border-b border-rule">
            {[
              { route: { page: 'issues', issue: null } as Route, label: 'Issues', page: 'issues' },
              { route: { page: 'queries' } as Route, label: 'Top statements', page: 'queries' },
            ].map((t) => (
              <a
                key={t.label}
                href={href(t.route)}
                onClick={onLinkClick}
                aria-current={route.page === t.page ? 'page' : undefined}
                className={cx(
                  '-mb-px border-b-2 pb-2 text-[13px] font-medium',
                  route.page === t.page ? 'border-signal text-foreground' : 'border-transparent text-muted hover:text-foreground',
                )}
              >
                {t.label}
              </a>
            ))}
          </nav>
        )}
        {route.page === 'live' && <LivePage project={project} live={live} paused={paused} onPause={setPaused} />}
        {route.page === 'issues' && <IssuesPage project={project} selected={route.issue} refreshKey={refreshKey} />}
        {route.page === 'queries' && <QueriesPage project={project} refreshKey={refreshKey} />}
        {route.page === 'settings' && (
          <SettingsPage project={project} onProjectChanged={upsert} onCreated={upsert} onSignOut={onSignOut} />
        )}
      </main>
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
  if (!token) {
    return (
      <SignIn
        configured={configured}
        onSignedIn={(t) => {
          setToken(t)
          setTokenState(t)
        }}
      />
    )
  }
  return <Dashboard onSignOut={signOut} />
}
