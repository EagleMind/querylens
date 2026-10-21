import { type FormEvent, useState } from 'react'

import { Logo } from '@/components/Logo'
import { ErrorNote } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, api } from '@/lib/api'

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
    <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <div className="grid w-full max-w-sm gap-6">
        <div className="flex justify-center">
          <Logo />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Sign in</CardTitle>
            {!configured && (
              <CardDescription>This deployment has no admin token yet. Set the ADMIN_TOKEN secret on the Worker, then reload this page.</CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="token">Admin token</Label>
                <Input
                  id="token"
                  type="password"
                  autoComplete="current-password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={!configured}
                />
              </div>
              <ErrorNote error={error} />
              <Button type="submit" className="w-full" disabled={busy || !configured || !token.trim()}>
                Sign in
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
