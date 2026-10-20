//! MongoDB operations, as the SDK writes them: one canonical, value-free text per command,
//! so they're fingerprinted, grouped and evaluated like SQL statements.
//!
//! ```text
//! db.order_items.find({"orderId": ?}).sort({"createdAt": -1}).limit(?)   the driver
//! OrderItem.find({"orderId": ?})                                           Mongoose (the model)
//! db.orders.aggregate([{"$match": {"userId": ?}}, {"$lookup": {…}}])
//! db.orders.insert([?])   db.orders.update({"_id": ?}, {"$set": {"status": ?}})
//! ```
//!
//! The command is the wire command (`find`, `aggregate`, `count`, `distinct`, `insert`,
//! `update`, `delete`, `findAndModify`). Arguments are relaxed JSON: values are `?`, field
//! paths and operators stay. [`crate::capture::sql::shape`] answers for these statements
//! through this module, so detection and advice need no MongoDB-specific path. Pure.

use crate::model::StatementKind;

/// One parsed operation.
#[derive(Debug, Clone, PartialEq)]
pub struct Operation {
    /// The collection (driver), or the Mongoose model.
    pub target: String,
    /// Written by Mongoose, through `target` (a model); else by the driver.
    pub via_model: bool,
    pub command: String,
    /// The command's arguments, then each chained modifier (`sort`, `limit`, …) with its own.
    pub args: Vec<Value>,
    pub modifiers: Vec<(String, Vec<Value>)>,
}

/// Relaxed JSON with placeholders.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Object(Vec<(String, Value)>),
    Array(Vec<Value>),
    /// A value the SDK removed.
    Placeholder,
    Str(String),
    Num(f64),
    /// `true`, `false`, `null`, or anything else bare.
    Word(String),
}

impl Value {
    fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

/// A field compared in a filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub path: String,
    /// A value or `$in` / `$eq`, as opposed to a range, a pattern or `$exists`.
    pub equality: bool,
}

/// The operation, if `text` is one.
pub fn parse(text: &str) -> Option<Operation> {
    let text = text.trim();
    let open = text.find('(')?;
    let head = &text[..open];
    let (target, command) = head.rsplit_once('.')?;
    if !is_name(command) || target.is_empty() {
        return None;
    }
    let (target, via_model) = match target.strip_prefix("db.") {
        Some(collection) if !collection.is_empty() => (collection.to_string(), false),
        _ if is_name(target) && target.starts_with(|c: char| c.is_ascii_uppercase()) => (target.to_string(), true),
        _ => return None,
    };
    let mut p = Parser { s: text.as_bytes(), i: open };
    let args = p.call_args()?;
    let mut modifiers = Vec::new();
    while p.eat(b'.') {
        let name = p.name()?;
        modifiers.push((name, p.call_args()?));
    }
    p.skip_ws();
    (p.i == p.s.len()).then_some(Operation { target, via_model, command: command.to_string(), args, modifiers })
}

fn is_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

impl Operation {
    pub fn kind(&self) -> StatementKind {
        match self.command.as_str() {
            "find" | "aggregate" | "count" | "distinct" => StatementKind::Select,
            "insert" => StatementKind::Insert,
            "update" | "findAndModify" => StatementKind::Update,
            "delete" => StatementKind::Delete,
            _ => StatementKind::Other,
        }
    }

    /// The filter: the first argument, or a pipeline's first `$match`, or `distinct`'s query.
    pub fn filter(&self) -> Option<&Value> {
        match self.command.as_str() {
            "aggregate" => match self.args.first()? {
                Value::Array(stages) => stages.iter().find_map(|s| s.get("$match")),
                _ => None,
            },
            "distinct" => self.args.get(1),
            _ => self.args.first(),
        }
    }

    /// Fields the filter compares, top level and inside `$and`.
    pub fn filter_fields(&self) -> Vec<Field> {
        let mut out = Vec::new();
        if let Some(f) = self.filter() {
            collect_fields(f, &mut out);
        }
        out
    }

    /// Whether the result is limited: `.limit()`, a `$limit` stage, or a count.
    pub fn limited(&self) -> bool {
        self.modifiers.iter().any(|(m, _)| m == "limit")
            || matches!(self.command.as_str(), "count" | "distinct" | "findAndModify")
            || matches!(self.args.first(), Some(Value::Array(stages)) if self.command == "aggregate" && stages.iter().any(|s| s.get("$limit").is_some() || s.get("$count").is_some()))
    }

    /// Collections a pipeline joins (`$lookup`), after the target.
    pub fn lookups(&self) -> Vec<String> {
        match (self.command.as_str(), self.args.first()) {
            ("aggregate", Some(Value::Array(stages))) => stages
                .iter()
                .filter_map(|s| match s.get("$lookup")?.get("from")? {
                    Value::Str(c) => Some(c.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }
}

fn collect_fields(filter: &Value, out: &mut Vec<Field>) {
    let Value::Object(pairs) = filter else { return };
    for (key, value) in pairs {
        if key == "$and" {
            if let Value::Array(parts) = value {
                parts.iter().for_each(|p| collect_fields(p, out));
            }
            continue;
        }
        if key.starts_with('$') {
            continue;
        }
        let equality = match value {
            Value::Object(ops) if ops.iter().all(|(k, _)| k.starts_with('$')) => ops.iter().all(|(k, _)| k == "$in" || k == "$eq"),
            _ => true,
        };
        if !out.iter().any(|f| f.path == *key) {
            out.push(Field { path: key.clone(), equality });
        }
    }
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn skip_ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        self.skip_ws();
        if self.s.get(self.i) == Some(&c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn name(&mut self) -> Option<String> {
        self.skip_ws();
        let start = self.i;
        while self.i < self.s.len() && (self.s[self.i].is_ascii_alphanumeric() || self.s[self.i] == b'_' || self.s[self.i] == b'$') {
            self.i += 1;
        }
        (self.i > start).then(|| String::from_utf8_lossy(&self.s[start..self.i]).into_owned())
    }

    /// `( value, … )`
    fn call_args(&mut self) -> Option<Vec<Value>> {
        if !self.eat(b'(') {
            return None;
        }
        let mut args = Vec::new();
        if self.eat(b')') {
            return Some(args);
        }
        loop {
            args.push(self.value()?);
            if self.eat(b')') {
                return Some(args);
            }
            if !self.eat(b',') {
                return None;
            }
        }
    }

    fn value(&mut self) -> Option<Value> {
        self.skip_ws();
        match *self.s.get(self.i)? {
            b'{' => {
                self.i += 1;
                let mut pairs = Vec::new();
                if self.eat(b'}') {
                    return Some(Value::Object(pairs));
                }
                loop {
                    self.skip_ws();
                    let key = if self.s.get(self.i) == Some(&b'"') { self.string()? } else { self.name()? };
                    if !self.eat(b':') {
                        return None;
                    }
                    pairs.push((key, self.value()?));
                    if self.eat(b'}') {
                        return Some(Value::Object(pairs));
                    }
                    if !self.eat(b',') {
                        return None;
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                if self.eat(b']') {
                    return Some(Value::Array(items));
                }
                loop {
                    items.push(self.value()?);
                    if self.eat(b']') {
                        return Some(Value::Array(items));
                    }
                    if !self.eat(b',') {
                        return None;
                    }
                }
            }
            b'?' => {
                self.i += 1;
                Some(Value::Placeholder)
            }
            b'"' => self.string().map(Value::Str),
            c if c == b'-' || c.is_ascii_digit() => {
                let start = self.i;
                self.i += 1;
                while self.i < self.s.len() && (self.s[self.i].is_ascii_digit() || matches!(self.s[self.i], b'.' | b'e' | b'E' | b'+' | b'-')) {
                    self.i += 1;
                }
                std::str::from_utf8(&self.s[start..self.i]).ok()?.parse().ok().map(Value::Num)
            }
            _ => self.name().map(Value::Word),
        }
    }

    /// A JSON string, its escapes undone.
    fn string(&mut self) -> Option<String> {
        let start = self.i;
        self.i += 1;
        while self.i < self.s.len() {
            match self.s[self.i] {
                b'\\' => self.i += 2,
                b'"' => {
                    self.i += 1;
                    return serde_json::from_slice(&self.s[start..self.i]).ok();
                }
                _ => self.i += 1,
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_driver_and_mongoose_forms() {
        let op = parse(r#"db.order_items.find({"orderId": ?, "status": {"$in": [?]}}).sort({"createdAt": -1}).limit(?)"#).unwrap();
        assert_eq!((op.target.as_str(), op.via_model, op.command.as_str(), op.kind()), ("order_items", false, "find", StatementKind::Select));
        assert_eq!(op.filter_fields(), vec![Field { path: "orderId".into(), equality: true }, Field { path: "status".into(), equality: true }]);
        assert!(op.limited());
        let m = parse(r#"OrderItem.find({"order": ?, "price": {"$gt": ?}})"#).unwrap();
        assert_eq!((m.target.as_str(), m.via_model), ("OrderItem", true));
        assert_eq!(m.filter_fields()[1], Field { path: "price".into(), equality: false });
        assert!(!m.limited());
        let dotted = parse(r#"db.fs.files.find({})"#).unwrap();
        assert_eq!(dotted.target, "fs.files", "collection names may hold dots");
    }

    #[test]
    fn pipelines_writes_and_kinds() {
        let agg = parse(r#"db.orders.aggregate([{"$match": {"$and": [{"userId": ?}, {"total": {"$gte": ?}}]}}, {"$lookup": {"from": "users", "localField": "userId", "foreignField": "_id", "as": "user"}}, {"$limit": ?}])"#).unwrap();
        assert_eq!(agg.filter_fields().iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["userId", "total"]);
        assert_eq!(agg.lookups(), ["users"]);
        assert!(agg.limited());
        assert_eq!(parse("db.events.insert([?])").unwrap().kind(), StatementKind::Insert);
        let up = parse(r#"db.orders.update({"_id": ?}, {"$set": {"status": ?}})"#).unwrap();
        assert_eq!((up.kind(), up.filter_fields()[0].path.as_str()), (StatementKind::Update, "_id"));
        assert_eq!(parse(r#"db.orders.distinct("status", {"userId": ?})"#).unwrap().filter_fields()[0].path, "userId");
        assert_eq!(parse("db.orders.ping()").unwrap().kind(), StatementKind::Other);
    }

    /// What the SDK wrote for a real MongoDB 8 (driver 7, Mongoose 9).
    #[test]
    fn reads_what_the_sdk_sends() {
        for (text, target, kind) in [
            (r#"db.orders.insert([?])"#, "orders", StatementKind::Insert),
            (r#"db.order_items.find({"orderId": ?})"#, "order_items", StatementKind::Select),
            (r#"db.orders.find({})"#, "orders", StatementKind::Select),
            (
                r#"db.orders.aggregate([{"$match": {"userId": ?, "total": {"$gte": ?}}}, {"$lookup": {"from": "users", "localField": "userId", "foreignField": "_id", "as": "user"}}, {"$limit": ?}])"#,
                "orders",
                StatementKind::Select,
            ),
            (r#"db.orders.update({"userId": ?}, {"$set": {"status": ?}})"#, "orders", StatementKind::Update),
            (r#"Customer.find({"_id": {"$in": [?]}})"#, "Customer", StatementKind::Select),
            (r#"Order.aggregate([{"$group": {"_id": "$customer", "n": {"$sum": 1}}}])"#, "Order", StatementKind::Select),
            (r#"db.orders.find({"total": {"$exists": true}}).sort({"createdAt": -1}).skip(?).limit(?)"#, "orders", StatementKind::Select),
        ] {
            let op = parse(text).unwrap_or_else(|| panic!("unparsed: {text}"));
            assert_eq!((op.target.as_str(), op.kind()), (target, kind), "{text}");
        }
    }

    #[test]
    fn sql_is_not_an_operation() {
        for sql in [
            "SELECT * FROM orders WHERE id = $1",
            r#"select "id" from "orders" where "orders"."user_id" = ?"#,
            "INSERT INTO db.orders (id) VALUES (1)",
            "SELECT count(*) FROM t",
            "db.orders.find({",
            "orders.find({})",
        ] {
            assert_eq!(parse(sql), None, "{sql}");
        }
    }
}
