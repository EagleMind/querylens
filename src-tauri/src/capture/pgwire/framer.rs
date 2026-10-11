//! Incremental splitting of a PostgreSQL protocol byte stream into messages.
//!
//! The proxy forwards bytes untouched as soon as they arrive and feeds a copy here,
//! so framing never adds latency. Only the bodies of messages the tracker reads are
//! buffered; everything else (notably `DataRow` payloads) is skipped by length.

/// Upper bound for a buffered body. Larger messages are still framed, but reported
/// without a body (the statement is recorded as truncated rather than dropped).
const MAX_BODY: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameError;

pub struct Framer {
    /// Which message types to buffer bodies for.
    wants_body: fn(u8) -> bool,
    header: [u8; 5],
    header_len: usize,
    tag: u8,
    remaining: usize,
    capturing: bool,
    body: Vec<u8>,
    /// Set after a malformed length: the stream can't be framed any more.
    broken: bool,
}

impl Framer {
    pub fn new(wants_body: fn(u8) -> bool) -> Self {
        Self {
            wants_body,
            header: [0; 5],
            header_len: 0,
            tag: 0,
            remaining: 0,
            capturing: false,
            body: Vec::new(),
            broken: false,
        }
    }

    /// Consume `data`, calling `on_message(tag, body_len, body)` for each complete
    /// message. `body` is `None` for message types not wanted, or too large.
    pub fn feed(&mut self, mut data: &[u8], on_message: &mut impl FnMut(u8, usize, Option<&[u8]>)) -> Result<(), FrameError> {
        if self.broken {
            return Err(FrameError);
        }
        while !data.is_empty() {
            if self.header_len < 5 {
                let take = (5 - self.header_len).min(data.len());
                self.header[self.header_len..self.header_len + take].copy_from_slice(&data[..take]);
                self.header_len += take;
                data = &data[take..];
                if self.header_len < 5 {
                    break;
                }
                let len = u32::from_be_bytes([self.header[1], self.header[2], self.header[3], self.header[4]]) as usize;
                if len < 4 {
                    self.broken = true;
                    return Err(FrameError);
                }
                self.tag = self.header[0];
                self.remaining = len - 4;
                self.capturing = (self.wants_body)(self.tag) && self.remaining <= MAX_BODY;
                self.body.clear();
            }
            let take = self.remaining.min(data.len());
            if self.capturing {
                self.body.extend_from_slice(&data[..take]);
            }
            self.remaining -= take;
            data = &data[take..];
            if self.remaining == 0 {
                let body_len = u32::from_be_bytes([self.header[1], self.header[2], self.header[3], self.header[4]]) as usize - 4;
                on_message(self.tag, body_len, self.capturing.then_some(self.body.as_slice()));
                self.header_len = 0;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut v = vec![tag];
        v.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn frames_across_arbitrary_chunk_boundaries() {
        let mut stream = msg(b'Q', b"select 1\0");
        stream.extend(msg(b'D', &[7u8; 300]));
        stream.extend(msg(b'Z', b"I"));
        for chunk in [1, 2, 3, 7, 64, 1000] {
            let mut framer = Framer::new(|t| t != b'D');
            let mut seen = Vec::new();
            for part in stream.chunks(chunk) {
                framer.feed(part, &mut |tag, len, body| seen.push((tag, len, body.map(<[u8]>::to_vec)))).unwrap();
            }
            assert_eq!(
                seen,
                vec![(b'Q', 9, Some(b"select 1\0".to_vec())), (b'D', 300, None), (b'Z', 1, Some(b"I".to_vec()))],
                "chunk size {chunk}"
            );
        }
    }

    #[test]
    fn malformed_length_breaks_the_stream() {
        let mut framer = Framer::new(|_| true);
        assert!(framer.feed(&[b'Q', 0, 0, 0, 2], &mut |_, _, _| {}).is_err());
        assert!(framer.feed(b"anything", &mut |_, _, _| {}).is_err());
    }
}
