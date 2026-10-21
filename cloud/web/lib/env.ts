// The SDK's environment variables, and the env file the project page builds from the ones a
// user picks for a service (see integrations/node: index.cjs and monitor.cjs read them).
// Pure: no React, no I/O.

export type EnvName =
  | 'QUERYLENS_DSN'
  | 'QUERYLENS_ENVIRONMENT'
  | 'QUERYLENS_RELEASE'
  | 'QUERYLENS_SOURCE_CONTEXT'
  | 'QUERYLENS_SEND_VALUES'
  | 'QUERYLENS_SAMPLE_RATE'
  | 'QUERYLENS_DISABLED'

export interface EnvVar {
  name: EnvName
  /** What it does, in a sentence. */
  help: string
  /** `flag`: set to 1 when chosen; `text` / `rate`: a value to fill in. */
  kind: 'flag' | 'text' | 'rate'
  /** The value a chosen field starts with. */
  initial?: string
  placeholder?: string
  /** Chosen until unticked. */
  suggested?: boolean
  /** Why to think before turning it on. */
  caution?: string
}

export const ENV_VARS: EnvVar[] = [
  {
    name: 'QUERYLENS_ENVIRONMENT',
    help: 'The environment the service runs in. Without it, NODE_ENV is used, else production.',
    kind: 'text',
    initial: 'production',
    placeholder: 'production',
  },
  {
    name: 'QUERYLENS_RELEASE',
    help: 'The version deployed, for regressions. Found on its own on Vercel, Render, Railway, Heroku, Cloudflare Pages and GitHub Actions.',
    kind: 'text',
    placeholder: 'a commit SHA or version',
  },
  {
    name: 'QUERYLENS_SOURCE_CONTEXT',
    help: 'Send the code around the lines that ran each reported query, secrets masked, so reports show it and AI can rewrite it.',
    kind: 'flag',
    suggested: true,
  },
  {
    name: 'QUERYLENS_SEND_VALUES',
    help: 'Send SQL literals and parameters with the queries, instead of a hash of them.',
    kind: 'flag',
    caution: 'Values can hold personal data. Best kept to development.',
  },
  {
    name: 'QUERYLENS_SAMPLE_RATE',
    help: 'The share of requests without a problem sent to the live feed, from 0 to 1. Without it, the project’s setting applies.',
    kind: 'rate',
    initial: '0.05',
    placeholder: '0.05',
  },
  {
    name: 'QUERYLENS_DISABLED',
    help: 'Turn the SDK off while keeping the DSN set.',
    kind: 'flag',
  },
]

/** Which variables are chosen, and the values typed for them. */
export type EnvChoice = Partial<Record<EnvName, { on: boolean; value: string }>>

export function initialChoice(): EnvChoice {
  return Object.fromEntries(ENV_VARS.map((v) => [v.name, { on: Boolean(v.suggested), value: v.initial ?? '' }]))
}

/** Why a chosen value can't go into the file; `null` when it can. */
export function problem(v: EnvVar, value: string): string | null {
  const s = value.trim()
  if (v.kind === 'flag') return null
  if (!s) return 'Fill in a value, or untick it.'
  if (v.kind === 'rate') {
    const n = Number(s)
    if (!Number.isFinite(n) || n < 0 || n > 1) return 'A number from 0 to 1, like 0.05.'
  }
  if (/[\r\n]/.test(s)) return 'One line only.'
  return null
}

/** As an env file reads it: bare when plain, double-quoted otherwise. */
export function envValue(value: string): string {
  return /^[\w.,:/@+%-]*$/.test(value) ? value : JSON.stringify(value)
}

/** The env file for one service: its DSN, then each chosen variable whose value is valid. */
export function envFile(service: { name: string; dsn: string }, choice: EnvChoice): string {
  const lines = [`# QueryLens: ${service.name}`, `QUERYLENS_DSN=${envValue(service.dsn)}`]
  for (const v of ENV_VARS) {
    const c = choice[v.name]
    if (!c?.on || problem(v, c.value)) continue
    lines.push(`${v.name}=${v.kind === 'flag' ? '1' : envValue(c.value.trim())}`)
  }
  return lines.join('\n')
}
