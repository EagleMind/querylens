// Saving an export: the browser's download of a file made in the page.
import { type ExportTable, FORMATS, type FormatId, fileName } from './formats'

/** A byte-order mark, so Excel opens UTF-8 CSV and TSV with their accents and symbols intact. */
const BOM = '﻿'

export function download(name: string, mime: string, data: string | Uint8Array) {
  const blob = new Blob([data as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Write `table` in `format` and download it, named after `name` (what it is, where from). */
export function exportTable(table: ExportTable, format: FormatId, name: string[]) {
  const f = FORMATS.find((x) => x.id === format)!
  const data = f.write(table)
  download(fileName(name, f.extension), f.mime, typeof data === 'string' && (format === 'csv' || format === 'tsv') ? BOM + data : data)
}
