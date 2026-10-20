//! Comment tags that applications attach to their SQL to say where it came from.
//!
//! Two formats are recognised:
//! - sqlcommenter (`/*route='%2Forders',traceparent='00-…'*/`): values quoted and
//!   URL-encoded. Used by the sqlcommenter libraries, Rails' `:sqlcommenter` format,
//!   and the QueryLens SDK.
//! - Rails query log tags / Marginalia (`/*application:Shop,controller:orders*/`).
//!
//! Comments that don't parse as tags (e.g. Hibernate's `/* load User */`) are left alone.

/// Tags parsed from a statement's comments, in order of appearance.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tags(Vec<(String, String)>);

impl Tags {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The request / trace the statement ran in: a W3C trace id, or QueryLens's own
    /// per-request id from the SDK.
    pub fn unit(&self) -> Option<String> {
        if let Some(tp) = self.get("traceparent") {
            // version-traceid-spanid-flags
            if let Some(trace) = tp.split('-').nth(1).filter(|t| t.len() == 32) {
                return Some(trace.to_string());
            }
        }
        self.get("ql_unit").map(String::from)
    }

    /// Where in the application the statement was issued: a source location when the
    /// app sends one, else the controller action or route.
    pub fn origin(&self) -> Option<String> {
        if let Some(file) = self.get("file").or_else(|| self.get("source_location")) {
            return Some(file.to_string());
        }
        if let Some(path) = self.get("code.filepath") {
            return Some(match self.get("code.lineno") {
                Some(line) => format!("{path}:{line}"),
                None => path.to_string(),
            });
        }
        match (self.get("controller"), self.get("action")) {
            (Some(c), Some(a)) => Some(format!("{c}#{a}")),
            (Some(c), None) => Some(c.to_string()),
            _ => self.route(),
        }
    }

    /// The HTTP route or job the statement ran for.
    pub fn route(&self) -> Option<String> {
        self.get("route").or_else(|| self.get("job")).map(String::from)
    }

    /// The driver / framework the app reports (`db_driver`, `framework`).
    pub fn framework(&self) -> Option<String> {
        let parts: Vec<&str> = ["db_driver", "framework"].iter().filter_map(|k| self.get(k)).collect();
        (!parts.is_empty()).then(|| parts.join(" "))
    }
}

/// The statement without its tag comments, and the tags.
pub fn extract(sql: &str) -> (String, Tags) {
    let mut tags = Vec::new();
    let mut out = String::with_capacity(sql.len());
    let mut rest = sql;
    while let Some(start) = find_comment_start(rest) {
        let Some(len) = rest[start + 2..].find("*/") else { break };
        let body = &rest[start + 2..start + 2 + len];
        let end = start + 2 + len + 2;
        match parse_tags(body) {
            Some(mut parsed) => {
                tags.append(&mut parsed);
                out.push_str(rest[..start].trim_end_matches(' '));
            }
            None => out.push_str(&rest[..end]),
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    (out.trim().to_string(), Tags(tags))
}

/// Byte offset of the next `/*` outside string literals and quoted identifiers.
fn find_comment_start(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        match b[i] {
            q @ (b'\'' | b'"') => {
                i += 1;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
            }
            b'/' if b[i + 1] == b'*' => return Some(i),
            _ => {}
        }
        i += 1;
    }
    None
}

fn parse_tags(body: &str) -> Option<Vec<(String, String)>> {
    let body = body.trim();
    if body.is_empty() {
        return None;
    }
    let mut tags = Vec::new();
    for item in split_items(body) {
        let item = item.trim();
        let (key, value) = if let Some((k, v)) = item.split_once('=') {
            let v = v.trim();
            let unquoted = v.strip_prefix('\'').and_then(|v| v.strip_suffix('\''))?;
            (k, percent_decode(&unquoted.replace("\\'", "'")))
        } else {
            let (k, v) = item.split_once(':')?;
            (k, v.trim().to_string())
        };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
            return None;
        }
        tags.push((key.to_string(), value));
    }
    Some(tags)
}

/// Split on commas outside single quotes.
fn split_items(body: &str) -> Vec<&str> {
    let mut items = Vec::new();
    let (mut start, mut quoted, mut prev) = (0, false, '\0');
    for (i, c) in body.char_indices() {
        match c {
            '\'' if prev != '\\' => quoted = !quoted,
            ',' if !quoted => {
                items.push(&body[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        prev = c;
    }
    items.push(&body[start..]);
    items
}

fn percent_decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlcommenter_tags_are_parsed_and_removed() {
        let sql = "SELECT * FROM \"Orders\" AS \"Order\" WHERE \"Order\".\"userId\" = 1 \
                   /*file='src%2Froutes%2Forders.js%3A42',route='GET%20%2Forders',ql_unit='r7'*/;";
        let (clean, tags) = extract(sql);
        assert_eq!(clean, "SELECT * FROM \"Orders\" AS \"Order\" WHERE \"Order\".\"userId\" = 1;");
        assert_eq!(tags.origin().as_deref(), Some("src/routes/orders.js:42"));
        assert_eq!(tags.route().as_deref(), Some("GET /orders"));
        assert_eq!(tags.unit().as_deref(), Some("r7"));
    }

    #[test]
    fn traceparent_and_rails_tags() {
        let (_, t) = extract("select 1 /*traceparent='00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'*/");
        assert_eq!(t.unit().as_deref(), Some("4bf92f3577b34da6a3ce929d0e0e4736"));
        let (clean, t) = extract("/*application:Shop,controller:orders,action:index*/ SELECT 1");
        assert_eq!(clean, "SELECT 1");
        assert_eq!(t.origin().as_deref(), Some("orders#index"));
    }

    #[test]
    fn other_comments_and_strings_are_kept() {
        let sql = "/* load User */ select '/*not:a,comment*/' from t";
        let (clean, tags) = extract(sql);
        assert_eq!(clean, sql);
        assert!(tags.is_empty());
    }
}
