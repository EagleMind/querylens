//! Lightweight structural reading of a SQL statement: what kind it is, which tables
//! it touches, which columns it filters on with a value. Not a parser: a tokenizer
//! plus patterns that hold for the SQL ORMs generate.

use crate::model::StatementKind;

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// Identifier or keyword; `quoted` for `"double-quoted"` identifiers.
    Word { text: String, quoted: bool },
    /// String or numeric literal, `$n` or `?` parameter.
    Value,
    Punct(char),
    /// Comparison operator (`=`, `<>`, `>=`, …).
    Op(String),
}

impl Tok {
    fn is_kw(&self, kw: &str) -> bool {
        matches!(self, Tok::Word { text, quoted: false } if text.eq_ignore_ascii_case(kw))
    }
    fn ident(&self) -> Option<&str> {
        match self {
            Tok::Word { text, quoted: true } => Some(text),
            Tok::Word { text, quoted: false } if !is_keyword(text) => Some(text),
            _ => None,
        }
    }
}

const KEYWORDS: &[&str] = &[
    "select", "from", "where", "and", "or", "not", "in", "is", "null", "as", "on", "join", "left", "right",
    "inner", "outer", "full", "cross", "lateral", "group", "order", "by", "having", "limit", "offset", "fetch",
    "union", "all", "distinct", "insert", "into", "values", "update", "set", "delete", "returning", "with",
    "using", "case", "when", "then", "else", "end", "any", "exists", "between", "like", "ilike", "for",
    "default", "conflict", "do", "nothing", "asc", "desc", "nulls", "first", "last", "true", "false",
];

fn is_keyword(w: &str) -> bool {
    KEYWORDS.iter().any(|k| k.eq_ignore_ascii_case(w))
}

fn tokenize(sql: &str) -> Vec<Tok> {
    let chars: Vec<char> = sql.chars().collect();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            _ if c.is_whitespace() => i += 1,
            '-' if chars.get(i + 1) == Some(&'-') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
            }
            '\'' => {
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\'' {
                        if chars.get(i + 1) == Some(&'\'') {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
                toks.push(Tok::Value);
            }
            '"' | '`' => {
                // Quoted identifier: PostgreSQL "…", MySQL `…`.
                let start = i + 1;
                i = start;
                while i < chars.len() && chars[i] != c {
                    i += 1;
                }
                toks.push(Tok::Word { text: chars[start..i.min(chars.len())].iter().collect(), quoted: true });
                i += 1;
            }
            '$' if chars.get(i + 1).is_some_and(char::is_ascii_digit) => {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                toks.push(Tok::Value);
            }
            '?' => {
                i += 1;
                toks.push(Tok::Value);
            }
            _ if c.is_ascii_digit() => {
                while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '.') {
                    i += 1;
                }
                toks.push(Tok::Value);
            }
            _ if c.is_alphanumeric() || c == '_' => {
                let start = i;
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '$') {
                    i += 1;
                }
                let text: String = chars[start..i].iter().collect();
                // E'…' / B'…' / X'…' string prefixes.
                if text.len() == 1 && chars.get(i) == Some(&'\'') {
                    continue;
                }
                toks.push(Tok::Word { text, quoted: false });
            }
            '=' | '<' | '>' | '!' => {
                let start = i;
                while i < chars.len() && matches!(chars[i], '=' | '<' | '>' | '!') {
                    i += 1;
                }
                toks.push(Tok::Op(chars[start..i].iter().collect()));
            }
            ':' if chars.get(i + 1) == Some(&':') => {
                // Cast: `$1::int` — skip the type name.
                i += 2;
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
            }
            _ => {
                toks.push(Tok::Punct(c));
                i += 1;
            }
        }
    }
    toks
}

pub fn kind(sql: &str) -> StatementKind {
    let toks = tokenize(sql);
    let mut depth = 0i32;
    for t in &toks {
        match t {
            Tok::Punct('(') => depth += 1,
            Tok::Punct(')') => depth -= 1,
            _ if depth == 0 => {
                for (kw, k) in [
                    ("select", StatementKind::Select),
                    ("insert", StatementKind::Insert),
                    ("update", StatementKind::Update),
                    ("delete", StatementKind::Delete),
                ] {
                    if t.is_kw(kw) {
                        return k;
                    }
                }
                // WITH … AS (…): keep looking for the main statement after the CTEs.
                if !t.is_kw("with") && !t.is_kw("as") && !t.is_kw("recursive") && !matches!(t, Tok::Punct(',')) && t.ident().is_none() {
                    return StatementKind::Other;
                }
            }
            _ => {}
        }
    }
    StatementKind::Other
}

/// A table referenced by the statement, with the alias it goes by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableRef {
    /// Unqualified name, as written (case preserved).
    pub name: String,
    pub alias: Option<String>,
}

impl TableRef {
    fn answers_to(&self, qualifier: &str) -> bool {
        self.alias.as_deref() == Some(qualifier) || self.name == qualifier
    }
}

/// Tables after FROM / JOIN / UPDATE / INTO, in order of appearance, without duplicates.
pub fn tables(sql: &str) -> Vec<TableRef> {
    let toks = tokenize(sql);
    let mut out: Vec<TableRef> = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let t = &toks[i];
        let starts_list = t.is_kw("from") || t.is_kw("join") || t.is_kw("update") || t.is_kw("into");
        i += 1;
        if !starts_list {
            continue;
        }
        let into = t.is_kw("into");
        while let Some((table, next)) = table_ref(&toks, i, into) {
            if !out.iter().any(|r| r.name == table.name && r.alias == table.alias) {
                out.push(table);
            }
            i = next;
            // `FROM a, b` (only when a table follows the comma).
            if matches!(toks.get(i), Some(Tok::Punct(','))) && toks.get(i + 1).and_then(Tok::ident).is_some() {
                i += 1;
            } else {
                break;
            }
        }
    }
    out
}

/// `[schema.]name [[AS] alias]` starting at `i`. After INTO, `(` opens the column list.
fn table_ref(toks: &[Tok], mut i: usize, into: bool) -> Option<(TableRef, usize)> {
    let mut name = toks.get(i)?.ident()?.to_string();
    i += 1;
    while matches!(toks.get(i), Some(Tok::Punct('.'))) {
        name = toks.get(i + 1)?.ident()?.to_string();
        i += 2;
    }
    if matches!(toks.get(i), Some(Tok::Punct('('))) {
        // A function call (`FROM unnest(…)`) is not a table.
        return into.then_some((TableRef { name, alias: None }, i));
    }
    let mut alias = None;
    if toks.get(i).is_some_and(|t| t.is_kw("as")) {
        alias = toks.get(i + 1).and_then(Tok::ident).map(String::from);
        i += 2;
    } else if let Some(a) = toks.get(i).and_then(Tok::ident) {
        alias = Some(a.to_string());
        i += 1;
    }
    Some((TableRef { name, alias }, i))
}

/// A column compared with a value (`col = $1`, `t.col IN (…)`, `col = ANY($1)`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Filter {
    /// The table it belongs to, when the qualifier (or the only table) says so.
    pub table: Option<String>,
    pub column: String,
    /// Equality / IN, as opposed to a range or pattern comparison.
    pub equality: bool,
}

pub fn filters(sql: &str) -> Vec<Filter> {
    let toks = tokenize(sql);
    let refs = tables(sql);
    let mut out: Vec<Filter> = Vec::new();
    let mut i = 0;
    // `UPDATE … SET a = $1` assigns; it doesn't filter.
    let mut in_set = false;
    while i < toks.len() {
        if toks[i].is_kw("set") {
            in_set = true;
        } else if toks[i].is_kw("where") || toks[i].is_kw("from") || toks[i].is_kw("returning") {
            in_set = false;
        }
        let Some((qualifier, column, next)) = column_ref(&toks, i).filter(|_| !in_set) else {
            i += 1;
            continue;
        };
        let compared = match toks.get(next) {
            Some(Tok::Op(op)) => {
                let value_follows = matches!(toks.get(next + 1), Some(Tok::Value))
                    || (toks.get(next + 1).is_some_and(|t| t.is_kw("any"))
                        && matches!(toks.get(next + 2), Some(Tok::Punct('('))));
                value_follows.then(|| op == "=")
            }
            Some(t) if t.is_kw("in") => {
                (matches!(toks.get(next + 1), Some(Tok::Punct('('))) && matches!(toks.get(next + 2), Some(Tok::Value)))
                    .then_some(true)
            }
            Some(t) if t.is_kw("like") || t.is_kw("ilike") || t.is_kw("between") => Some(false),
            _ => None,
        };
        if let Some(equality) = compared {
            let table = match &qualifier {
                Some(q) => refs.iter().find(|r| r.answers_to(q)).map(|r| r.name.clone()),
                None if refs.len() == 1 => Some(refs[0].name.clone()),
                None => None,
            };
            let f = Filter { table, column, equality };
            if !out.contains(&f) {
                out.push(f);
            }
        }
        i = next;
    }
    out
}

/// `[[schema.]qualifier.]column` starting at `i`, if the token there is an identifier.
/// Prisma qualifies columns with the schema too: `"public"."User"."id"`.
fn column_ref(toks: &[Tok], i: usize) -> Option<(Option<String>, String, usize)> {
    // An identifier right after `.` is the rest of a qualified name.
    if i > 0 && matches!(toks.get(i - 1), Some(Tok::Punct('.'))) {
        return None;
    }
    let mut parts = vec![toks.get(i)?.ident()?];
    let mut next = i + 1;
    while matches!(toks.get(next), Some(Tok::Punct('.'))) {
        parts.push(toks.get(next + 1)?.ident()?);
        next += 2;
    }
    let column = parts.pop()?.to_string();
    Some((parts.pop().map(String::from), column, next))
}

/// Whether the outermost query limits its rows (LIMIT / FETCH FIRST).
pub fn has_limit(sql: &str) -> bool {
    let mut depth = 0i32;
    for t in tokenize(sql) {
        match t {
            Tok::Punct('(') => depth += 1,
            Tok::Punct(')') => depth -= 1,
            _ if depth == 0 && (t.is_kw("limit") || t.is_kw("fetch")) => return true,
            _ => {}
        }
    }
    false
}

/// The table a statement mainly reads or writes: the first one it names.
pub fn main_table(sql: &str) -> Option<TableRef> {
    tables(sql).into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEQUELIZE_LAZY: &str = r#"SELECT "order_id", "product_id", "quantity" FROM "order_items" AS "OrderItem" WHERE "OrderItem"."order_id" = '42';"#;

    #[test]
    fn kinds() {
        assert_eq!(kind(SEQUELIZE_LAZY), StatementKind::Select);
        assert_eq!(kind("INSERT INTO \"Users\" (\"id\") VALUES (DEFAULT) RETURNING *;"), StatementKind::Insert);
        assert_eq!(kind("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"), StatementKind::Select);
        assert_eq!(kind("with recursive r as (select 1) update t set a = 1"), StatementKind::Update);
        assert_eq!(kind("BEGIN"), StatementKind::Other);
        assert_eq!(kind("SET search_path = x"), StatementKind::Other);
    }

    #[test]
    fn tables_and_aliases() {
        let t = tables(SEQUELIZE_LAZY);
        assert_eq!(t, vec![TableRef { name: "order_items".into(), alias: Some("OrderItem".into()) }]);
        let joined = r#"SELECT "Order"."id", "items"."quantity" AS "items.quantity" FROM "public"."orders" AS "Order"
            LEFT OUTER JOIN "order_items" AS "items" ON "Order"."id" = "items"."order_id" WHERE "Order"."user_id" = 7"#;
        let names: Vec<_> = tables(joined).into_iter().map(|t| (t.name, t.alias.unwrap())).collect();
        assert_eq!(names, [("orders".into(), "Order".into()), ("order_items".into(), "items".into())]);
        assert_eq!(tables("select * from a, b where a.x = b.y").len(), 2);
        assert!(tables("select * from unnest($1::int[])").is_empty());
        let insert = r#"INSERT INTO "events" ("id","kind") VALUES (DEFAULT,$1) RETURNING "id";"#;
        assert_eq!(tables(insert), vec![TableRef { name: "events".into(), alias: None }]);
    }

    #[test]
    fn value_filters_resolve_their_table() {
        let f = filters(SEQUELIZE_LAZY);
        assert_eq!(f, vec![Filter { table: Some("order_items".into()), column: "order_id".into(), equality: true }]);
        let joined = r#"SELECT * FROM orders o JOIN users u ON u.id = o.user_id
            WHERE o.status IN ('paid', 'new') AND u.created_at > $1 AND u.email LIKE '%x'"#;
        let f = filters(joined);
        assert!(f.contains(&Filter { table: Some("orders".into()), column: "status".into(), equality: true }));
        assert!(f.contains(&Filter { table: Some("users".into()), column: "created_at".into(), equality: false }));
        assert!(f.contains(&Filter { table: Some("users".into()), column: "email".into(), equality: false }));
        // Join conditions compare two columns: not value filters.
        assert!(!f.iter().any(|x| x.column == "user_id" || x.column == "id"));
        assert_eq!(filters("select * from t where id = any($1::bigint[])")[0].column, "id");
        let update = r#"UPDATE "orders" SET "status"=$1,"total"=$2 WHERE "id" = $3"#;
        assert_eq!(filters(update), vec![Filter { table: Some("orders".into()), column: "id".into(), equality: true }]);
        let prisma = r#"SELECT "public"."OrderItem"."id" FROM "public"."OrderItem" WHERE "public"."OrderItem"."orderId" = $1 OFFSET $2"#;
        assert_eq!(filters(prisma), vec![Filter { table: Some("OrderItem".into()), column: "orderId".into(), equality: true }]);
    }

    #[test]
    fn mysql_backticks_are_identifiers() {
        let sql = "SELECT `OrderItem`.`id` FROM `order_items` AS `OrderItem` WHERE `OrderItem`.`order_id` = ? LIMIT 10;";
        let t = main_table(sql).unwrap();
        assert_eq!((t.name.as_str(), t.alias.as_deref()), ("order_items", Some("OrderItem")));
        let f = &filters(sql)[0];
        assert_eq!((f.table.as_deref(), f.column.as_str(), f.equality), (Some("order_items"), "order_id", true));
        assert!(has_limit(sql));
        assert_eq!(kind("INSERT INTO `events` (`kind`) VALUES (?)"), StatementKind::Insert);
    }

    #[test]
    fn limits() {
        assert!(has_limit("SELECT * FROM t ORDER BY id LIMIT 10;"));
        assert!(!has_limit("SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 5)"));
        assert!(has_limit("select * from t fetch first 5 rows only"));
    }
}
