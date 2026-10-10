import { javascript } from '@codemirror/lang-javascript'
import { MySQL, PostgreSQL, sql as sqlLang, StandardSQL, type SQLNamespace } from '@codemirror/lang-sql'
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { createTheme } from '@uiw/codemirror-themes'
import CodeMirror from '@uiw/react-codemirror'
import { useEffect, useMemo, useRef } from 'react'

import type { Engine } from '@/bindings/Engine'
import type { TableContext } from '@/bindings/TableContext'

// Ink-and-signal syntax palette: keywords in a muted signal yellow, data values in
// warm/cool inks, identifiers in the base cream.
const theme = createTheme({
  theme: 'dark',
  settings: {
    background: 'transparent',
    foreground: 'oklch(0.93 0.025 85)',
    caret: 'oklch(0.88 0.165 98)',
    selection: 'oklch(0.88 0.165 98 / 22%)',
    selectionMatch: 'oklch(0.88 0.165 98 / 12%)',
    lineHighlight: 'oklch(0.93 0.025 85 / 3.5%)',
    gutterBackground: 'transparent',
    gutterForeground: 'oklch(0.5 0.03 255)',
    gutterBorder: 'transparent',
    fontFamily: '"Fragment Mono", ui-monospace, monospace',
  },
  styles: [
    { tag: [t.keyword, t.operatorKeyword], color: 'oklch(0.86 0.13 95)' },
    { tag: [t.string, t.special(t.string)], color: 'oklch(0.8 0.1 152)' },
    { tag: [t.number, t.bool, t.null], color: 'oklch(0.76 0.13 40)' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'oklch(0.56 0.035 255)', fontStyle: 'italic' },
    { tag: [t.typeName, t.standard(t.name)], color: 'oklch(0.76 0.09 235)' },
    { tag: [t.function(t.variableName)], color: 'oklch(0.8 0.08 235)' },
    { tag: [t.operator, t.punctuation, t.bracket], color: 'oklch(0.66 0.03 255)' },
    { tag: [t.name, t.variableName, t.propertyName], color: 'oklch(0.93 0.025 85)' },
  ],
})

const RUN_EVENT = 'querylens:run'

const baseExtensions = [
  EditorView.lineWrapping,
  EditorView.theme({
    '&': { fontSize: '13.5px', height: '100%' },
    '.cm-scroller': { lineHeight: '1.65', padding: '10px 0' },
    '.cm-content': { paddingRight: '12px' },
    '.cm-gutters': { paddingLeft: '6px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-tooltip-autocomplete': {
      border: '1px solid oklch(0.93 0.025 85 / 12%)',
      background: 'oklch(0.255 0.036 262)',
      borderRadius: '3px',
      overflow: 'hidden',
    },
  }),
]

export function SqlEditor({
  value,
  onChange,
  onRun,
  tables,
  engine,
}: {
  value: string
  onChange: (v: string) => void
  /** `alt`: Shift was held — run the secondary action. */
  onRun: (alt: boolean) => void
  /** Schema from the last analysis, for column/table completion. */
  tables?: TableContext[]
  /** Picks the language: SQL dialect, or JavaScript for MongoDB's shell syntax. */
  engine?: Engine
}) {
  // The keymap is built once per schema, so it signals "run" through a DOM event
  // instead of capturing a (stale) callback.
  const wrapper = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = wrapper.current
    const handler = (e: Event) => onRun(!!(e as CustomEvent<{ alt: boolean }>).detail?.alt)
    el?.addEventListener(RUN_EVENT, handler)
    return () => el?.removeEventListener(RUN_EVENT, handler)
  }, [onRun])

  const extensions = useMemo(() => {
    const schema: SQLNamespace = {}
    for (const tbl of tables ?? []) {
      const short = tbl.name.split('.').pop()!
      schema[short] = tbl.columns.map((c) => ({ label: c.name, detail: c.dataType, type: 'property' }))
    }
    const language =
      engine === 'mongodb'
        ? javascript()
        : sqlLang({
            dialect: engine === 'mysql' ? MySQL : engine === 'duckdb' ? StandardSQL : PostgreSQL,
            schema,
            upperCaseKeywords: false,
          })
    return [
      ...baseExtensions,
      language,
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              view.dom.dispatchEvent(new CustomEvent(RUN_EVENT, { bubbles: true, detail: { alt: false } }))
              return true
            },
          },
          {
            key: 'Shift-Mod-Enter',
            run: (view) => {
              view.dom.dispatchEvent(new CustomEvent(RUN_EVENT, { bubbles: true, detail: { alt: true } }))
              return true
            },
          },
        ]),
      ),
    ]
  }, [tables, engine])

  return (
    <div ref={wrapper} className="h-full">
      <CodeMirror
        value={value}
        onChange={onChange}
        theme={theme}
        extensions={extensions}
        height="100%"
        className="h-full"
        basicSetup={{ foldGutter: false, highlightActiveLineGutter: false, searchKeymap: true }}
        placeholder={
          engine === 'mongodb'
            ? 'db.orders.find({ status: "paid" }) — then press Ctrl/⌘ + Enter'
            : 'SELECT … — paste a query and press Ctrl/⌘ + Enter'
        }
      />
    </div>
  )
}
