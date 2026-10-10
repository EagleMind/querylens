import { PostgreSQL, sql as sqlLang, type SQLNamespace } from '@codemirror/lang-sql'
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { createTheme } from '@uiw/codemirror-themes'
import CodeMirror from '@uiw/react-codemirror'
import { useEffect, useMemo, useRef } from 'react'

import type { TableContext } from '@/bindings/TableContext'

const theme = createTheme({
  theme: 'dark',
  settings: {
    background: 'transparent',
    foreground: 'oklch(0.92 0.005 255)',
    caret: 'oklch(0.8 0.13 178)',
    selection: 'oklch(0.8 0.13 178 / 22%)',
    selectionMatch: 'oklch(0.8 0.13 178 / 12%)',
    lineHighlight: 'oklch(1 0 0 / 3%)',
    gutterBackground: 'transparent',
    gutterForeground: 'oklch(0.45 0.01 255)',
    gutterBorder: 'transparent',
    fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
  },
  styles: [
    { tag: [t.keyword, t.operatorKeyword], color: 'oklch(0.8 0.13 178)' },
    { tag: [t.string, t.special(t.string)], color: 'oklch(0.82 0.12 85)' },
    { tag: [t.number, t.bool, t.null], color: 'oklch(0.78 0.13 300)' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'oklch(0.52 0.01 255)', fontStyle: 'italic' },
    { tag: [t.typeName, t.standard(t.name)], color: 'oklch(0.75 0.11 230)' },
    { tag: [t.function(t.variableName)], color: 'oklch(0.85 0.09 200)' },
    { tag: [t.operator, t.punctuation, t.bracket], color: 'oklch(0.65 0.01 255)' },
    { tag: [t.name, t.variableName, t.propertyName], color: 'oklch(0.92 0.005 255)' },
  ],
})

const RUN_EVENT = 'querylens:run'

const baseExtensions = [
  EditorView.lineWrapping,
  EditorView.theme({
    '&': { fontSize: '13px', height: '100%' },
    '.cm-scroller': { lineHeight: '1.65', padding: '10px 0' },
    '.cm-content': { paddingRight: '12px' },
    '.cm-gutters': { paddingLeft: '6px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-tooltip-autocomplete': {
      border: '1px solid oklch(1 0 0 / 10%)',
      background: 'oklch(0.2 0.008 255)',
      borderRadius: '6px',
      overflow: 'hidden',
    },
  }),
]

export function SqlEditor({
  value,
  onChange,
  onRun,
  tables,
}: {
  value: string
  onChange: (v: string) => void
  onRun: () => void
  /** Schema from the last analysis, for column/table completion. */
  tables?: TableContext[]
}) {
  // The keymap is built once per schema, so it signals "run" through a DOM event
  // instead of capturing a (stale) callback.
  const wrapper = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = wrapper.current
    el?.addEventListener(RUN_EVENT, onRun)
    return () => el?.removeEventListener(RUN_EVENT, onRun)
  }, [onRun])

  const extensions = useMemo(() => {
    const schema: SQLNamespace = {}
    for (const tbl of tables ?? []) {
      const short = tbl.name.split('.').pop()!
      schema[short] = tbl.columns.map((c) => ({ label: c.name, detail: c.dataType, type: 'property' }))
    }
    return [
      ...baseExtensions,
      sqlLang({ dialect: PostgreSQL, schema, upperCaseKeywords: false }),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              view.dom.dispatchEvent(new Event(RUN_EVENT, { bubbles: true }))
              return true
            },
          },
        ]),
      ),
    ]
  }, [tables])

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
        placeholder="SELECT … — paste a query and press Ctrl/⌘ + Enter"
      />
    </div>
  )
}
