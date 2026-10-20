// The Cloudflare Vite plugin imports `.wasm?module` files as compiled modules.
declare module '*.wasm?module' {
  const module: WebAssembly.Module
  export default module
}
