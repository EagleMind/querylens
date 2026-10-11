//! The PostgreSQL frontend/backend protocol, as far as observing it requires.
//! Pure: no I/O, so every piece is unit-tested against byte sequences.

pub mod framer;
pub mod messages;
pub mod tracker;

/// Startup-phase request codes (sent in place of a protocol version).
pub const SSL_REQUEST: u32 = 80_877_103;
pub const GSSENC_REQUEST: u32 = 80_877_104;
pub const CANCEL_REQUEST: u32 = 80_877_102;

/// Parameters of a StartupMessage body (after the protocol version).
pub fn startup_params(body: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut parts = body.split(|&b| b == 0).map(|s| String::from_utf8_lossy(s).into_owned());
    while let (Some(k), Some(v)) = (parts.next(), parts.next()) {
        if k.is_empty() {
            break;
        }
        out.push((k, v));
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn startup_params_parse() {
        let body = b"user\0app\0database\0shop\0application_name\0api\0\0";
        let p = super::startup_params(body);
        assert_eq!(p.len(), 3);
        assert_eq!(p[2], ("application_name".into(), "api".into()));
    }
}
