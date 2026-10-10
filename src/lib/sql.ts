/** Remove comments and string/identifier literals so keyword checks don't false-match. */
function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
}

const WRITES: [RegExp, string][] = [
  [/\binsert\s+into\b/i, 'INSERT'],
  [/\bupdate\s+[\w."]+\s+(?:as\s+\w+\s+)?set\b/i, 'UPDATE'],
  [/\bdelete\s+from\b/i, 'DELETE'],
  [/\bmerge\s+into\b/i, 'MERGE'],
]

/** The data-modifying verb in a statement (including inside CTEs), or null for reads. */
export function writesData(sql: string): string | null {
  const s = stripNoise(sql)
  return WRITES.find(([re]) => re.test(s))?.[1] ?? null
}
