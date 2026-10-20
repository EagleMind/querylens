//! Knex fixes, with the Kysely equivalent alongside: the two query builders write
//! byte-identical SQL, so the capture can't tell which one the application uses.
//! Both name tables and columns as the database does.

use super::naming::{camel, index_columns, quoted_list, singular};
use super::templates::{Advice, Templates, fill};
use super::Facts;
use crate::model::{Orm, StatementKind};

pub struct Knex;

struct Names {
    table: String,
    parent_table: String,
    /// The variable holding the parent rows.
    parents: String,
    key: String,
}

impl Names {
    fn of(facts: &Facts) -> Self {
        let parent_table = facts.parent_table.clone().unwrap_or_else(|| "parents".into());
        Self {
            table: facts.table.clone().unwrap_or_else(|| "table".into()),
            parents: camel(&parent_table),
            parent_table,
            key: facts.key.clone().unwrap_or_else(|| "parent_id".into()),
        }
    }

    fn vars(&self) -> Vec<(&str, &str)> {
        vec![("table", &self.table), ("parentTable", &self.parent_table), ("parents", &self.parents), ("key", &self.key)]
    }
}

impl Templates for Knex {
    const ORM: Orm = Orm::Knex;

    fn n_plus_one(&self, facts: &Facts) -> Advice {
        let n = Names::of(facts);
        if facts.by_primary_key() {
            let fk = format!("{}_id", singular(&n.table));
            let mut vars = n.vars();
            vars.push(("fk", &fk));
            Advice::new(
                fill(
                    "Each {{parentTable}} row loads its {{table}} row by id with its own query. Collect the ids and \
                     load them in one query (or join {{table}} into the query that lists the {{parentTable}} rows).",
                    &vars,
                ),
                fill(
                    r#"
const ids = [...new Set({{parents}}.map((row) => row.{{fk}}))];
const related = await knex('{{table}}').whereIn('id', ids);
const byId = new Map(related.map((r) => [r.id, r]));

// Kysely:
// const related = await db.selectFrom('{{table}}').selectAll().where('id', 'in', ids).execute();"#,
                    &vars,
                ),
            )
        } else {
            Advice::new(
                fill(
                    "For each {{parentTable}} row, its {{table}} rows are fetched with their own query. Fetch the \
                     children of all of them with one `WHERE {{key}} IN (…)` query and group them in memory.",
                    &n.vars(),
                ),
                fill(
                    r#"
const children = await knex('{{table}}').whereIn('{{key}}', {{parents}}.map((row) => row.id));
const byParent = Map.groupBy(children, (c) => c.{{key}});

// Kysely:
// const children = await db.selectFrom('{{table}}').selectAll()
//   .where('{{key}}', 'in', {{parents}}.map((row) => row.id)).execute();"#,
                    &n.vars(),
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
// const x = await knex('{{table}}').where(…).first();
const x = await knex('{{table}}').where(…).first(); // once
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
                "Rows are inserted one at a time. `insert()` takes an array: one INSERT for all of them \
                 (`batchInsert` splits very large arrays into chunks, in one transaction).",
                fill(
                    r#"
await knex('{{table}}').insert(rows); // rows: array of objects
// Thousands of rows: await knex.batchInsert('{{table}}', rows, 500);

// Kysely:
// await db.insertInto('{{table}}').values(rows).execute();"#,
                    &vars,
                ),
            ),
            StatementKind::Update => Advice::new(
                "Rows are updated one at a time. Update them with one statement when they get the same values; \
                 otherwise run the loop in one transaction so it commits once.",
                fill(
                    r#"
await knex('{{table}}').whereIn('id', ids).update(values);

// Different values per row:
// await knex.transaction(async (trx) => {
//   for (const r of rows) await trx('{{table}}').where('id', r.id).update(r.values);
// });

// Kysely:
// await db.updateTable('{{table}}').set(values).where('id', 'in', ids).execute();"#,
                    &vars,
                ),
            ),
            _ => Advice::new(
                "Rows are deleted one at a time. Delete them with one statement.",
                fill(
                    r#"
await knex('{{table}}').whereIn('id', ids).del();

// Kysely:
// await db.deleteFrom('{{table}}').where('id', 'in', ids).execute();"#,
                    &vars,
                ),
            ),
        }
    }

    fn large_result(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The query returns every matching row with every column. Paginate with `limit` and `offset`, select only \
             the columns you use, and count separately when the page needs a total.",
            fill(
                r#"
const rows = await knex('{{table}}')
  .select('id' /* only what you use */)
  .where(…)
  .orderBy('id')
  .limit(50)
  .offset(page * 50);
const { count } = await knex('{{table}}').where(…).count({ count: '*' }).first();

// Kysely:
// await db.selectFrom('{{table}}').select(['id']).where(…).orderBy('id').limit(50).offset(page * 50).execute();"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn index(&self, ddl: &str, facts: &Facts) -> Advice {
        let columns = quoted_list(&index_columns(ddl));
        let n = Names::of(facts);
        let mut vars = n.vars();
        vars.push(("columns", &columns));
        Advice::new(
            "An index lets the database find these rows without scanning the table. Add it with a migration.",
            fill(
                r#"
// migrations/XXXXXXXX_add_{{table}}_index.js
exports.up = (knex) => knex.schema.alterTable('{{table}}', (t) => t.index([{{columns}}]));
exports.down = (knex) => knex.schema.alterTable('{{table}}', (t) => t.dropIndex([{{columns}}]));

// Kysely migration:
// await db.schema.createIndex('{{table}}_idx').on('{{table}}').columns([{{columns}}]).execute();"#,
                &vars,
            ),
        )
    }

    fn unique_violation(&self, facts: &Facts) -> Advice {
        Advice::new(
            "Inserts hit a unique constraint: the row already exists. If that's expected, let the database decide \
             instead of failing: merge into the existing row, or skip it.",
            fill(
                r#"
await knex('{{table}}').insert(row).onConflict(['…'] /* the unique columns */).merge();
// Or skip it: .onConflict([…]).ignore()

// Kysely (PostgreSQL):
// await db.insertInto('{{table}}').values(row)
//   .onConflict((oc) => oc.column('…').doUpdateSet(row)).execute();"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn chatty_request(&self) -> Advice {
        Advice::text(
            "Most of these statements are queries issued once per row inside loops. Fix the N+1 findings for this \
             route first: one `whereIn` query per related table (or a join) instead of one query per row.",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::orm::templates::test_support::{covers_every_kind, fix_for};
    use crate::model::FindingKind;

    // As Knex 3 (and Kysely 0.29, identically) write them for PostgreSQL.
    const ORDERS: &str = r#"select * from "orders" where "user_id" = $1"#;
    const ITEMS: &str = r#"select "id", "quantity" from "order_items" where "order_id" = $1"#;
    const PRODUCT: &str = r#"select * from "products" where "id" = $1 limit $2"#;

    #[test]
    fn has_many_n_plus_one_uses_where_in() {
        let code = fix_for(&Knex, FindingKind::NPlusOne, ITEMS, Some(ORDERS)).code.unwrap();
        assert!(code.starts_with("const children = await knex('order_items').whereIn('order_id', orders.map((row) => row.id));"), "{code}");
        assert!(code.contains("db.selectFrom('order_items')"), "{code}");
    }

    #[test]
    fn belongs_to_n_plus_one_collects_ids() {
        let code = fix_for(&Knex, FindingKind::NPlusOne, PRODUCT, Some(ITEMS)).code.unwrap();
        assert!(code.contains("orderItems.map((row) => row.product_id)"), "{code}");
        assert!(code.contains("knex('products').whereIn('id', ids)"), "{code}");
    }

    #[test]
    fn looped_writes() {
        let mysql = "insert into `audit_entries` (`at`, `kind`) values (?, ?)";
        let code = fix_for(&Knex, FindingKind::LoopedWrites, mysql, None).code.unwrap();
        assert!(code.starts_with("await knex('audit_entries').insert(rows);"), "{code}");
        let update = r#"update "orders" set "status" = $1 where "id" = $2"#;
        let code = fix_for(&Knex, FindingKind::LoopedWrites, update, None).code.unwrap();
        assert!(code.starts_with("await knex('orders').whereIn('id', ids).update(values);"), "{code}");
    }

    #[test]
    fn every_kind() {
        covers_every_kind(&Knex, ORDERS);
    }
}
