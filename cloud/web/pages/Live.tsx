import { ActivityIcon, ChevronRightIcon, PauseIcon, PlayIcon, RadioIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { Project } from '../../../src/bindings/Project'
import { Statements } from '../components/Statements'
import { ThroughputChart } from '../components/ThroughputChart'
import { Button, Empty, Select, Severity, Stat, cx } from '../components/ui'
import { FINDING_KINDS, fmtClock, fmtCount, fmtMs } from '../lib/format'
import { type LiveState, type LiveTransaction } from '../lib/live'
import { href, onLinkClick } from '../lib/router'

function TransactionRow({ t }: { t: LiveTransaction }) {
  const [open, setOpen] = useState(false)
  const flagged = t.findings.length > 0
  return (
    <li className="animate-rise border-b border-rule last:border-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="grid w-full grid-cols-[1rem_4.25rem_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2 text-left hover:bg-raised/60 sm:grid-cols-[1rem_4.25rem_minmax(0,1fr)_5rem_5.5rem_4rem]"
      >
        <ChevronRightIcon className={cx('size-3.5 text-muted transition-transform', open && 'rotate-90')} />
        <span className="font-mono text-[11.5px] text-muted tabular">{fmtClock(t.at)}</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className={cx('size-1.5 shrink-0 rounded-full', flagged ? 'bg-sev-high' : 'bg-ok')} aria-hidden />
          <span className="truncate font-mono text-[12.5px]">{t.name}</span>
          {t.findings.slice(0, 2).map((f) => (
            <span key={f.issueId} className="hidden shrink-0 rounded-[2px] border border-rule px-1.5 py-px text-[11px] text-foreground/80 md:inline">
              {FINDING_KINDS[f.kind]}
            </span>
          ))}
          {t.environment !== 'production' && (
            <span className="hidden shrink-0 text-[11px] text-muted lg:inline">{t.environment}</span>
          )}
        </span>
        <span className="hidden text-right text-[12px] tabular sm:block">{fmtMs(t.durationMs)}</span>
        <span className="hidden text-right text-[12px] text-muted tabular sm:block">{fmtMs(t.dbMs)} DB</span>
        <span className="text-right text-[12px] text-muted tabular">{t.statements.length} stmt</span>
      </button>
      {open && (
        <div className="space-y-3 px-3 pt-1 pb-4 sm:pl-10">
          {t.findings.length > 0 && (
            <ul className="space-y-1.5">
              {t.findings.map((f) => (
                <li key={f.issueId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                  <Severity severity={f.severity} />
                  <a href={href({ page: 'issues', issue: f.issueId })} onClick={onLinkClick} className="underline decoration-rule underline-offset-4 hover:decoration-signal">
                    {f.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <Statements statements={t.statements} />
          {t.release && <p className="text-[11.5px] text-muted">Release {t.release}</p>}
        </div>
      )}
    </li>
  )
}

export function LivePage({ project, live, paused, onPause }: { project: Project; live: LiveState; paused: boolean; onPause: (p: boolean) => void }) {
  const [env, setEnv] = useState('')
  const [onlyFlagged, setOnlyFlagged] = useState(false)
  const environments = useMemo(() => [...new Set(live.transactions.map((t) => t.environment))].sort(), [live.transactions])
  const shown = live.transactions.filter((t) => (!env || t.environment === env) && (!onlyFlagged || t.findings.length > 0))

  // Each SDK reports statistics once a minute; the latest complete minute is the headline.
  const latest = live.minutes.at(-1)
  const since = latest ? `minute of ${new Date(latest.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}` : 'waiting for SDK statistics'
  const flaggedCount = live.transactions.filter((t) => t.findings.length > 0).length

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Statements" value={latest ? fmtCount(latest.statements) : '–'} hint={since} />
        <Stat label="DB time" value={latest ? fmtMs(latest.dbMs) : '–'} hint={since} />
        <Stat label="Failed statements" value={latest ? fmtCount(latest.errors) : '–'} hint={since} />
        <Stat label="Flagged requests" value={fmtCount(flaggedCount)} hint={`of ${fmtCount(live.transactions.length)} received since you opened this page`} />
      </div>

      <ThroughputChart minutes={live.minutes} />

      {live.issues.length > 0 && (
        <section aria-label="New issues" className="rounded-[3px] border border-sev-high/30 bg-sev-high/[0.06] px-4 py-3">
          <p className="text-[12px] font-semibold text-sev-high">New and returning issues</p>
          <ul className="mt-1.5 space-y-1">
            {live.issues.slice(0, 5).map(({ issue, regressed }) => (
              <li key={`${issue.id}-${issue.lastSeen}`} className="flex items-center gap-3 text-[13px]">
                <Severity severity={issue.severity} />
                <a href={href({ page: 'issues', issue: issue.id })} onClick={onLinkClick} className="truncate hover:underline">
                  {issue.title}
                </a>
                <span className="shrink-0 text-[11.5px] text-muted">{regressed ? 'regressed' : 'new'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Requests" className="rounded-[3px] border border-rule bg-panel">
        <header className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-2">
          <h2 className="mr-auto flex items-center gap-2 text-[14px] font-semibold">
            <ActivityIcon className="size-4 text-muted" /> Requests
          </h2>
          <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} className="accent-[var(--signal)]" />
            Only with problems
          </label>
          {environments.length > 1 && (
            <Select label="Environment" value={env} onChange={setEnv}>
              <option value="">All environments</option>
              {environments.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          )}
          <Button size="sm" onClick={() => onPause(!paused)}>
            {paused ? <PlayIcon /> : <PauseIcon />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </header>
        {shown.length === 0 ? (
          <div className="p-4">
            <Empty title={live.connection === 'live' ? 'Waiting for requests' : 'Connecting…'} icon={<RadioIcon />}>
              Requests appear here as the SDK sends them: every request with a problem, plus{' '}
              {Math.round(project.settings.liveSampleRate * 100)}% of the others in production (all of them in development).
              No app yet? Settings has the setup.
            </Empty>
          </div>
        ) : (
          <ul>
            {shown.map((t) => (
              <TransactionRow key={t.key} t={t} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
