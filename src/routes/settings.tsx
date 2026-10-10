import {
  BotIcon,
  CheckCircle2Icon,
  CloudIcon,
  CpuIcon,
  DownloadCloudIcon,
  KeyRoundIcon,
  Loader2Icon,
  PlugZapIcon,
  SaveIcon,
  ShieldCheckIcon,
  XCircleIcon,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import type { LlmProviderKind } from '@/bindings/LlmProviderKind'
import type { LlmTestResult } from '@/bindings/LlmTestResult'
import type { Settings } from '@/bindings/Settings'
import { PageHeader } from '@/components/layout/PageHeader'
import { PaneLabel } from '@/components/shared/bits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PROVIDERS } from '@/lib/constants'
import { fmtMs } from '@/lib/format'
import { api } from '@/lib/ipc'
import { useSaveSettings, useSettings } from '@/lib/queries'
import { cn } from '@/lib/utils'

const PROVIDER_ICON: Record<LlmProviderKind, LucideIcon> = {
  claude_code: BotIcon,
  lm_studio: CpuIcon,
  ollama: CpuIcon,
  open_router: CloudIcon,
  open_ai: CloudIcon,
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid grid-cols-[220px_minmax(0,1fr)] gap-8 border-b py-8 last:border-0">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-xs/relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-5">{children}</div>
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px]/relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; result: LlmTestResult }
  | { status: 'error'; message: string }

export function SettingsRoute() {
  const { data: saved } = useSettings()
  return saved ? <SettingsForm saved={saved} /> : null
}

function SettingsForm({ saved }: { saved: Settings }) {
  const save = useSaveSettings()
  const [form, setForm] = useState<Settings>(saved)
  const [apiKey, setApiKey] = useState<string | undefined>(undefined)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [test, setTest] = useState<TestState>({ status: 'idle' })

  const llm = form.llm
  const meta = PROVIDERS[llm.provider]
  const dirty = JSON.stringify(form) !== JSON.stringify(saved) || apiKey !== undefined
  const isClaude = llm.provider === 'claude_code'

  const setLlm = (patch: Partial<Settings['llm']>) => {
    setForm({ ...form, llm: { ...llm, ...patch } })
    setTest({ status: 'idle' })
  }

  function pickProvider(p: LlmProviderKind) {
    if (p === llm.provider) return
    setLlm({ provider: p, baseUrl: PROVIDERS[p].baseUrl, model: '', hasApiKey: false })
    setApiKey(undefined)
    setModels([])
  }

  async function persist() {
    const next = await save.mutateAsync({ settings: form, apiKey })
    setForm(next)
    setApiKey(undefined)
    return next
  }

  async function onSave() {
    await persist()
    toast.success('Settings saved')
  }

  async function onTest() {
    setTest({ status: 'running' })
    try {
      if (dirty) await persist()
      setTest({ status: 'ok', result: await api.testLlm() })
    } catch (e) {
      setTest({ status: 'error', message: (e as Error).message })
    }
  }

  async function fetchModels() {
    setLoadingModels(true)
    try {
      const list = await api.listModels(llm)
      setModels(list)
      if (!list.length) toast.info('The provider reported no models')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoadingModels(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings">
        <Button size="sm" variant="outline" onClick={onTest} disabled={test.status === 'running'}>
          {test.status === 'running' ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />} Test advisor
        </Button>
        <Button size="sm" onClick={onSave} disabled={!dirty || save.isPending}>
          {save.isPending ? <Loader2Icon className="animate-spin" /> : <SaveIcon />} Save
        </Button>
      </PageHeader>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-4xl px-8">
          <Section
            title="Advisor"
            description="Who explains your plans. Local engines keep everything on this machine; Claude Code can verify its fixes against your database."
          >
            <div className="grid grid-cols-5 gap-2">
              {(Object.keys(PROVIDERS) as LlmProviderKind[]).map((p) => {
                const Icon = PROVIDER_ICON[p]
                const active = p === llm.provider
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => pickProvider(p)}
                    className={cn(
                      'relative flex flex-col items-start gap-2 rounded-lg border bg-card p-3 text-left transition hover:border-foreground/20',
                      active && 'border-signal bg-accent shadow-[inset_0_-3px_0_var(--signal)]',
                    )}
                  >
                    <Icon className={cn('size-4', active ? 'text-foreground' : 'text-muted-foreground')} />
                    <span className="text-xs font-medium">{PROVIDERS[p].label}</span>
                    <span className="font-mono text-[10.5px] text-muted-foreground">
                      {PROVIDERS[p].local ? 'local' : p === 'claude_code' ? 'cli · mcp' : 'cloud'}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">{meta.hint}</p>

            {isClaude ? (
              <>
                <Field label="Claude Code binary" hint="Leave empty to find claude on your PATH.">
                  <Input
                    className="font-mono text-xs"
                    placeholder="claude"
                    value={llm.claudePath}
                    onChange={(e) => setLlm({ claudePath: e.target.value })}
                  />
                </Field>
                <div className="flex items-start justify-between gap-6 rounded-lg border bg-card p-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-xs font-medium">
                      <ShieldCheckIcon className="size-3.5 text-ok" /> Verify fixes with EXPLAIN
                    </div>
                    <p className="text-[11px]/relaxed text-muted-foreground">
                      Gives Claude a QueryLens MCP tool to EXPLAIN candidate rewrites and indexes on the analyzed
                      connection. Everything runs read-only in a rolled-back transaction, but a test index build briefly
                      locks the table against writes. Prefer dev/staging databases.
                    </p>
                  </div>
                  <Switch checked={llm.verifyWithTools} onCheckedChange={(v) => setLlm({ verifyWithTools: v })} />
                </div>
              </>
            ) : (
              <Field label="Base URL">
                <Input
                  className="font-mono text-xs"
                  value={llm.baseUrl}
                  onChange={(e) => setLlm({ baseUrl: e.target.value })}
                />
              </Field>
            )}

            {!isClaude && (
              <Field
                label={meta.needsKey ? 'API key' : 'API key (optional)'}
                hint={
                  llm.hasApiKey && apiKey === undefined
                    ? 'A key is stored in your OS keychain.'
                    : 'Stored in your OS keychain.'
                }
              >
                <div className="relative">
                  <KeyRoundIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="password"
                    className="pl-8 font-mono text-xs"
                    placeholder={llm.hasApiKey ? '•••••••••••••••• (unchanged)' : meta.needsKey ? 'sk-…' : 'none'}
                    value={apiKey ?? ''}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </div>
              </Field>
            )}

            <Field label="Model">
              <div className="flex gap-2">
                <Input
                  list="ql-models"
                  className="font-mono text-xs"
                  placeholder={meta.modelPlaceholder}
                  value={llm.model}
                  onChange={(e) => setLlm({ model: e.target.value })}
                />
                <datalist id="ql-models">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <Button variant="outline" onClick={fetchModels} disabled={loadingModels}>
                  {loadingModels ? <Loader2Icon className="animate-spin" /> : <DownloadCloudIcon />} Models
                </Button>
              </div>
              {models.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {models.slice(0, 12).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setLlm({ model: m })}
                      className={cn(
                        'rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground',
                        m === llm.model && 'border-signal text-foreground',
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </Field>

            {!isClaude && (
              <Field
                label={`Temperature · ${llm.temperature.toFixed(1)}`}
                hint="Low values give more consistent, conservative advice."
              >
                <Slider
                  min={0}
                  max={1}
                  step={0.1}
                  value={[llm.temperature]}
                  onValueChange={([v]) => setLlm({ temperature: v })}
                  className="max-w-xs"
                />
              </Field>
            )}

            {test.status !== 'idle' && test.status !== 'running' && (
              <div
                className={cn(
                  'flex items-start gap-2 rounded-md border px-3 py-2 text-xs animate-rise',
                  test.status === 'ok'
                    ? 'border-ok/35 text-ok'
                    : 'border-destructive/30 bg-destructive/5 text-destructive',
                )}
              >
                {test.status === 'ok' ? (
                  <CheckCircle2Icon className="mt-px size-3.5 shrink-0" />
                ) : (
                  <XCircleIcon className="mt-px size-3.5 shrink-0" />
                )}
                <span className="font-mono whitespace-pre-wrap" data-selectable>
                  {test.status === 'ok' ? `${fmtMs(test.result.latencyMs)} · “${test.result.reply}”` : test.message}
                </span>
              </div>
            )}
          </Section>

          <Section
            title="Analysis"
            description="How queries are executed. Analyze always runs inside a rolled-back transaction."
          >
            <Field label="Default mode">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                value={form.analysis.defaultMode}
                onValueChange={(v) =>
                  v && setForm({ ...form, analysis: { ...form.analysis, defaultMode: v as 'analyze' | 'estimate' } })
                }
                className="w-fit"
              >
                <ToggleGroupItem value="analyze" className="px-3 text-xs">
                  Analyze (execute + rollback)
                </ToggleGroupItem>
                <ToggleGroupItem value="estimate" className="px-3 text-xs">
                  Estimate (never execute)
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field label="Statement timeout" hint="Queries running longer are cancelled. 1–600 seconds.">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  max={600}
                  className="w-24 font-mono text-xs"
                  value={Math.round(form.analysis.statementTimeoutMs / 1000)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      analysis: {
                        ...form.analysis,
                        statementTimeoutMs: Math.max(1, Math.min(600, Number(e.target.value) || 1)) * 1000,
                      },
                    })
                  }
                />
                <span className="text-xs text-muted-foreground">seconds</span>
              </div>
            </Field>
          </Section>

          <Section title="Privacy" description="What leaves this machine.">
            <ul className="space-y-2 text-xs/relaxed text-muted-foreground">
              <li>
                <PaneLabel className="mr-2 text-foreground/70">Stored locally</PaneLabel>
                Connections, history and settings in a SQLite file in your app data folder. Passwords and API keys in
                the OS keychain.
              </li>
              <li>
                <PaneLabel className="mr-2 text-foreground/70">Sent to the advisor</PaneLabel>
                Only when you click Review plan: the SQL, the normalized plan, and table schema facts (column names,
                indexes, row counts). Never row data.
              </li>
              <li>
                <PaneLabel className="mr-2 text-foreground/70">Telemetry</PaneLabel>
                None.
              </li>
            </ul>
          </Section>
        </div>
      </ScrollArea>
    </div>
  )
}
