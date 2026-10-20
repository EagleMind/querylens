import { LogOutIcon, PlusIcon, SaveIcon } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'

import type { Project } from '../../../src/bindings/Project'
import type { ProjectSettings } from '../../../src/bindings/ProjectSettings'
import { Button, CodeBlock, CopyButton, ErrorNote } from '../components/ui'
import { api } from '../lib/api'
import { ORMS } from '../lib/format'

function Section({ title, children, description }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4 border-b border-rule py-6 first:pt-0 last:border-0 md:grid-cols-[220px_minmax(0,1fr)]">
      <div>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {description && <p className="mt-1 text-[12.5px]/relaxed text-muted">{description}</p>}
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  )
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  step = 1,
  suffix,
}: {
  label: string
  hint: string
  value: number
  onChange: (v: number) => void
  min: number
  step?: number
  suffix?: string
}) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium">{label}</span>
      <span className="mt-1 flex items-center gap-2">
        <input
          type="number"
          min={min}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-8 w-32 rounded-[3px] border border-border bg-background px-2 text-[13px] tabular"
        />
        {suffix && <span className="text-[12.5px] text-muted">{suffix}</span>}
      </span>
      <span className="mt-1 block text-[12px] text-muted">{hint}</span>
    </label>
  )
}

export function SettingsPage({
  project,
  onProjectChanged,
  onCreated,
  onSignOut,
}: {
  project: Project
  onProjectChanged: (p: Project) => void
  onCreated: (p: Project) => void
  onSignOut: () => void
}) {
  const [name, setName] = useState(project.name)
  const [settings, setSettings] = useState<ProjectSettings>(project.settings)
  const [newName, setNewName] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    setName(project.name)
    setSettings(project.settings)
  }, [project])

  const run = async (f: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await f()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      let next = project
      if (name.trim() && name.trim() !== project.name) next = await api.renameProject(project.id, name.trim())
      const s = await api.saveSettings(project.id, settings)
      onProjectChanged({ ...next, settings: s })
      setSaved(true)
    })
  }

  const create = (e: FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    run(async () => {
      onCreated(await api.createProject(newName.trim()))
      setNewName('')
    })
  }

  const set = <K extends keyof ProjectSettings>(k: K) => (v: ProjectSettings[K]) => setSettings((s) => ({ ...s, [k]: v }))

  return (
    <div className="max-w-4xl">
      <Section title="Connect your app" description="Install the SDK, set the DSN, and add one line before anything else loads.">
        <div className="flex items-center gap-2 rounded-[3px] border border-rule bg-background px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={project.dsn}>
            {project.dsn}
          </code>
          <CopyButton value={project.dsn} label="Copy DSN" />
        </div>
        <CodeBlock code="npm install querylens-node" label="Install" />
        <CodeBlock code={`QUERYLENS_DSN=${project.dsn}`} label="Environment" />
        <CodeBlock code={`require('querylens-node/register') // first line of your entry file\n// or, in ESM / TypeScript:\nimport 'querylens-node/register'`} label="Entry file" />
        <p className="text-[12.5px]/relaxed text-muted">
          In production the SDK sends no values: literals become <code className="font-mono">?</code> and bound parameters are
          dropped. It sends requests with problems, a sample of the others, and per-minute totals for every statement.
          {project.orm && ` Recognized ORM: ${ORMS[project.orm]}.`}
        </p>
      </Section>

      <form onSubmit={save}>
        <Section title="Project" description="Detection settings apply to everything the SDKs send from now on.">
          <label className="block">
            <span className="text-[13px] font-medium">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 block h-8 w-full max-w-sm rounded-[3px] border border-border bg-background px-2 text-[13px]"
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField label="Slow statement" hint="Statements slower than this are flagged." value={settings.slowMs} onChange={set('slowMs')} min={1} suffix="ms" />
            <NumberField label="Loop length" hint="Executions in a row that make an N+1 or a write loop." value={settings.loopMin} onChange={set('loopMin')} min={2} suffix="in a row" />
            <NumberField label="Chatty request" hint="Statements in one request that make it chatty." value={settings.chatty} onChange={set('chatty')} min={2} suffix="statements" />
            <NumberField label="Large result" hint="Rows (without a LIMIT) that make a result large." value={settings.largeRows} onChange={set('largeRows')} min={1} suffix="rows" />
          </div>
          <label className="block">
            <span className="text-[13px] font-medium">Live feed sampling</span>
            <span className="mt-1 flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(settings.liveSampleRate * 100)}
                onChange={(e) => set('liveSampleRate')(Number(e.target.value) / 100)}
                className="w-56 accent-[var(--signal)]"
              />
              <span className="w-12 text-[13px] tabular">{Math.round(settings.liveSampleRate * 100)}%</span>
            </span>
            <span className="mt-1 block text-[12px] text-muted">
              Share of requests without problems that production SDKs send to the live feed. Requests with problems are always sent.
              Higher costs more requests on the Workers free plan (100,000 a day).
            </span>
          </label>
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={busy}>
              <SaveIcon /> Save
            </Button>
            {saved && <span className="text-[12.5px] text-ok">Saved. SDKs pick it up with their next report.</span>}
          </div>
        </Section>
      </form>

      <form onSubmit={create}>
        <Section title="New project" description="One per application (or per service). Each gets its own DSN, issues and live feed.">
          <div className="flex max-w-md gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Shop API"
              aria-label="Project name"
              className="h-8 min-w-0 flex-1 rounded-[3px] border border-border bg-background px-2 text-[13px] placeholder:text-muted"
            />
            <Button type="submit" disabled={busy || !newName.trim()}>
              <PlusIcon /> Create
            </Button>
          </div>
        </Section>
      </form>

      <Section title="Session">
        <Button onClick={onSignOut}>
          <LogOutIcon /> Sign out
        </Button>
      </Section>
      <ErrorNote error={error} />
    </div>
  )
}
