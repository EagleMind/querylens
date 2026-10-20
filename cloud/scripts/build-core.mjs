// Build querylens-core as WebAssembly and copy it where the Worker imports it from.
// Needs Rust with the wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`).
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const crate = join(here, '..', '..', 'src-tauri')
execFileSync('cargo', ['build', '-p', 'querylens-wasm', '--release', '--target', 'wasm32-unknown-unknown'], {
  cwd: crate,
  stdio: 'inherit',
})
mkdirSync(join(here, '..', 'core'), { recursive: true })
copyFileSync(
  join(crate, 'target', 'wasm32-unknown-unknown', 'release', 'querylens_wasm.wasm'),
  join(here, '..', 'core', 'querylens_core.wasm'),
)
console.log('core/querylens_core.wasm updated')
