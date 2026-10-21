import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { test } from 'node:test'

import { type ExportTable, FORMATS, fileName, toCsv, toHtml, toJson, toMarkdown, toNdjson, toTsv } from '../web/lib/export/formats.ts'
import { columnName, crc32, sheetName, xlsx } from '../web/lib/export/xlsx.ts'

const table: ExportTable = {
  title: 'Live queries',
  columns: [
    { key: 'origin', label: 'Code' },
    { key: 'sql', label: 'SQL' },
    { key: 'ms', label: 'Duration (ms)' },
  ],
  rows: [
    { origin: 'src/orders.js:16', sql: 'SELECT "id", a FROM t WHERE x = ?', ms: 1.25 },
    { origin: null, sql: '=HYPERLINK("x")', ms: 3 },
    { origin: 'a|b', sql: 'line one\nline two', ms: null },
  ],
}

test('CSV quotes what needs quoting and defuses formulas', () => {
  assert.equal(
    toCsv(table),
    [
      'Code,SQL,Duration (ms)',
      'src/orders.js:16,"SELECT ""id"", a FROM t WHERE x = ?",1.25',
      `,"'=HYPERLINK(""x"")",3`,
      'a|b,"line one\nline two",',
      '',
    ].join('\r\n'),
  )
  assert.equal(toTsv(table).split('\r\n')[1], 'src/orders.js:16\t"SELECT ""id"", a FROM t WHERE x = ?"\t1.25')
})

test('JSON and NDJSON keep values and types, keyed by column', () => {
  assert.deepEqual(JSON.parse(toJson(table))[0], { origin: 'src/orders.js:16', sql: 'SELECT "id", a FROM t WHERE x = ?', ms: 1.25 })
  const lines = toNdjson(table).trim().split('\n')
  assert.equal(lines.length, 3)
  assert.deepEqual(JSON.parse(lines[2]), { origin: 'a|b', sql: 'line one\nline two', ms: null })
})

test('Markdown escapes pipes and keeps a row per line; HTML escapes markup', () => {
  const md = toMarkdown(table)
  assert.match(md, /^# Live queries\n\n\| Code \| SQL \| Duration \(ms\) \|\n\| --- \| --- \| --- \|\n/)
  assert.match(md, /\| a\\\|b \| line one<br>line two \|  \|/)
  const html = toHtml({ ...table, rows: [{ origin: '<b>', sql: 'a & b', ms: 2 }] })
  assert.match(html, /<td>&lt;b&gt;<\/td><td>a &amp; b<\/td><td class="n">2<\/td>/)
})

test('crc32 and column names match their references', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  assert.equal(sheetName('Live queries: [orders]/prod'), 'Live queries   orders  prod')
})

/** The entries of a zip archive, by name (stored or deflated). */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  const out = new Map<string, string>()
  let at = 0
  while (view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true)
    const size = view.getUint32(at + 18, true)
    const nameLength = view.getUint16(at + 26, true)
    const extra = view.getUint16(at + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength))
    const start = at + 30 + nameLength + extra
    const data = bytes.subarray(start, start + size)
    assert.equal(crc32(data), view.getUint32(at + 14, true), `${name}: checksum`)
    out.set(name, new TextDecoder().decode(method === 8 ? inflateRawSync(data) : data))
    at = start + size
  }
  return out
}

test('an xlsx is a valid zip with the workbook, its sheet, header bold and numbers as numbers', () => {
  const file = unzip(xlsx(table.title, table.columns.map((c) => c.label), table.rows.map((r) => table.columns.map((c) => r[c.key] ?? null))))
  assert.deepEqual([...file.keys()].sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'])
  const sheet = file.get('xl/worksheets/sheet1.xml')!
  assert.match(sheet, /<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Code<\/t><\/is><\/c>/)
  assert.match(sheet, /<c r="C2"><v>1.25<\/v><\/c>/)
  assert.match(sheet, /<t xml:space="preserve">SELECT &quot;id&quot;, a FROM t WHERE x = \?<\/t>/)
  assert.match(file.get('xl/workbook.xml')!, /<sheet name="Live queries"/)
})

test('every format writes, and file names say what and when', () => {
  for (const f of FORMATS) assert.ok(f.write(table).length > 0, f.id)
  assert.equal(fileName(['Demo shop', 'Live queries'], 'csv', new Date(2026, 9, 21, 14, 2)), 'querylens-demo-shop-live-queries-20261021-1402.csv')
})
