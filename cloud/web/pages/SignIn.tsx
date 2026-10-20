import { KeyRoundIcon } from 'lucide-react'
import { type FormEvent, useState } from 'react'

import { Logo } from '../components/Logo'
import { Button, ErrorNote } from '../components/ui'
import { ApiError, api } from '../lib/api'

export function SignIn({ configured, onSignedIn }: { configured: boolean; onSignedIn: (token: string) => void }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.verify(token.trim())
      onSignedIn(token.trim())
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? new Error('That token isn’t right.') : err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="blueprint grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-[3px] border border-border bg-panel p-6 shadow-2xl">
        <Logo />
        <div>
          <h1 className="text-[20px] font-semibold">Sign in</h1>
          <p className="mt-1 text-[13px]/relaxed text-muted">
            {configured
              ? 'Enter the admin token you set on the Worker (the ADMIN_TOKEN secret).'
              : 'This deployment has no admin token yet. Set the ADMIN_TOKEN secret on the Worker, then come back.'}
          </p>
        </div>
        <label className="block">
          <span className="sr-only">Admin token</span>
          <span className="relative block">
            <KeyRoundIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted" />
            <input
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={!configured}
              placeholder="Admin token"
              className="h-9 w-full rounded-[3px] border border-border bg-background pr-2 pl-8 text-[13px] placeholder:text-muted"
            />
          </span>
        </label>
        <ErrorNote error={error} />
        <Button type="submit" variant="primary" className="w-full" disabled={busy || !configured || !token.trim()}>
          Sign in
        </Button>
      </form>
    </main>
  )
}
