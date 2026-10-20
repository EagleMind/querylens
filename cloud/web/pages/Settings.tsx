import { LogOutIcon } from 'lucide-react'

import type { Project } from '../../bindings/Project'
import { CodeBlock, ConnectionStatus, CopyButton, Facts } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { api } from '@/lib/api'
import { ORMS } from '@/lib/format'
import type { Connection } from '@/lib/live'
import { useAsync } from '@/lib/useAsync'

const SETUP = `npm install querylens-node

# first line of your entry file
require('querylens-node/register')`

function ProjectCard({ project }: { project: Project }) {
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
        <div className="flex items-center gap-1 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
          <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={project.dsn}>
            {project.dsn}
          </code>
          <CopyButton value={project.dsn} label="Copy DSN" />
        </div>
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
  onSignOut,
}: {
  projects: Project[]
  connection: Connection
  onSignOut: () => void
}) {
  const info = useAsync(() => api.info(), [])
  const origin = location.origin

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Where your apps send their queries, and this browser’s session.</p>
      </div>

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Connected host</CardTitle>
          <CardDescription>The QueryLens backend this dashboard is signed in to. Your SDKs report to it too.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex items-center gap-1 rounded-md border border-primary/25 bg-primary/[0.06] py-1 pr-1 pl-3">
            <code className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{origin}</code>
            <CopyButton value={origin} label="Copy host" />
          </div>
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
          <ProjectCard key={p.id} project={p} />
        ))}
      </div>

      <Card className="gap-4">
        <CardHeader>
          <CardTitle>Set up an app</CardTitle>
          <CardDescription>Node.js with PostgreSQL (pg) or MySQL (mysql2), through any ORM.</CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={SETUP} wrap={false} />
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
