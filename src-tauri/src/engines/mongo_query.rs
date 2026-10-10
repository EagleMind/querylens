//! mongosh-style query text → the server command that `explain` wraps.
//!
//! Supported: `db.<coll>.find(filter?, projection?)` with `.sort/.limit/.skip/.hint/
//! .projection/.collation` chained, `findOne`, `aggregate(pipeline, options?)`,
//! `countDocuments`, `count`, `distinct`, `updateOne/updateMany`, `deleteOne/deleteMany`
//! (explain never applies writes), and a raw command document (`{ "find": "orders", … }`).
//! Arguments are JSON5 plus the shell helpers `ObjectId()`, `ISODate()`/`new Date()`,
//! `NumberLong()`, `NumberInt()`, `NumberDecimal()` and `/regex/flags` literals.

use mongodb::bson::{Bson, Document, doc};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// A parsed query: the collection and the command to explain.
#[derive(Debug, Clone, PartialEq)]
pub struct MongoQuery {
    pub collection: String,
    pub command: Document,
    /// update/delete: explain reports the plan but never applies the write.
    pub writes: bool,
}

const COMMANDS: &[&str] = &["find", "aggregate", "count", "distinct", "update", "delete"];

pub fn parse(text: &str) -> AppResult<MongoQuery> {
    let text = text.trim().trim_end_matches(';').trim();
    if text.starts_with('{') {
        return parse_command(text);
    }
    let (collection, calls) = split_chain(text)?;
    let (method, args) = calls.first().ok_or_else(|| usage("Call a method on the collection"))?;
    let args = parse_args(args)?;
    let arg = |i: usize| args.get(i).cloned();
    let doc_arg = |i: usize, what: &str| -> AppResult<Document> {
        match arg(i) {
            None | Some(Bson::Null) => Ok(Document::new()),
            Some(Bson::Document(d)) => Ok(d),
            Some(_) => Err(AppError::validation(format!("The {what} of {method}() must be an object."))),
        }
    };

    let mut writes = false;
    let mut command = match method.as_str() {
        "find" | "findOne" => {
            let mut c = doc! { "find": &collection, "filter": doc_arg(0, "filter")? };
            let projection = doc_arg(1, "projection")?;
            if !projection.is_empty() {
                c.insert("projection", projection);
            }
            if method == "findOne" {
                c.insert("limit", 1);
            }
            c
        }
        "aggregate" => {
            let pipeline = match arg(0) {
                Some(Bson::Array(stages)) => stages,
                _ => return Err(usage("aggregate() takes an array of stages")),
            };
            for stage in &pipeline {
                if let Bson::Document(d) = stage {
                    if d.contains_key("$out") || d.contains_key("$merge") {
                        return Err(AppError::validation(
                            "Pipelines with $out or $merge write data, so QueryLens won't run them. Remove \
                             that stage to profile the rest.",
                        ));
                    }
                }
            }
            let mut c = doc! { "aggregate": &collection, "pipeline": pipeline, "cursor": {} };
            for (k, v) in doc_arg(1, "options")? {
                if ["hint", "collation", "allowDiskUse", "let"].contains(&k.as_str()) {
                    c.insert(k, v);
                }
            }
            c
        }
        "countDocuments" => {
            // What drivers send for countDocuments.
            let pipeline = vec![
                Bson::Document(doc! { "$match": doc_arg(0, "filter")? }),
                Bson::Document(doc! { "$group": { "_id": 1, "n": { "$sum": 1 } } }),
            ];
            doc! { "aggregate": &collection, "pipeline": pipeline, "cursor": {} }
        }
        "count" => doc! { "count": &collection, "query": doc_arg(0, "filter")? },
        "distinct" => {
            let Some(Bson::String(key)) = arg(0) else {
                return Err(usage("distinct() takes a field name first"));
            };
            doc! { "distinct": &collection, "key": key, "query": doc_arg(1, "filter")? }
        }
        "updateOne" | "updateMany" => {
            writes = true;
            let update = match arg(1) {
                Some(u @ (Bson::Document(_) | Bson::Array(_))) => u,
                _ => return Err(usage("update takes a filter and an update document")),
            };
            let one = doc! { "q": doc_arg(0, "filter")?, "u": update, "multi": method == "updateMany" };
            doc! { "update": &collection, "updates": [one] }
        }
        "deleteOne" | "deleteMany" => {
            writes = true;
            let one = doc! { "q": doc_arg(0, "filter")?, "limit": if method == "deleteOne" { 1 } else { 0 } };
            doc! { "delete": &collection, "deletes": [one] }
        }
        other => {
            return Err(AppError::validation(format!(
                "QueryLens can explain find, findOne, aggregate, countDocuments, count, distinct, update and \
                 delete. `{other}()` isn't one of them."
            )));
        }
    };

    for (name, args) in &calls[1..] {
        let mut args = parse_args(args)?;
        let first = if args.is_empty() { Bson::Null } else { args.swap_remove(0) };
        let is_find = command.contains_key("find");
        match name.as_str() {
            "sort" | "projection" | "collation" | "hint" | "limit" | "skip" | "batchSize" | "maxTimeMS"
                if !is_find =>
            {
                return Err(usage(&format!(".{name}() can only follow find()")));
            }
            "sort" | "projection" | "collation" => {
                command.insert(name.as_str(), first);
            }
            "hint" => {
                command.insert("hint", first);
            }
            "limit" | "skip" => {
                let n = first.as_i64().or_else(|| first.as_f64().map(|f| f as i64)).or(first.as_i32().map(i64::from));
                let n = n.ok_or_else(|| usage(&format!(".{name}() takes a number")))?;
                command.insert(name.as_str(), n);
            }
            "count" | "countDocuments" if is_find => {
                let filter = command.get_document("filter").cloned().unwrap_or_default();
                command = doc! { "count": &collection, "query": filter };
            }
            // Harmless cursor options and a trailing .explain() are ignored.
            "explain" | "batchSize" | "maxTimeMS" | "comment" | "toArray" | "pretty" | "allowDiskUse" => {}
            other => return Err(usage(&format!("`.{other}()` isn't supported in a query chain"))),
        }
    }
    Ok(MongoQuery { collection, command, writes })
}

fn usage(why: &str) -> AppError {
    AppError::validation(format!(
        "{why}. MongoDB queries are written like the shell: db.orders.find({{ status: \"paid\" }}).sort({{ total: \
         -1 }}).limit(20)"
    ))
}

/// A raw command document: `{ "find": "orders", "filter": { … } }`.
fn parse_command(text: &str) -> AppResult<MongoQuery> {
    let Bson::Document(command) = to_bson(&format!("[{text}]"))?.as_array().and_then(|a| a.first().cloned()).unwrap_or(Bson::Null)
    else {
        return Err(usage("Expected a command document"));
    };
    let (name, target) = command.iter().next().ok_or_else(|| usage("The command document is empty"))?;
    if !COMMANDS.contains(&name.as_str()) {
        return Err(AppError::validation(format!(
            "Only {} commands can be explained.",
            COMMANDS.join(", ")
        )));
    }
    let collection = target.as_str().ok_or_else(|| usage("The command must name a collection"))?.to_string();
    if let Some(Bson::Array(stages)) = command.get("pipeline") {
        if stages.iter().any(|s| matches!(s, Bson::Document(d) if d.contains_key("$out") || d.contains_key("$merge"))) {
            return Err(AppError::validation("Pipelines with $out or $merge write data, so QueryLens won't run them."));
        }
    }
    let writes = name == "update" || name == "delete";
    Ok(MongoQuery { collection, command, writes })
}

/// `db.orders.find(a).sort(b)` → ("orders", [("find", "a"), ("sort", "b")]).
fn split_chain(text: &str) -> AppResult<(String, Vec<(String, String)>)> {
    let rest = text.strip_prefix("db").ok_or_else(|| usage("Start the query with db.<collection>"))?;
    let (collection, mut rest) = if let Some(r) = rest.strip_prefix(".getCollection(") {
        let end = r.find(')').ok_or_else(|| usage("Unclosed getCollection("))?;
        (r[..end].trim().trim_matches(|c| c == '"' || c == '\'').to_string(), &r[end + 1..])
    } else if let Some(r) = rest.strip_prefix('[') {
        let end = r.find(']').ok_or_else(|| usage("Unclosed db["))?;
        (r[..end].trim().trim_matches(|c| c == '"' || c == '\'').to_string(), &r[end + 1..])
    } else {
        let r = rest.strip_prefix('.').ok_or_else(|| usage("Start the query with db.<collection>"))?;
        // The collection name may itself contain dots: it ends at the last `.` before the first `(`.
        let paren = r.find('(').ok_or_else(|| usage("Call a method on the collection"))?;
        let dot = r[..paren].rfind('.').ok_or_else(|| usage("Call a method on the collection"))?;
        (r[..dot].to_string(), &r[dot..])
    };
    if collection.is_empty() {
        return Err(usage("Name the collection"));
    }

    let mut calls = Vec::new();
    loop {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        let r = rest.strip_prefix('.').ok_or_else(|| usage(&format!("Unexpected `{}`", first_chars(rest))))?;
        let open = r.find('(').ok_or_else(|| usage("Expected a method call"))?;
        let name = r[..open].trim();
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(usage(&format!("Unexpected `{}`", first_chars(rest))));
        }
        let close = matching_paren(r, open)?;
        calls.push((name.to_string(), r[open + 1..close].to_string()));
        rest = &r[close + 1..];
    }
    Ok((collection, calls))
}

fn first_chars(s: &str) -> String {
    s.chars().take(20).collect()
}

/// Index of the `)` matching the `(` at `open`, skipping strings and regex literals.
fn matching_paren(s: &str, open: usize) -> AppResult<usize> {
    let b = s.as_bytes();
    let mut depth = 0usize;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            q @ (b'"' | b'\'' | b'`') => i = skip_string(b, i, q),
            b'/' if regex_can_start(b, i) => i = skip_regex(b, i),
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => {
                depth -= 1;
                if depth == 0 {
                    return if b[i] == b')' { Ok(i) } else { Err(usage("Unbalanced brackets")) };
                }
            }
            _ => {}
        }
        i += 1;
    }
    Err(usage("Unclosed parenthesis"))
}

/// Index of the closing quote.
fn skip_string(b: &[u8], start: usize, quote: u8) -> usize {
    let mut i = start + 1;
    while i < b.len() && b[i] != quote {
        if b[i] == b'\\' {
            i += 1;
        }
        i += 1;
    }
    i
}

/// A `/` starts a regex literal where a value is expected (not division, not a comment).
fn regex_can_start(b: &[u8], i: usize) -> bool {
    if b.get(i + 1).is_some_and(|c| *c == b'/' || *c == b'*') {
        return false;
    }
    let prev = b[..i].iter().rev().find(|c| !c.is_ascii_whitespace());
    matches!(prev, None | Some(b':' | b',' | b'[' | b'(' | b'{'))
}

/// Index of the closing `/` of a regex literal (flags follow it).
fn skip_regex(b: &[u8], start: usize) -> usize {
    let (mut i, mut in_class) = (start + 1, false);
    while i < b.len() {
        match b[i] {
            b'\\' => i += 1,
            b'[' => in_class = true,
            b']' => in_class = false,
            b'/' if !in_class => return i,
            _ => {}
        }
        i += 1;
    }
    i
}

/// Comma-separated shell arguments → BSON values.
fn parse_args(args: &str) -> AppResult<Vec<Bson>> {
    if args.trim().is_empty() {
        return Ok(Vec::new());
    }
    match to_bson(&format!("[{args}]"))? {
        Bson::Array(items) => Ok(items),
        _ => Ok(Vec::new()),
    }
}

/// Shell-flavoured JSON5 → BSON (via extended JSON for the helper types).
fn to_bson(text: &str) -> AppResult<Bson> {
    let json5 = rewrite_helpers(text)?;
    let value: Value = json5::from_str(&json5).map_err(|e| {
        AppError::validation(format!("Couldn't read the query arguments: {e}"))
    })?;
    Bson::try_from(value).map_err(|e| AppError::validation(format!("Invalid MongoDB value: {e}")))
}

/// Replace shell helpers and regex literals with their extended-JSON forms.
fn rewrite_helpers(src: &str) -> AppResult<String> {
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'"' || c == b'\'' {
            let end = skip_string(b, i, c).min(b.len() - 1);
            out.push_str(&src[i..=end]);
            i = end + 1;
            continue;
        }
        if c == b'/' && regex_can_start(b, i) {
            let end = skip_regex(b, i);
            let pattern = &src[i + 1..end.min(b.len())];
            let mut j = end + 1;
            while j < b.len() && b[j].is_ascii_alphabetic() {
                j += 1;
            }
            let mut flags: Vec<char> = src[(end + 1).min(b.len())..j].chars().collect();
            flags.sort_unstable();
            let flags: String = flags.into_iter().collect();
            out.push_str(&format!(
                r#"{{"$regularExpression": {{"pattern": {}, "options": "{flags}"}}}}"#,
                serde_json::to_string(pattern).unwrap_or_default()
            ));
            i = j;
            continue;
        }
        if c.is_ascii_alphabetic() {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$') {
                i += 1;
            }
            let word = &src[start..i];
            // `new Date(...)` → treat like ISODate(...).
            let (word, after_new) = if word == "new" {
                let mut k = i;
                while k < b.len() && b[k].is_ascii_whitespace() {
                    k += 1;
                }
                let s2 = k;
                while k < b.len() && b[k].is_ascii_alphanumeric() {
                    k += 1;
                }
                (&src[s2..k], k)
            } else {
                (word, i)
            };
            let mut k = after_new;
            while k < b.len() && b[k].is_ascii_whitespace() {
                k += 1;
            }
            if b.get(k) == Some(&b'(') && is_helper(word) {
                let close = matching_paren(src, k)?;
                let inner = src[k + 1..close].trim().trim_matches(|c| c == '"' || c == '\'');
                out.push_str(&helper(word, inner)?);
                i = close + 1;
            } else {
                out.push_str(&src[start..i]);
            }
            continue;
        }
        out.push(c as char);
        i += 1;
    }
    Ok(out)
}

fn is_helper(word: &str) -> bool {
    matches!(word, "ObjectId" | "ISODate" | "Date" | "NumberLong" | "NumberInt" | "NumberDecimal" | "UUID")
}

fn helper(name: &str, arg: &str) -> AppResult<String> {
    let q = |s: &str| serde_json::to_string(s).unwrap_or_default();
    Ok(match name {
        "ObjectId" => format!(r#"{{"$oid": {}}}"#, q(arg)),
        "ISODate" | "Date" => {
            let iso = if arg.is_empty() {
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            } else if arg.len() == 10 {
                format!("{arg}T00:00:00Z") // date only
            } else if !arg.ends_with('Z') && !arg[10..].contains(['+', '-']) {
                format!("{arg}Z")
            } else {
                arg.to_string()
            };
            format!(r#"{{"$date": {}}}"#, q(&iso))
        }
        "NumberLong" => format!(r#"{{"$numberLong": {}}}"#, q(arg)),
        "NumberInt" => arg.to_string(),
        "NumberDecimal" => format!(r#"{{"$numberDecimal": {}}}"#, q(arg)),
        "UUID" => format!(r#"{{"$uuid": {}}}"#, q(arg)),
        _ => return Err(AppError::validation(format!("Unsupported helper {name}()"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_chain_becomes_a_find_command() {
        let q = parse(r#"db.orders.find({ status: "paid", total: { $gt: 100 } }, { _id: 0 }).sort({ total: -1 }).limit(20);"#)
            .unwrap();
        assert_eq!(q.collection, "orders");
        assert_eq!(
            q.command,
            doc! { "find": "orders", "filter": { "status": "paid", "total": { "$gt": 100 } },
                   "projection": { "_id": 0 }, "sort": { "total": -1 }, "limit": 20_i64 }
        );
        assert!(!q.writes);
    }

    #[test]
    fn aggregate_and_helpers() {
        let q = parse(
            "db.getCollection('events').aggregate([{ $match: { _id: ObjectId('65a1f0c2e4b0a1b2c3d4e5f6'), \
             at: { $gte: ISODate('2024-01-01') }, name: /^ab(c)/i } }, { $group: { _id: '$kind', n: { $sum: 1 } } }])",
        )
        .unwrap();
        assert_eq!(q.collection, "events");
        let stage = q.command.get_array("pipeline").unwrap()[0].as_document().unwrap().get_document("$match").unwrap();
        assert!(matches!(stage.get("_id"), Some(Bson::ObjectId(_))));
        assert!(matches!(stage.get_document("at").unwrap().get("$gte"), Some(Bson::DateTime(_))));
        match stage.get("name") {
            Some(Bson::RegularExpression(r)) => assert_eq!((r.pattern.as_str(), r.options.as_str()), ("^ab(c)", "i")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn writes_are_flagged_and_out_is_refused() {
        let q = parse(r#"db.orders.updateMany({ status: "pending" }, { $set: { status: "paid" } })"#).unwrap();
        assert!(q.writes);
        assert_eq!(q.command.get_str("update").unwrap(), "orders");
        assert!(parse(r#"db.orders.aggregate([{ $match: {} }, { $out: "copy" }])"#).is_err());
        assert!(parse(r#"db.orders.drop()"#).is_err());
        assert!(parse("SELECT * FROM orders").is_err());
    }

    #[test]
    fn raw_commands_and_dotted_collections() {
        let q = parse(r#"{ "find": "orders", "filter": { "userId": 42 } }"#).unwrap();
        assert_eq!(q.collection, "orders");
        let q = parse("db.audit.log.countDocuments({ level: 'error' })").unwrap();
        assert_eq!(q.collection, "audit.log");
        assert!(q.command.contains_key("aggregate"));
        assert!(parse(r#"{ "dropDatabase": 1 }"#).is_err());
    }
}
