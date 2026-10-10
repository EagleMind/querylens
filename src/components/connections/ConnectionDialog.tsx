import { CheckCircle2Icon, FolderOpenIcon, KeyRoundIcon, Loader2Icon, PlugZapIcon, XCircleIcon } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'

import type { Connection } from '@/bindings/Connection'
import type { ConnectionInput } from '@/bindings/ConnectionInput'
import type { ConnectionTestResult } from '@/bindings/ConnectionTestResult'
import type { Engine } from '@/bindings/Engine'
import type { SslMode } from '@/bindings/SslMode'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CONNECTION_COLORS, ENGINES } from '@/lib/constants'
import { fmtMs } from '@/lib/format'
import { api, isTauri, pickDuckdbFile } from '@/lib/ipc'
import { useSaveConnection } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { useWorkspace } from '@/store/workspace'

interface FormState {
  name: string
  engine: Engine
  color: string
  host: string
  port: string
  database: string
  username: string
  password: string
  /** Password field was edited (otherwise the stored one is kept). */
  passwordTouched: boolean
  sslMode: SslMode
  filePath: string
}

function initialState(c: Connection | null): FormState {
  return {
    name: c?.name ?? '',
    engine: c?.engine ?? 'postgres',
    color: c?.color ?? CONNECTION_COLORS[0],
    host: c?.host ?? 'localhost',
    port: String(c?.port ?? 5432),
    database: c?.database ?? '',
    username: c?.username ?? '',
    password: '',
    passwordTouched: false,
    sslMode: c?.sslMode ?? 'prefer',
    filePath: c?.filePath ?? '',
  }
}

const isServer = (engine: Engine) => ENGINES[engine].defaultPort !== null
/** A full MongoDB connection string typed into Host (Atlas, replica sets). */
const isUri = (host: string) => /^mongodb(\+srv)?:\/\//.test(host.trim())

function toInput(f: FormState, id: string | null): ConnectionInput {
  const server = isServer(f.engine)
  return {
    id,
    name: f.name.trim(),
    engine: f.engine,
    color: f.color,
    host: server ? f.host.trim() : null,
    port: server && f.port && !isUri(f.host) ? Number(f.port) : null,
    database: server ? f.database.trim() || null : null,
    username: server ? f.username.trim() || null : null,
    sslMode: f.sslMode,
    filePath: server ? null : f.filePath.trim(),
    password: server && f.passwordTouched ? f.password : null,
  }
}

const PLACEHOLDERS: Record<Engine, { name: string; database: string; user: string }> = {
  postgres: { name: 'local-shop', database: 'postgres', user: 'postgres' },
  mysql: { name: 'shop-mysql', database: 'shop', user: 'root' },
  mongodb: { name: 'shop-mongo', database: 'shop', user: 'none' },
  duckdb: { name: 'analytics', database: '', user: '' },
}

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; result: ConnectionTestResult }
  | { status: 'error'; message: string }

export function ConnectionDialog() {
  const editing = useUi((s) => s.connectionDialog)
  const close = useUi((s) => s.closeConnectionDialog)
  return (
    <Dialog open={editing !== undefined} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-[520px]">
        {/* Keyed so each open starts from the connection being edited. */}
        {editing !== undefined && <ConnectionForm key={editing?.id ?? 'new'} editing={editing} onDone={close} />}
      </DialogContent>
    </Dialog>
  )
}

function ConnectionForm({ editing, onDone: close }: { editing: Connection | null; onDone: () => void }) {
  const setConnectionId = useWorkspace((s) => s.setConnectionId)
  const save = useSaveConnection()
  const [form, setForm] = useState<FormState>(() => initialState(editing))
  const [test, setTest] = useState<TestState>({ status: 'idle' })

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setTest({ status: 'idle' })
  }
  const id = editing?.id ?? null
  const server = isServer(form.engine)
  const ph = PLACEHOLDERS[form.engine]

  /** Switching engine moves the port to the new default unless it was customised. */
  function setEngine(engine: Engine) {
    setForm((f) => {
      const oldDefault = String(ENGINES[f.engine].defaultPort ?? '')
      const port = !f.port || f.port === oldDefault ? String(ENGINES[engine].defaultPort ?? '') : f.port
      return { ...f, engine, port }
    })
    setTest({ status: 'idle' })
  }

  async function runTest() {
    setTest({ status: 'running' })
    try {
      const result = await api.testConnection(toInput({ ...form, name: form.name || 'test' }, id))
      setTest({ status: 'ok', result })
    } catch (e) {
      setTest({ status: 'error', message: (e as Error).message })
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const saved = await save.mutateAsync(toInput(form, id))
    if (!id) setConnectionId(saved.id)
    toast.success(id ? `Updated ${saved.name}` : `Added ${saved.name}`)
    close()
  }

  async function browse() {
    const path = await pickDuckdbFile()
    if (path) {
      setForm((f) => ({
        ...f,
        filePath: path,
        name:
          f.name ||
          path
            .split(/[\\/]/)
            .pop()!
            .replace(/\.\w+$/, ''),
      }))
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{id ? 'Edit connection' : 'New connection'}</DialogTitle>
        <DialogDescription>Passwords are stored in your OS keychain, never in QueryLens's database.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-4">
        <div className="flex items-end gap-3">
          <Field label="Engine">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              spacing={0}
              value={form.engine}
              onValueChange={(v) => v && setEngine(v as Engine)}
            >
              {(Object.keys(ENGINES) as Engine[]).map((e) => (
                <ToggleGroupItem key={e} value={e} className="px-3 text-xs">
                  {ENGINES[e].label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
          <Field label="Color" className="ml-auto">
            <div className="flex h-7 items-center gap-1.5">
              {CONNECTION_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  onClick={() => set('color', c)}
                  className={cn(
                    'size-4 rounded-full ring-offset-2 ring-offset-popover transition',
                    form.color === c ? 'ring-2 ring-foreground/70' : 'opacity-60 hover:opacity-100',
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </Field>
        </div>

        <Field label="Name">
          <Input autoFocus placeholder={ph.name} value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>

        {server ? (
          <>
            <div className="grid grid-cols-[1fr_96px] gap-3">
              <Field label={form.engine === 'mongodb' ? 'Host or connection string' : 'Host'}>
                <Input
                  className="font-mono text-xs"
                  placeholder={form.engine === 'mongodb' ? 'localhost or mongodb+srv://…' : 'localhost'}
                  value={form.host}
                  onChange={(e) => set('host', e.target.value)}
                />
              </Field>
              <Field label="Port">
                <Input
                  className="font-mono text-xs"
                  inputMode="numeric"
                  disabled={isUri(form.host)}
                  value={form.port}
                  onChange={(e) => set('port', e.target.value.replace(/\D/g, '').slice(0, 5))}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Database">
                <Input
                  className="font-mono text-xs"
                  placeholder={ph.database}
                  value={form.database}
                  onChange={(e) => set('database', e.target.value)}
                />
              </Field>
              <Field label="User">
                <Input
                  className="font-mono text-xs"
                  placeholder={ph.user}
                  value={form.username}
                  onChange={(e) => set('username', e.target.value)}
                />
              </Field>
            </div>
            <div className="grid grid-cols-[1fr_140px] gap-3">
              <Field label="Password">
                <div className="relative">
                  <KeyRoundIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="password"
                    className="pl-8 font-mono text-xs"
                    placeholder={editing?.hasPassword ? '•••••••• (stored in keychain)' : 'none'}
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value, passwordTouched: true }))}
                  />
                </div>
              </Field>
              <Field label="SSL">
                <Select value={form.sslMode} onValueChange={(v) => set('sslMode', v as SslMode)}>
                  <SelectTrigger className="w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="disable">Disable</SelectItem>
                    <SelectItem value="prefer">Prefer</SelectItem>
                    <SelectItem value="require">Require</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </>
        ) : (
          <Field label="Database file">
            <div className="flex gap-2">
              <Input
                className="font-mono text-xs"
                placeholder="C:\data\analytics.duckdb"
                value={form.filePath}
                onChange={(e) => set('filePath', e.target.value)}
              />
              {isTauri() && (
                <Button type="button" variant="outline" onClick={browse}>
                  <FolderOpenIcon /> Browse
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                className="font-mono text-xs"
                onClick={() => set('filePath', ':memory:')}
              >
                :memory:
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Files open read-only. Use <code className="font-mono">:memory:</code> to profile queries over Parquet/CSV
              with <code className="font-mono">read_parquet()</code>.
            </p>
          </Field>
        )}

        {test.status !== 'idle' && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-md border px-3 py-2 text-xs animate-rise',
              test.status === 'ok' && 'border-ok/35 text-ok',
              test.status === 'error' && 'border-destructive/30 bg-destructive/5 text-destructive',
              test.status === 'running' && 'text-muted-foreground',
            )}
          >
            {test.status === 'running' && <Loader2Icon className="size-3.5 animate-spin" />}
            {test.status === 'ok' && <CheckCircle2Icon className="mt-px size-3.5 shrink-0" />}
            {test.status === 'error' && <XCircleIcon className="mt-px size-3.5 shrink-0" />}
            <span className="font-mono break-all whitespace-pre-wrap" data-selectable>
              {test.status === 'running' && 'Connecting…'}
              {test.status === 'ok' && `Connected in ${fmtMs(test.result.latencyMs)} · ${test.result.serverVersion}`}
              {test.status === 'error' && test.message}
            </span>
          </div>
        )}
      </div>

      <DialogFooter className="sm:justify-between">
        <Button type="button" variant="outline" onClick={runTest} disabled={test.status === 'running'}>
          <PlugZapIcon /> Test connection
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Loader2Icon className="animate-spin" />}
            {id ? 'Save' : 'Add connection'}
          </Button>
        </div>
      </DialogFooter>
    </form>
  )
}
