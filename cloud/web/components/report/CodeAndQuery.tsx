// Card 4, where in your code, and card 5, the query itself: where to make the change, then
// what exactly ran.
import { FileCode2Icon } from 'lucide-react'

import type { IssueDetail } from '../../../bindings/IssueDetail'
import type { SourceSnippet } from '../../../bindings/SourceSnippet'
import { CodeSnippet } from '@/components/Code'
import { CodeBlock, CopyButton } from '@/components/common'
import { Pairs, ReportCard } from '@/components/report/ReportCard'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { STATEMENT_ACTION, type LiveQuery, mongoCommand, valuesSent } from '@/lib/queries'
import { fmtCount } from '@/lib/format'

/** Every line that ran the query, from its issues (counted across requests), this one first. */
function linesOf(q: LiveQuery, details: IssueDetail[]): { origin: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const d of details) for (const o of d.origins) counts.set(o.origin, Math.max(counts.get(o.origin) ?? 0, o.count))
  return [...counts]
    .map(([origin, count]) => ({ origin, count }))
    .sort((a, b) => Number(b.origin === q.statement.origin) - Number(a.origin === q.statement.origin) || b.count - a.count)
}

export function CodeCard({ q, source, details }: { q: LiveQuery; source: SourceSnippet | null | undefined; details: IssueDetail[] }) {
  const origin = q.statement.origin
  const lines = linesOf(q, details)
  return (
    <ReportCard
      label="Where in your code"
      details={
        lines.length > 1 ? (
          <ul className="grid gap-1">
            {lines.map((l) => (
              <li key={l.origin} className="flex items-center justify-between gap-4 font-mono text-xs">
                <span className="truncate">{l.origin}</span>
                <span className="shrink-0 text-muted-foreground tabular">{fmtCount(l.count)}×</span>
              </li>
            ))}
          </ul>
        ) : undefined
      }
      detailsLabel={`Details: ${lines.length} lines that run this query`}
    >
      {origin ? (
        <div className="flex items-center gap-2 rounded-md border border-primary/25 bg-primary/[0.06] py-1 pr-1 pl-3">
          <FileCode2Icon className="size-4 shrink-0 text-primary" aria-hidden />
          <code className="min-w-0 flex-1 truncate font-mono text-sm font-medium" title={origin}>
            {origin}
          </code>
          <CopyButton value={origin} label="Copy location" />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No line of your code was on the stack when it ran.</p>
      )}
      {source && <CodeSnippet snippet={source} />}
    </ReportCard>
  )
}

export function QueryCard({ q, tables }: { q: LiveQuery; tables: string[] | undefined }) {
  const s = q.statement
  const sent = valuesSent(s)
  const mongo = mongoCommand(s.sql) !== null
  const action = STATEMENT_ACTION[q.type]
  return (
    <ReportCard
      label={mongo ? 'The command' : 'The query'}
      details={
        <div className="grid gap-4">
          <Pairs
            items={[
              ['Values', sent ? (s.params.length ? `${s.params.length} sent, below` : 'None') : 'Kept in your app: the SDK sends the query without them, and a hash to tell runs apart'],
              ['Reads or writes', `${action === 'read' ? 'Reads' : action === 'write' ? 'Writes' : 'Other'} (${q.verb})`],
              ...(tables?.length ? ([[mongo ? 'Collections' : 'Tables', <span className="font-mono text-xs">{tables.join(', ')}</span>]] as [string, React.ReactNode][]) : []),
              ['Grouped with', 'Every run of this same query, whatever its values: the history and problems are about all of them'],
            ]}
          />
          {sent && s.params.length > 0 && (
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-20">Value</TableHead>
                    <TableHead>As sent</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {s.params.map((p, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{mongo ? i + 1 : `$${i + 1}`}</TableCell>
                      <TableCell className="font-mono text-xs break-all whitespace-normal">
                        {p === null ? <span className="text-muted-foreground">NULL</span> : p}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      }
      detailsLabel="Details: values, tables, grouping"
    >
      <CodeBlock code={s.sql} sql />
    </ReportCard>
  )
}
