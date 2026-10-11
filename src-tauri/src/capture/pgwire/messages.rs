//! Decoding of the PostgreSQL protocol messages the tracker needs.
//! Reference: https://www.postgresql.org/docs/current/protocol-message-formats.html

/// Messages from the application, after startup.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientMsg {
    /// Simple query protocol: one string, possibly several statements.
    Query { sql: String },
    Parse { statement: String, sql: String, param_types: Vec<u32> },
    Bind { portal: String, statement: String, formats: Vec<i16>, params: Vec<Option<Vec<u8>>> },
    Execute { portal: String },
    Describe { statement: Option<String> },
    Close { statement: Option<String>, portal: Option<String> },
    Sync,
    Other,
}

/// Messages from the server.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerMsg {
    CommandComplete { tag: String },
    EmptyQuery,
    PortalSuspended,
    Error { message: String },
    ReadyForQuery,
    ParameterDescription { types: Vec<u32> },
    /// Ends a Describe (RowDescription or NoData).
    DescribeDone,
    DataRow,
    /// CopyData: counted as result bytes during COPY TO.
    CopyData,
    Other,
}

pub fn client_wants_body(tag: u8) -> bool {
    matches!(tag, b'Q' | b'P' | b'B' | b'E' | b'D' | b'C')
}

pub fn server_wants_body(tag: u8) -> bool {
    matches!(tag, b'C' | b'E' | b't')
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn cstr(&mut self) -> Option<String> {
        let end = self.0.iter().position(|&b| b == 0)?;
        let s = String::from_utf8_lossy(&self.0[..end]).into_owned();
        self.0 = &self.0[end + 1..];
        Some(s)
    }
    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.0.len() < n {
            return None;
        }
        let (head, tail) = self.0.split_at(n);
        self.0 = tail;
        Some(head)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.bytes(1)?[0])
    }
    fn i16(&mut self) -> Option<i16> {
        Some(i16::from_be_bytes(self.bytes(2)?.try_into().ok()?))
    }
    fn i32(&mut self) -> Option<i32> {
        Some(i32::from_be_bytes(self.bytes(4)?.try_into().ok()?))
    }
}

/// Stands in for a statement whose message was too large to buffer.
pub const OVERSIZED: &str = "(statement too large to record)";

/// `body` is `None` when the framer didn't buffer it (unwanted type or oversized).
/// `None` = malformed message.
pub fn decode_client(tag: u8, body: Option<&[u8]>) -> Option<ClientMsg> {
    if tag == b'S' {
        return Some(ClientMsg::Sync);
    }
    let Some(body) = body else {
        // Oversized: keep request/response pairing intact without the details.
        return Some(match tag {
            b'Q' => ClientMsg::Query { sql: OVERSIZED.into() },
            b'P' => ClientMsg::Parse { statement: String::new(), sql: OVERSIZED.into(), param_types: Vec::new() },
            b'B' => ClientMsg::Bind { portal: String::new(), statement: String::new(), formats: Vec::new(), params: Vec::new() },
            _ => ClientMsg::Other,
        });
    };
    let mut r = Reader(body);
    Some(match tag {
        b'Q' => ClientMsg::Query { sql: r.cstr()? },
        b'P' => {
            let statement = r.cstr()?;
            let sql = r.cstr()?;
            let n = r.i16()?.max(0) as usize;
            let param_types = (0..n).map(|_| r.i32().map(|t| t as u32)).collect::<Option<_>>()?;
            ClientMsg::Parse { statement, sql, param_types }
        }
        b'B' => {
            let portal = r.cstr()?;
            let statement = r.cstr()?;
            let nf = r.i16()?.max(0) as usize;
            let formats = (0..nf).map(|_| r.i16()).collect::<Option<_>>()?;
            let np = r.i16()?.max(0) as usize;
            let mut params = Vec::with_capacity(np);
            for _ in 0..np {
                let len = r.i32()?;
                params.push(if len < 0 { None } else { Some(r.bytes(len as usize)?.to_vec()) });
            }
            ClientMsg::Bind { portal, statement, formats, params }
        }
        b'E' => ClientMsg::Execute { portal: r.cstr()? },
        b'D' => {
            let kind = r.u8()?;
            let name = r.cstr()?;
            ClientMsg::Describe { statement: (kind == b'S').then_some(name) }
        }
        b'C' => {
            let kind = r.u8()?;
            let name = r.cstr()?;
            match kind {
                b'S' => ClientMsg::Close { statement: Some(name), portal: None },
                _ => ClientMsg::Close { statement: None, portal: Some(name) },
            }
        }
        _ => ClientMsg::Other,
    })
}

pub fn decode_server(tag: u8, body: Option<&[u8]>) -> ServerMsg {
    match (tag, body) {
        (b'C', Some(b)) => ServerMsg::CommandComplete { tag: Reader(b).cstr().unwrap_or_default() },
        (b'E', Some(b)) => ServerMsg::Error { message: error_message(b) },
        (b'E', None) => ServerMsg::Error { message: "error".into() },
        (b't', Some(b)) => {
            let mut r = Reader(b);
            let n = r.i16().unwrap_or(0).max(0) as usize;
            ServerMsg::ParameterDescription {
                types: (0..n).map_while(|_| r.i32().map(|t| t as u32)).collect(),
            }
        }
        (b'I', _) => ServerMsg::EmptyQuery,
        (b's', _) => ServerMsg::PortalSuspended,
        (b'Z', _) => ServerMsg::ReadyForQuery,
        (b'T' | b'n', _) => ServerMsg::DescribeDone,
        (b'D', _) => ServerMsg::DataRow,
        (b'd', _) => ServerMsg::CopyData,
        _ => ServerMsg::Other,
    }
}

/// "ERROR: duplicate key value … (23505)" from the ErrorResponse fields.
fn error_message(body: &[u8]) -> String {
    let mut r = Reader(body);
    let (mut severity, mut code, mut message) = (String::new(), String::new(), String::new());
    while let Some(field) = r.u8() {
        if field == 0 {
            break;
        }
        let Some(value) = r.cstr() else { break };
        match field {
            b'V' => severity = value,
            b'S' if severity.is_empty() => severity = value,
            b'C' => code = value,
            b'M' => message = value,
            _ => {}
        }
    }
    match (severity.is_empty(), code.is_empty()) {
        (false, false) => format!("{severity}: {message} ({code})"),
        (false, true) => format!("{severity}: {message}"),
        _ => message,
    }
}

/// Rows affected / returned, from a CommandComplete tag (`SELECT 5`, `INSERT 0 1`).
pub fn tag_rows(tag: &str) -> Option<u64> {
    tag.rsplit(' ').next()?.parse().ok()
}

/// A binary parameter of a type QueryLens can't render as text: the execution can't be
/// replayed with its exact values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Undecodable;

/// A bound parameter as text. Text-format values are used as is; binary values are
/// decoded for common types.
pub fn param_text(value: &[u8], binary: bool, type_oid: u32) -> Result<String, Undecodable> {
    if !binary {
        return Ok(String::from_utf8_lossy(value).into_owned());
    }
    let int = |n: usize| -> Result<i64, Undecodable> {
        match (n, value.len()) {
            (2, 2) => Ok(i16::from_be_bytes([value[0], value[1]]) as i64),
            (4, 4) => Ok(i32::from_be_bytes(value.try_into().map_err(|_| Undecodable)?) as i64),
            (8, 8) => Ok(i64::from_be_bytes(value.try_into().map_err(|_| Undecodable)?)),
            _ => Err(Undecodable),
        }
    };
    // Days / microseconds since 2000-01-01.
    let epoch = chrono::NaiveDate::from_ymd_opt(2000, 1, 1).ok_or(Undecodable)?;
    Ok(match type_oid {
        16 => (value.first() == Some(&1)).to_string(),
        21 => int(2)?.to_string(),
        23 | 26 => int(4)?.to_string(),
        20 => int(8)?.to_string(),
        700 => f32::from_be_bytes(value.try_into().map_err(|_| Undecodable)?).to_string(),
        701 => f64::from_be_bytes(value.try_into().map_err(|_| Undecodable)?).to_string(),
        25 | 1043 | 1042 | 19 | 114 | 705 => String::from_utf8_lossy(value).into_owned(),
        // jsonb: a version byte, then text.
        3802 => String::from_utf8_lossy(value.get(1..).ok_or(Undecodable)?).into_owned(),
        2950 if value.len() == 16 => {
            let h: String = value.iter().map(|b| format!("{b:02x}")).collect();
            format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
        }
        1082 => (epoch + chrono::Duration::days(int(4)?)).to_string(),
        1114 | 1184 => {
            let ts = epoch.and_hms_opt(0, 0, 0).ok_or(Undecodable)? + chrono::Duration::microseconds(int(8)?);
            let s = ts.format("%Y-%m-%d %H:%M:%S%.6f").to_string();
            if type_oid == 1184 { format!("{s}+00") } else { s }
        }
        17 => format!("\\x{}", value.iter().map(|b| format!("{b:02x}")).collect::<String>()),
        _ => return Err(Undecodable),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_extended_protocol_messages() {
        let parse = b"s1\0SELECT $1::int\0\x00\x01\x00\x00\x00\x17";
        assert_eq!(
            decode_client(b'P', Some(parse)),
            Some(ClientMsg::Parse { statement: "s1".into(), sql: "SELECT $1::int".into(), param_types: vec![23] })
        );
        let bind = b"\0s1\0\x00\x01\x00\x01\x00\x02\x00\x00\x00\x04\x00\x00\x00\x2a\xff\xff\xff\xff\x00\x00";
        assert_eq!(
            decode_client(b'B', Some(bind)),
            Some(ClientMsg::Bind {
                portal: String::new(),
                statement: "s1".into(),
                formats: vec![1],
                params: vec![Some(vec![0, 0, 0, 42]), None],
            })
        );
        assert_eq!(decode_client(b'S', None), Some(ClientMsg::Sync));
        // An oversized query still counts as a query, so responses stay paired.
        assert_eq!(decode_client(b'Q', None), Some(ClientMsg::Query { sql: OVERSIZED.into() }));
        assert_eq!(decode_client(b'Q', Some(b"no terminator")), None);
    }

    #[test]
    fn server_messages_and_tags() {
        let err = b"SERROR\0VERROR\0C23505\0Mduplicate key value\0\0";
        assert_eq!(
            decode_server(b'E', Some(err)),
            ServerMsg::Error { message: "ERROR: duplicate key value (23505)".into() }
        );
        assert_eq!(tag_rows("INSERT 0 3"), Some(3));
        assert_eq!(tag_rows("SELECT 120"), Some(120));
        assert_eq!(tag_rows("BEGIN"), None);
    }

    #[test]
    fn binary_params_render_as_text() {
        assert_eq!(param_text(&42i32.to_be_bytes(), true, 23), Ok("42".into()));
        assert_eq!(param_text(&7i64.to_be_bytes(), true, 20), Ok("7".into()));
        assert_eq!(param_text(b"paid", false, 0), Ok("paid".into()));
        assert_eq!(param_text(&[1], true, 16), Ok("true".into()));
        assert_eq!(param_text(&0i64.to_be_bytes(), true, 1184), Ok("2000-01-01 00:00:00.000000+00".into()));
        assert!(param_text(&[1, 2, 3], true, 99999).is_err());
    }
}
