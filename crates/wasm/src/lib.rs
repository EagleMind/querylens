//! `querylens-core` as a WebAssembly module, for the Cloudflare backend.
//!
//! A deliberately small C ABI, so the host needs no generated glue:
//! 1. `ql_alloc(len)` → pointer; the host writes a UTF-8 JSON `DigestRequest` there.
//! 2. `ql_digest(ptr, len)` → 0 on success, 1 on error. It frees the input.
//! 3. `ql_result_ptr()` / `ql_result_len()` → the JSON `Digest` (or `{"error": "…"}`),
//!    valid until the next call.
//!
//! Build: `cargo build -p querylens-wasm --release --target wasm32-unknown-unknown`.

use std::cell::RefCell;

use querylens_core::monitor::digest::{DigestRequest, digest};

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn ql_alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` must come from `ql_alloc(len)` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ql_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

/// # Safety
/// `ptr` must come from `ql_alloc(len)` with `len` bytes written; it is freed here.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ql_digest(ptr: *mut u8, len: usize) -> i32 {
    let input = unsafe { Vec::from_raw_parts(ptr, len, len.max(1)) };
    let (code, out) = run(&input);
    RESULT.with(|r| *r.borrow_mut() = out);
    code
}

#[unsafe(no_mangle)]
pub extern "C" fn ql_result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn ql_result_len() -> usize {
    RESULT.with(|r| r.borrow().len())
}

/// The digest as JSON, or an error object.
pub fn run(input: &[u8]) -> (i32, Vec<u8>) {
    let result = serde_json::from_slice::<DigestRequest>(input)
        .map_err(|e| format!("invalid request: {e}"))
        .and_then(|req| serde_json::to_vec(&digest(&req)).map_err(|e| e.to_string()));
    match result {
        Ok(json) => (0, json),
        Err(message) => (1, serde_json::json!({ "error": message }).to_string().into_bytes()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trips_json() {
        let (code, out) = super::run(br#"{"body":"{\"type\":\"header\",\"environment\":\"dev\"}"}"#);
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["environment"], "dev");
        let (code, out) = super::run(b"nope");
        assert_eq!(code, 1);
        assert!(String::from_utf8(out).unwrap().contains("invalid request"));
    }
}
