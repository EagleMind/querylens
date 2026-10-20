// querylens-core (Rust, src-tauri/core) as WebAssembly: the same analysis the CLI runs on
// captured traffic. Rebuild with `pnpm build:core`. The module's ABI is described in
// src-tauri/wasm/src/lib.rs: write JSON in, call ql_digest, read JSON out.
import coreModule from '../core/querylens_core.wasm?module'

import type { Digest } from '../../src/bindings/Digest'
import type { Orm } from '../../src/bindings/Orm'
import type { ProjectSettings } from '../../src/bindings/ProjectSettings'

interface CoreExports {
  memory: WebAssembly.Memory
  ql_alloc(len: number): number
  ql_digest(ptr: number, len: number): number
  ql_result_ptr(): number
  ql_result_len(): number
}

let instance: CoreExports | null = null
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function core(): CoreExports {
  instance ??= new WebAssembly.Instance(coreModule, {}).exports as unknown as CoreExports
  return instance
}

/** Parse an SDK envelope, evaluate every request in it, fingerprint its statistics. */
export function digest(body: string, orm: Orm | null, settings: ProjectSettings): Digest {
  const c = core()
  const input = encoder.encode(JSON.stringify({ body, orm, settings }))
  const ptr = c.ql_alloc(input.length)
  new Uint8Array(c.memory.buffer, ptr, input.length).set(input)
  const status = c.ql_digest(ptr, input.length)
  // Read after the call: memory may have grown, detaching earlier views.
  const out = decoder.decode(new Uint8Array(c.memory.buffer, c.ql_result_ptr(), c.ql_result_len()))
  const parsed = JSON.parse(out)
  if (status !== 0) throw new Error(`querylens-core: ${parsed.error ?? 'failed'}`)
  return parsed as Digest
}
