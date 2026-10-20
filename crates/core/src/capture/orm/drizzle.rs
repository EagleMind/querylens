//! Drizzle ORM fixes, in its SQL-like API and the relational query API (`db.query`).
//! Tables are TypeScript constants, usually the camelCase table name (`orderItems`
//! for `order_items`), with camelCase columns; relational queries alias the root
//! table as that constant's key.

use super::naming::{camel, index_columns, lower_first, model_from_table};
use super::templates::{Advice, Templates, fill};
use super::Facts;
use crate::model::{Orm, StatementKind};

pub struct Drizzle;

struct Names {
    /// The table constant (`orderItems`).
    table: String,
    parent: String,
    /// The foreign key column's property (`orderId`).
    key: String,
}

impl Names {
    fn of(facts: &Facts) -> Self {
        Self {
            table: table_const(facts.alias.as_deref(), facts.table.as_deref(), "table"),
            parent: table_const(facts.parent_alias.as_deref(), facts.parent_table.as_deref(), "parents"),
            key: facts.key.as_deref().map_or_else(|| "parentId".into(), camel),
        }
    }

    fn vars(&self) -> Vec<(&str, &str)> {
        vec![("table", &self.table), ("parent", &self.parent), ("key", &self.key)]
    }
}

/// A relational query's root alias is the schema key itself (`"orderItems"`);
/// nested relations are aliased `parent_relation`, and core queries aren't aliased.
fn table_const(alias: Option<&str>, table: Option<&str>, fallback: &str) -> String {
    match (alias, table) {
        (Some(a), Some(t)) if a != t && !a.contains('_') => a.to_string(),
        (_, Some(t)) => camel(t),
        _ => fallback.into(),
    }
}

impl Templates for Drizzle {
    const ORM: Orm = Orm::Drizzle;

    fn n_plus_one(&self, facts: &Facts) -> Advice {
        let n = Names::of(facts);
        let parent_table = facts.parent_table.as_deref().unwrap_or("the parent table");
        if facts.by_primary_key() {
            let relation = lower_first(&model_from_table(facts.table.as_deref().unwrap_or("parent")));
            let mut vars = n.vars();
            vars.extend([("relation", relation.as_str()), ("parentTable", parent_table)]);
            Advice::new(
                fill(
                    "Each {{parentTable}} row loads its {{relation}} with a separate query (a `select … where id = …` \
                     per row). Load it with the rows instead: `with` on the relational query (one statement), or a \
                     join.",
                    &vars,
                ),
                fill(
                    r#"
const rows = await db.query.{{parent}}.findMany({
  where: …,
  with: { {{relation}}: true }, // a one() relation declared on {{parent}}
});

// Or with a join:
// await db.select().from({{parent}}).leftJoin({{table}}, eq({{table}}.id, {{parent}}.{{relation}}Id));"#,
                    &vars,
                ),
            )
        } else {
            let mut vars = n.vars();
            vars.push(("parentTable", parent_table));
            Advice::new(
                fill(
                    "For each {{parentTable}} row, its {{table}} rows are fetched with their own query. Load them with \
                     the parent rows: `with` on the relational query aggregates every row's children in the same \
                     statement, or fetch all children at once with `inArray`.",
                    &vars,
                ),
                fill(
                    r#"
const rows = await db.query.{{parent}}.findMany({
  where: …,
  with: { {{table}}: true }, // a many() relation declared on {{parent}}
});

// Or, when you already have the parent rows, one query for all children:
// const children = await db.select().from({{table}})
//   .where(inArray({{table}}.{{key}}, rows.map((row) => row.id)));"#,
                    &vars,
                ),
            )
        }
    }

    fn duplicate_query(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The identical query runs again and again with the same values, typically inside a loop or once per item \
             in a request. Load it once, before the loop, and reuse the result.",
            fill(
                r#"
// Before: inside the loop
// const [x] = await db.select().from({{table}}).where(…);
const [x] = await db.select().from({{table}}).where(…); // once
for (const item of items) {
  use(item, x);
}"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn looped_writes(&self, kind: StatementKind, facts: &Facts) -> Advice {
        let n = Names::of(facts);
        let vars = n.vars();
        match kind {
            StatementKind::Insert => Advice::new(
                "Rows are inserted one `db.insert().values()` at a time. `values()` takes an array: one INSERT for \
                 all of them.",
                fill(
                    r#"
await db.insert({{table}}).values(rows); // rows: array of objects

// Skip rows that already exist (PostgreSQL, SQLite; MySQL: .onDuplicateKeyUpdate(…)):
// await db.insert({{table}}).values(rows).onConflictDoNothing();"#,
                    &vars,
                ),
            ),
            StatementKind::Update => Advice::new(
                "Rows are updated one at a time. Update them with one statement when they get the same values; \
                 otherwise run the loop in one transaction so it commits once.",
                fill(
                    r#"
await db.update({{table}}).set(values).where(inArray({{table}}.id, ids));

// Different values per row:
// await db.transaction(async (tx) => {
//   for (const r of rows) await tx.update({{table}}).set(r.values).where(eq({{table}}.id, r.id));
// });"#,
                    &vars,
                ),
            ),
            _ => Advice::new(
                "Rows are deleted one at a time. Delete them with one statement.",
                fill("await db.delete({{table}}).where(inArray({{table}}.id, ids));", &vars),
            ),
        }
    }

    fn large_result(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The query returns every matching row with every column. Paginate with `limit` and `offset`, select only \
             the columns you use, and count separately when the page needs a total.",
            fill(
                r#"
const rows = await db
  .select({ id: {{table}}.id /* only what you use */ })
  .from({{table}})
  .where(filter)
  .orderBy({{table}}.id)
  .limit(50)
  .offset(page * 50);
const total = await db.$count({{table}}, filter);"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn index(&self, ddl: &str, facts: &Facts) -> Advice {
        let n = Names::of(facts);
        let columns = index_columns(ddl);
        let on = columns.iter().map(|c| format!("t.{}", camel(c))).collect::<Vec<_>>().join(", ");
        let table = facts.table.clone().unwrap_or_else(|| "table".into());
        let name = format!("{table}_{}_idx", columns.join("_"));
        let mut vars = n.vars();
        vars.extend([("on", on.as_str()), ("name", name.as_str()), ("sqlTable", table.as_str())]);
        Advice::new(
            "An index lets the database find these rows without scanning the table. Declare it on the table and let \
             drizzle-kit generate the migration.",
            fill(
                r#"
export const {{table}} = pgTable('{{sqlTable}}', {
  // …
}, (t) => [index('{{name}}').on({{on}})]);

// then: npx drizzle-kit generate && npx drizzle-kit migrate"#,
                &vars,
            ),
        )
    }

    fn unique_violation(&self, facts: &Facts) -> Advice {
        Advice::new(
            "Inserts hit a unique constraint: the row already exists. If that's expected, let the database decide \
             instead of failing: update the existing row, or skip it.",
            fill(
                r#"
await db.insert({{table}}).values(row)
  .onConflictDoUpdate({ target: {{table}}.… /* the unique column */, set: { … } });

// Or skip it: .onConflictDoNothing()
// MySQL: .onDuplicateKeyUpdate({ set: { … } })"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn chatty_request(&self) -> Advice {
        Advice::text(
            "Most of these statements come from related rows queried one parent at a time inside loops. Fix the N+1 \
             findings for this route first: load relations with `with` on the relational query that lists the rows, \
             or with one `inArray` query per table.",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::orm::templates::test_support::{covers_every_kind, fix_for};
    use crate::model::FindingKind;

    // As drizzle-orm 0.45 writes them (node-postgres).
    const ORDERS: &str = r#"select "id", "user_id", "status", "created_at" from "orders" where "orders"."user_id" = $1"#;
    const ITEMS: &str = r#"select "id", "order_id", "quantity" from "order_items" where "order_items"."order_id" = $1"#;
    const USER: &str = r#"select "id", "email" from "users" "users" where "users"."id" = $1 limit $2"#;

    #[test]
    fn has_many_n_plus_one_uses_with() {
        let fix = fix_for(&Drizzle, FindingKind::NPlusOne, ITEMS, Some(ORDERS));
        let code = fix.code.unwrap();
        assert!(code.contains("const rows = await db.query.orders.findMany({"), "{code}");
        assert!(code.contains("with: { orderItems: true }"), "{code}");
        assert!(code.contains(".where(inArray(orderItems.orderId, rows.map((row) => row.id)))"), "{code}");
    }

    #[test]
    fn belongs_to_n_plus_one_uses_with_one() {
        let code = fix_for(&Drizzle, FindingKind::NPlusOne, USER, Some(ORDERS)).code.unwrap();
        assert!(code.contains("db.query.orders.findMany({"), "{code}");
        assert!(code.contains("with: { user: true }"), "{code}");
        assert!(code.contains("leftJoin(users, eq(users.id, orders.userId))"), "{code}");
    }

    #[test]
    fn relational_aliases_name_the_schema_key() {
        let rq = r#"select "orderItems"."id", "orderItems"."order_id" from "order_items" "orderItems" where "orderItems"."order_id" = $1"#;
        let insert = r#"insert into "audit_entries" ("id", "kind", "at") values (default, $1, $2)"#;
        let code = fix_for(&Drizzle, FindingKind::LoopedWrites, insert, None).code.unwrap();
        assert!(code.starts_with("await db.insert(auditEntries).values(rows);"), "{code}");
        let code = fix_for(&Drizzle, FindingKind::NPlusOne, rq, Some(ORDERS)).code.unwrap();
        assert!(code.contains("with: { orderItems: true }"), "{code}");
        let update = r#"update "orders" set "status" = $1 where "orders"."id" = $2"#;
        let code = fix_for(&Drizzle, FindingKind::LoopedWrites, update, None).code.unwrap();
        assert!(code.starts_with("await db.update(orders).set(values).where(inArray(orders.id, ids));"), "{code}");
    }

    #[test]
    fn every_kind() {
        covers_every_kind(&Drizzle, ORDERS);
    }
}
