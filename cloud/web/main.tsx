import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './index.css'

// Light or dark as the system is set; index.html applies it before the first paint.
window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', (e) => document.documentElement.classList.toggle('dark', e.matches))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
