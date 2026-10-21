// Card 3: what to do. The one fix that covers the most serious problems (saying which), with
// the AI change and the fix prompt. Without a ready-made fix: the next step for a slow query,
// or the fix prompt, which lets a coding agent work it out.
import type { SuggestionState } from '../../../shared/api'
import { CodeBlock, Prose } from '@/components/common'
import { FixActions, CopyPromptButton } from '@/components/FixActions'
import { Pairs, ReportCard } from '@/components/report/ReportCard'
import { ORMS, fmtCount } from '@/lib/format'
import type { LiveQuery } from '@/lib/queries'
import { type Problem, coveredBy, primaryFix, slowNextStep } from '@/lib/report'

export function Fix({
  problems,
  q,
  ai,
  onAi,
}: {
  problems: Problem[]
  q: LiveQuery
  ai: SuggestionState | undefined
  onAi: (s: SuggestionState) => void
}) {
  if (problems.length === 0) return null
  const primary = primaryFix(problems)
  const projectId = q.request.projectId

  if (!primary) {
    const slow = problems.find((p) => p.kind === 'slow_query' && !p.causedBy)
    const first = problems.find((p) => p.finding)
    if (slow) {
      const step = slowNextStep(q)
      return (
        <ReportCard label="What to check next">
          <p className="text-sm leading-relaxed">{step.text}</p>
          <CodeBlock code={step.code} sql={!step.code.startsWith('db.')} />
          {slow.finding && (
            <div>
              <CopyPromptButton projectId={projectId} issueId={slow.finding.issueId} />
            </div>
          )}
        </ReportCard>
      )
    }
    return first?.finding ? (
      <ReportCard label="How to fix it">
        <p className="text-sm leading-relaxed text-muted-foreground">
          There’s no ready-made fix for this problem. The fix prompt gives a coding agent everything it needs to work one out: the
          problem, your code, the query and its request.
        </p>
        <div>
          <CopyPromptButton projectId={projectId} issueId={first.finding.issueId} />
        </div>
      </ReportCard>
    ) : null
  }

  const fix = primary.detail!.fix!
  const covered = coveredBy(problems, primary)
  const issueId = primary.finding!.issueId
  const otherLines = primary.detail!.origins.filter((o) => o.origin !== q.statement.origin)
  return (
    <ReportCard
      label={`How to fix it${fix.orm ? `, with ${ORMS[fix.orm]}` : ''}`}
      details={
        <Pairs
          items={[
            [
              'Same problem elsewhere',
              otherLines.length ? (
                <ul className="grid gap-0.5">
                  {otherLines.map((o) => (
                    <li key={o.origin} className="font-mono text-xs">
                      {o.origin} <span className="text-muted-foreground">({fmtCount(o.count)}×)</span>
                    </li>
                  ))}
                </ul>
              ) : (
                'No other line in your code'
              ),
            ],
            ['Schema change', fix.ddl ? 'Yes, shown above' : 'None needed'],
            ['The fix prompt', 'What your coding agent gets: the problem, your code, the query, every statement of its request, and this fix'],
          ]}
        />
      }
      detailsLabel="Details: other lines, schema change, the prompt"
    >
      {covered.length > 1 && (
        <p className="text-sm font-medium">Fixes {covered.length === 2 ? 'both problems' : `${covered.length} problems`}.</p>
      )}
      <p className="text-sm leading-relaxed">
        <Prose text={fix.text} />
      </p>
      {fix.code && <CodeBlock code={fix.code} wrap={false} />}
      {fix.ddl && <CodeBlock code={`${fix.ddl};`} sql />}
      <FixActions projectId={projectId} issueId={issueId} state={ai} onState={onAi} />
    </ReportCard>
  )
}
