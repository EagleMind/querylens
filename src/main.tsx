import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './index.css'

// Desktop app: no browser context menu outside editable fields.
if (!import.meta.env.DEV) {
  window.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement
    if (!t.closest('input, textarea, .cm-editor, [data-selectable]')) e.preventDefault()
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
