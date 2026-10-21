// "Export": the rows a screen shows, in any of the formats, downloaded as a file. Built when
// chosen, so a large list costs nothing until it's exported.
import { DownloadIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { download, exportTable } from '@/lib/export/download'
import { type ExportTable, FORMATS, fileName } from '@/lib/export/formats'
import { fmtCount } from '@/lib/format'

/** A file beyond the table formats, like a request as SQL. */
export interface ExtraExport {
  label: string
  extension: string
  mime: string
  write: () => string | Uint8Array
}

export function ExportMenu({
  table,
  count,
  name,
  extras = [],
  iconOnly,
}: {
  table: () => ExportTable
  /** Rows the export will hold. */
  count: number
  /** What it is and where from, for the file name: `['Demo shop', 'live queries']`. */
  name: string[]
  extras?: ExtraExport[]
  iconOnly?: boolean
}) {
  const trigger = iconOnly ? (
    <Button variant="ghost" size="icon" className="-my-1 size-7 shrink-0" aria-label="Export">
      <DownloadIcon />
    </Button>
  ) : (
    <Button variant="outline" size="sm" disabled={count === 0}>
      <DownloadIcon /> Export
    </Button>
  )
  return (
    <DropdownMenu>
      {iconOnly ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Export</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel className="tabular">
          {fmtCount(count)} {count === 1 ? 'row' : 'rows'}
        </DropdownMenuLabel>
        {FORMATS.map((f) => (
          <DropdownMenuItem key={f.id} onSelect={() => exportTable(table(), f.id, name)}>
            {f.label}
            <span className="ml-auto font-mono text-xs text-muted-foreground">.{f.extension}</span>
          </DropdownMenuItem>
        ))}
        {extras.length > 0 && <DropdownMenuSeparator />}
        {extras.map((x) => (
          <DropdownMenuItem key={x.label} onSelect={() => download(fileName(name, x.extension), x.mime, x.write())}>
            {x.label}
            <span className="ml-auto font-mono text-xs text-muted-foreground">.{x.extension}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
