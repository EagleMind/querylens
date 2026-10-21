// Tables written out as files: CSV, TSV, Excel, JSON, NDJSON, Markdown and HTML. Every export in
// the dashboard builds an `ExportTable` and picks a format here.
// Pure: no React, no I/O (download.ts saves the result).
import { xlsx } from './xlsx.ts'

export type Cell = string | number | boolean | null

export interface ExportColumn {
  key: string
  label: string
}

export interface ExportTable {
  /** What the rows are, for the file name and the sheet or page title. */
  title: string
  columns: ExportColumn[]
  rows: Record<string, Cell>[]
}

export type FormatId = 'csv' | 'tsv' | 'xlsx' | 'json' | 'ndjson' | 'md' | 'html'

export interface Format {
  id: FormatId
  label: string
  extension: string
  mime: string
  write: (t: ExportTable) => string | Uint8Array
}

/** A spreadsheet would run text starting like a formula; a leading quote keeps it text. */
function defuse(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
}

function text(c: Cell): string {
  return c === null ? '' : String(c)
}

function delimited(t: ExportTable, sep: string): string {
  const cell = (c: Cell) => {
    const s = typeof c === 'string' ? defuse(c) : text(c)
    return /["\r\n]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [t.columns.map((c) => cell(c.label)), ...t.rows.map((r) => t.columns.map((c) => cell(r[c.key] ?? null)))]
  return `${lines.map((l) => l.join(sep)).join('\r\n')}\r\n`
}

/** Rows as objects keyed by column, in column order. */
function records(t: ExportTable): Record<string, Cell>[] {
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c) => [c.key, r[c.key] ?? null])))
}

export function toCsv(t: ExportTable): string {
  return delimited(t, ',')
}

export function toTsv(t: ExportTable): string {
  return delimited(t, '\t')
}

export function toJson(t: ExportTable): string {
  return `${JSON.stringify(records(t), null, 2)}\n`
}

export function toNdjson(t: ExportTable): string {
  return records(t)
    .map((r) => `${JSON.stringify(r)}\n`)
    .join('')
}

export function toMarkdown(t: ExportTable): string {
  const cell = (c: Cell) => text(c).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const head = `| ${t.columns.map((c) => cell(c.label)).join(' | ')} |`
  const rule = `| ${t.columns.map(() => '---').join(' | ')} |`
  const body = t.rows.map((r) => `| ${t.columns.map((c) => cell(r[c.key] ?? null)).join(' | ')} |`)
  return `# ${t.title}\n\n${[head, rule, ...body].join('\n')}\n`
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function toHtml(t: ExportTable): string {
  const head = t.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')
  const body = t.rows
    .map((r) => `<tr>${t.columns.map((c) => {
      const v = r[c.key] ?? null
      return `<td${typeof v === 'number' ? ' class="n"' : ''}>${escapeHtml(text(v))}</td>`
    }).join('')}</tr>`)
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t.title)}</title>
<style>
body { font: 14px/1.45 system-ui, sans-serif; margin: 24px; color: #1b1a22; background: #fff; }
table { border-collapse: collapse; }
th, td { border: 1px solid #dddae6; padding: 4px 8px; text-align: left; vertical-align: top; white-space: pre-wrap; }
th { background: #f4f2fa; }
td.n { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<h1>${escapeHtml(t.title)}</h1>
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
</body>
</html>
`
}

export const FORMATS: Format[] = [
  { id: 'csv', label: 'CSV', extension: 'csv', mime: 'text/csv;charset=utf-8', write: toCsv },
  { id: 'tsv', label: 'TSV', extension: 'tsv', mime: 'text/tab-separated-values;charset=utf-8', write: toTsv },
  {
    id: 'xlsx',
    label: 'Excel',
    extension: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    write: (t) => xlsx(t.title, t.columns.map((c) => c.label), t.rows.map((r) => t.columns.map((c) => r[c.key] ?? null))),
  },
  { id: 'json', label: 'JSON', extension: 'json', mime: 'application/json', write: toJson },
  { id: 'ndjson', label: 'NDJSON', extension: 'ndjson', mime: 'application/x-ndjson', write: toNdjson },
  { id: 'md', label: 'Markdown', extension: 'md', mime: 'text/markdown;charset=utf-8', write: toMarkdown },
  { id: 'html', label: 'HTML', extension: 'html', mime: 'text/html;charset=utf-8', write: toHtml },
]

/** `querylens-shop-live-queries-20261021-1432.csv`: what, where from, and when. */
export function fileName(parts: string[], extension: string, at = new Date()): string {
  const slug = parts
    .map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('-')
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
  return `querylens-${slug}-${stamp}.${extension}`
}
