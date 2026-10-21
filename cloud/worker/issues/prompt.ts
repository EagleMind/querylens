// An issue as a brief for a coding agent working in the app's repository: what's wrong,
// where in the code, the statements of the request it was last seen in, the code around it
// when the SDK sent it, and the fix querylens-core wrote for the ORM. The agent has the
// repository; the backend has the evidence. Pure: no I/O.
import type { CapturedStatement } from '../../bindings/CapturedStatement'
import type { SourceSnippet } from '../../bindings/SourceSnippet'
import type { IssueContext } from '../../shared/api'
import { fmtCount, fmtMs } from '../../shared/format.ts'
import { FINDING_KINDS, ORMS } from '../../shared/labels.ts'

/** Lines of the request's timeline written out, and SQL characters per line. */
const TIMELINE_LINES = 40
const TIMELINE_SQL = 160

const FENCE: Record<string, string> = {
  js: 'js',
  cjs: 'js',
  mjs: 'js',
  jsx: 'jsx',
  ts: 'ts',
  cts: 'ts',
  mts: 'ts',
  tsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  go: 'go',
  php: 'php',
}

/** The code fence language for `file:line` or a path. */
export function fenceFor(origin: string): string {
  const file = origin.replace(/:\d+$/, '')
  return FENCE[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ?? ''
}

function oneLine(sql: string, max: number): string {
  const flat = sql.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * A request's statements, one line each, with consecutive runs of the same statement shape
 * folded into one line ("×50"): an N+1 reads as what it is, and stays short.
 */
export function timeline(statements: CapturedStatement[], fingerprint: string): string[] {
  const lines: string[] = []
  for (let i = 0; i < statements.length; ) {
    let j = i + 1
    while (j < statements.length && statements[j].fingerprint === statements[i].fingerprint) j++
    const run = statements.slice(i, j)
    const s = run[0]
    const mark = s.fingerprint === fingerprint ? '→' : ' '
    const seq = run.length > 1 ? `#${s.seq}–${run[run.length - 1].seq}` : `#${s.seq}`
    const times = run.length > 1 ? ` ×${run.length}` : ''
    const ms = fmtMs(run.reduce((n, x) => n + x.durationMs, 0))
    const failed = run.some((x) => x.error) ? ' FAILED' : ''
    const origin = s.origin ? `  ← ${s.origin}` : ''
    lines.push(`${mark} ${seq}${times} +${fmtMs(s.atMs)} (${ms})${failed}  ${oneLine(s.sql, TIMELINE_SQL)}${origin}`)
    i = j
  }
  if (lines.length <= TIMELINE_LINES) return lines
  return [...lines.slice(0, TIMELINE_LINES), `  … ${lines.length - TIMELINE_LINES} more lines`]
}

/** The snippet with line numbers, the origin's line marked. */
export function numbered(snippet: SourceSnippet): string {
  const target = Number(snippet.origin.slice(snippet.origin.lastIndexOf(':') + 1))
  const width = String(snippet.firstLine + snippet.lines.length - 1).length
  return snippet.lines
    .map((line, i) => {
      const n = snippet.firstLine + i
      return `${String(n).padStart(width)}${n === target ? '→' : ' '} ${line}`
    })
    .join('\n')
}

function block(lang: string, code: string): string {
  // A fence longer than any backtick run inside, so the code can't close it.
  const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${lang}\n${code}\n${fence}`
}

export function fixPrompt(ctx: IssueContext): string {
  const { detail: d, latest, sources } = ctx
  const issue = d.issue
  const orm = d.fix?.orm ?? ctx.backend?.orm ?? null
  const out: string[] = []

  out.push(`# Fix a database issue QueryLens found: ${issue.title}`)
  out.push(
    [
      `${FINDING_KINDS[issue.kind]}, ${issue.severity} severity, in ${ctx.backend ? `the ${ctx.backend.name} backend’s ` : ''}${issue.environment}`,
      `seen in ${fmtCount(issue.timesSeen)} ${issue.timesSeen === 1 ? 'request' : 'requests'} (first ${issue.firstSeen}, last ${issue.lastSeen})`,
      `${fmtMs(issue.impactMs)} of statement time so far`,
      orm ? `ORM: ${ORMS[orm]}` : null,
      issue.lastRelease ? `last seen in release ${issue.lastRelease}` : null,
    ]
      .filter(Boolean)
      .join('; ') + '.',
  )

  out.push('## What happens', issue.detail)

  if (d.origins.length > 0) {
    out.push(
      '## Where in the code',
      'The lines of application code that ran it, most frequent first:',
      d.origins.map((o) => `- \`${o.origin}\` (${fmtCount(o.count)}×)`).join('\n'),
    )
  } else {
    out.push('## Where in the code', 'No line of application code was on the stack: find the code from the SQL and the request below.')
  }

  out.push('## The statement', block('sql', d.sampleSql))
  if (d.parentSql) out.push('It runs once per row returned by:', block('sql', d.parentSql))

  if (latest) {
    out.push(
      `## The request it was last seen in: ${latest.transaction ?? 'background work'}`,
      `${fmtMs(latest.durationMs)} in total, ${latest.statements.length} statements, at ${latest.at}${latest.release ? ` (release ${latest.release})` : ''}. ` +
        'Statements in order; → marks this issue’s statement, ×N a run of the same statement:',
      block('', timeline(latest.statements, d.fingerprint).join('\n')),
    )
  }

  if (sources.length > 0) {
    out.push('## The code, as the SDK read it')
    for (const s of sources) out.push(`\`${s.origin}\`:`, block(fenceFor(s.origin), numbered(s)))
  }

  if (d.fix) {
    out.push(`## The fix QueryLens suggests${d.fix.orm ? ` for ${ORMS[d.fix.orm]}` : ''}`, d.fix.text)
    if (d.fix.code) out.push(block(fenceFor(d.origins[0]?.origin ?? ''), d.fix.code))
    if (d.fix.ddl) out.push('Schema change to go with it:', block('sql', `${d.fix.ddl};`))
  }

  out.push(
    '## What to do',
    [
      '1. Open the code above and find what runs this statement. If no line is given, search for the tables and columns in the SQL.',
      '2. Apply the fix in the style of the surrounding code. Keep the behaviour the same: the same rows, in the same order, the same response.',
      '3. Check the other lines listed for the same pattern, and fix them the same way.',
      d.fix?.ddl
        ? '4. Add the schema change as a migration, with the tool the project already uses.'
        : '4. If the fix needs an index or another schema change, add it as a migration, with the tool the project already uses.',
      '5. Run the tests that cover this code. Then say what you changed, and anything you weren’t sure about.',
    ].join('\n'),
    'Values in the SQL were replaced by `?` before leaving the app. Once the fix is deployed, mark the issue resolved in QueryLens: it comes back as regressed if the problem returns.',
  )

  return out.join('\n\n') + '\n'
}
