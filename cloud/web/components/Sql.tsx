// SQL (and MongoDB commands) with light syntax colouring: keywords, strings, numbers and placeholders.
// A small tokenizer, not a parser: it only has to colour statements the SDK sent.
import { memo } from 'react'

import { cn } from '@/lib/utils'

const KEYWORDS = new Set(
  (
    'select from where and or not in is null as on join left right inner outer full cross using group by order ' +
    'having limit offset insert into values update set delete returning distinct union all exists between like ' +
    'ilike case when then else end asc desc create table index alter drop with begin commit rollback for share ' +
    'nowait skip locked default count sum avg min max coalesce true false primary key references unique ' +
    // MongoDB commands and cursor methods, as the SDK writes them (`db.orders.find(…).sort(…)`).
    'find aggregate findandmodify sort'
  ).split(' '),
)

type Kind = 'keyword' | 'string' | 'number' | 'param' | 'comment' | 'text'

const TOKEN =
  /('(?:[^']|'')*'?)|(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"]|"")*"?|`[^`]*`?)|(\$\d+|\?|:[A-Za-z_]\w*|#\w+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g

function tokenize(sql: string): [Kind, string][] {
  const out: [Kind, string][] = []
  let last = 0
  for (const m of sql.matchAll(TOKEN)) {
    if (m.index > last) out.push(['text', sql.slice(last, m.index)])
    const [all, str, comment, quoted, param, num, word] = m
    const kind: Kind = str
      ? 'string'
      : comment
        ? 'comment'
        : quoted
          ? 'text'
          : param
            ? 'param'
            : num
              ? 'number'
              : word && KEYWORDS.has(word.toLowerCase())
                ? 'keyword'
                : 'text'
    out.push([kind, all])
    last = m.index + all.length
  }
  if (last < sql.length) out.push(['text', sql.slice(last)])
  return out
}

const STYLE: Record<Kind, string | undefined> = {
  keyword: 'text-sql-keyword',
  string: 'text-sql-string',
  number: 'text-sql-literal',
  param: 'text-sql-literal',
  comment: 'text-muted-foreground italic',
  text: undefined,
}

/** Inline SQL; `plain` drops the colours (for statements shown as context). */
export const Sql = memo(function Sql({ sql, plain, className }: { sql: string; plain?: boolean; className?: string }) {
  if (plain) return <span className={className}>{sql}</span>
  return (
    <span className={className}>
      {tokenize(sql).map(([kind, text], i) => (STYLE[kind] ? <span key={i} className={cn(STYLE[kind])}>{text}</span> : text))}
    </span>
  )
})
