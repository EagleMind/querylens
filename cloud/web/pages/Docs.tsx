// How to get everything onto the query report: each section is what a "Not shown on this
// page" note links to (by its id), plus the settings behind the problems QueryLens flags.
import { type ReactNode, useEffect } from 'react'

import type { Project } from '../../bindings/Project'
import { CodeBlock } from '@/components/common'
import { fmtExact, fmtMs } from '@/lib/format'
import { cn } from '@/lib/utils'

const SECTIONS: { id: string; title: string }[] = [
  { id: 'line-of-code', title: 'The line of your code' },
  { id: 'source-context', title: 'Your code around that line' },
  { id: 'values', title: 'Parameter values' },
  { id: 'releases', title: 'Releases' },
  { id: 'regressions', title: 'Regressions' },
  { id: 'ai', title: 'AI-written changes' },
  { id: 'mcp', title: 'Coding agents (MCP)' },
  { id: 'thresholds', title: 'What counts as a problem' },
]

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="grid scroll-mt-20 lg:scroll-mt-6 gap-3 border-t pt-6 text-sm leading-relaxed target:[&>h2]:text-primary">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  )
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] whitespace-nowrap">{children}</code>
}

export function DocsPage({ projects }: { projects: Project[] }) {
  // Opened from a link with #section: go there once the page is drawn.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' })
    else window.scrollTo(0, 0)
  }, [])
  const origin = location.origin

  return (
    <div className="mx-auto grid w-full max-w-[60rem] gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label="On this page" className="lg:sticky lg:top-6 lg:self-start">
        <p className="mb-2 text-xs font-medium text-muted-foreground">On this page</p>
        <ul className="grid gap-1 text-sm">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="text-muted-foreground hover:text-foreground">
                {s.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="grid gap-6">
        <div className="grid gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">Docs</h1>
          <p className="text-sm text-muted-foreground">
            What the SDK and the backend need for the query report to show everything, and what decides that a query has a problem.
            The SDK reads its settings from environment variables, or from <Code>init()</Code> options.
          </p>
        </div>

        <Section id="line-of-code" title="The line of your code">
          <p>
            For every query, the SDK takes the first line of the call stack that’s in your code: outside <Code>node_modules</Code>, inside
            the directory the app runs from. Nothing to turn on. When no such line is found:
          </p>
          <ul className="grid list-disc gap-1 pl-5">
            <li>
              <span className="font-medium">The query ran from a library or a timer</span> with none of your code on the stack. Run the work
              inside <Code>withTransaction()</Code>, from your code.
            </li>
            <li>
              <span className="font-medium">TypeScript or a bundler</span>: lines point at the compiled file. Run Node with{' '}
              <Code>--enable-source-maps</Code> so they point at your sources.
            </li>
            <li>
              <span className="font-medium">Prisma</span> builds its queries away from your code: add the client extension.
            </li>
          </ul>
          <CodeBlock code={`const { queryLens } = require('querylens-node/prisma')\nconst prisma = new PrismaClient({ adapter }).$extends(queryLens())`} wrap={false} />
        </Section>

        <Section id="source-context" title="Your code around that line">
          <p>
            With source context on, the SDK sends the 10 lines before and after each line of your code that ran a reported query, once per
            line, read in the background. The report shows them, and AI-written changes need them. It’s off by default.
          </p>
          <CodeBlock code="QUERYLENS_SOURCE_CONTEXT=1" />
          <p className="text-muted-foreground">
            Only files inside your project are read. Assignments to keys, secrets, tokens and passwords, credentials in URLs and long
            key-like strings are masked before anything is sent.
          </p>
        </Section>

        <Section id="values" title="Parameter values">
          <p>
            In production the SDK removes values from every query before it leaves your app: literals become <Code>?</Code>, bound
            parameters are dropped, and only a hash is kept to tell runs apart (an N+1 has different values each time). To see the values,
            in development for example:
          </p>
          <CodeBlock code="QUERYLENS_SEND_VALUES=1" />
          <p className="text-muted-foreground">Values can be personal data: keep this off in production.</p>
        </Section>

        <Section id="releases" title="Releases">
          <p>
            A release ties each problem to the deploy that brought it, and lets regressions compare before and after it. The SDK reads it
            from <Code>QUERYLENS_RELEASE</Code>, or from the commit your host provides: Vercel, Render, Railway, Heroku, Cloudflare Pages,
            GitHub Actions and others.
          </p>
          <CodeBlock code={'QUERYLENS_RELEASE="$(git rev-parse --short HEAD)"'} />
        </Section>

        <Section id="regressions" title="Regressions">
          <p>
            Each query is compared with itself, before and after the latest release, from the statistics the SDK sends for every run. It
            counts as slower at 1.5 times its average before and 2 ms more per run, and as failing at twice its error rate before; both
            need 30 runs on each side. Without releases, the last day is compared with the week before.
          </p>
        </Section>

        <Section id="ai" title="AI-written changes">
          <p>
            The report can write the change a fix needs into your own code, with Workers AI in your Cloudflare account. It needs the{' '}
            <Code>AI</Code> binding on the Worker (in <Code>cloudflare.config.ts</Code>, then deploy again), and source context in the SDK.
          </p>
          <CodeBlock code={'env: {\n  AI: bindings.ai(),\n}'} wrap={false} />
          <p className="text-muted-foreground">
            The backend makes at most 80 AI calls a day, inside Workers AI’s free allowance, and reuses a change until the problem or your
            code changes.
          </p>
        </Section>

        <Section id="mcp" title="Coding agents (MCP)">
          <p>Coding agents can list problems, read each one as a fix brief, and mark them resolved, through this backend’s MCP server:</p>
          <CodeBlock code={`claude mcp add --transport http querylens ${origin}/mcp --header "Authorization: Bearer <admin token>"`} wrap={false} />
        </Section>

        <Section id="thresholds" title="What counts as a problem">
          <p>Each project has its own limits. The SDKs receive them with every reply, so a change applies within seconds.</p>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Project</th>
                  <th className="px-3 py-2 font-medium">Slow at</th>
                  <th className="px-3 py-2 font-medium">Loop at</th>
                  <th className="px-3 py-2 font-medium">Large at</th>
                  <th className="px-3 py-2 font-medium">Chatty at</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p, i) => (
                  <tr key={p.id} className={cn(i > 0 && 'border-t')}>
                    <td className="px-3 py-2">{p.name}</td>
                    <td className="px-3 py-2 tabular">{fmtMs(p.settings.slowMs)}</td>
                    <td className="px-3 py-2 tabular">{p.settings.loopMin} runs in a row</td>
                    <td className="px-3 py-2 tabular">{fmtExact(p.settings.largeRows)} rows</td>
                    <td className="px-3 py-2 tabular">{p.settings.chatty} statements</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground">Change them through the API:</p>
          <CodeBlock code={`curl -X PUT ${origin}/api/0/projects/<project id>/settings \\\n  -H "Authorization: Bearer <admin token>" \\\n  -d '{"slowMs": 200}'`} wrap={false} />
        </Section>
      </div>
    </div>
  )
}
