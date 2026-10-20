//! Objection.js fixes: models over Knex, relations declared in `relationMappings` and
//! loaded with `withGraphFetched`. Models name their table (`static tableName`), and
//! columns keep their database names unless the model maps them.

use super::naming::{index_columns, lower_first, model_from_table, plural, quoted_list};
use super::templates::{Advice, Templates, fill};
use super::Facts;
use crate::model::{Orm, StatementKind};

pub struct Objection;

struct Names {
    model: String,
    parent: String,
    parents: String,
    table: String,
    key: String,
}

impl Names {
    fn of(facts: &Facts) -> Self {
        let parent = facts.parent_table.as_deref().map_or_else(|| "Parent".into(), model_from_table);
        Self {
            model: facts.table.as_deref().map_or_else(|| "Model".into(), model_from_table),
            parents: lower_first(&plural(&parent)),
            parent,
            table: facts.table.clone().unwrap_or_else(|| "table".into()),
            key: facts.key.clone().unwrap_or_else(|| "parent_id".into()),
        }
    }

    fn vars(&self) -> Vec<(&str, &str)> {
        vec![("model", &self.model), ("parent", &self.parent), ("parents", &self.parents), ("table", &self.table), ("key", &self.key)]
    }
}

impl Templates for Objection {
    const ORM: Orm = Orm::Objection;

    fn n_plus_one(&self, facts: &Facts) -> Advice {
        let n = Names::of(facts);
        let relation =
            if facts.by_primary_key() { lower_first(&n.model) } else { lower_first(&plural(&n.model)) };
        let mut vars = n.vars();
        vars.push(("relation", &relation));
        let text = if facts.by_primary_key() {
            "Each {{parent}} loads its {{model}} with a separate query (`$relatedQuery('{{relation}}')` or \
             `{{model}}.query().findById()` per row). Load the relation with the {{parent}} rows: \
             `withGraphFetched` fetches every {{model}} in one more query (`WHERE id IN (…)`)."
        } else {
            "For each {{parent}} row, its {{model}} rows are fetched with their own query (`$relatedQuery('{{relation}}')` \
             in a loop). Load the relation with the {{parent}} rows: `withGraphFetched` fetches the children of all of \
             them in one more query (`WHERE {{key}} IN (…)`)."
        };
        Advice::new(
            fill(text, &vars),
            fill(
                r#"
const {{parents}} = await {{parent}}.query()
  .where(…)
  .withGraphFetched('{{relation}}'); // the relation's name in {{parent}}.relationMappings

// Already have the {{parents}}? Load it onto all of them in one query:
// await {{parent}}.fetchGraph({{parents}}, '{{relation}}');"#,
                &vars,
            ),
        )
    }

    fn duplicate_query(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The identical query runs again and again with the same values, typically inside a loop or once per item \
             in a request. Load it once, before the loop, and reuse the result.",
            fill(
                r#"
// Before: inside the loop
// const x = await {{model}}.query().findOne(…);
const x = await {{model}}.query().findOne(…); // once
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
                "Rows are inserted one `insert()` at a time. Objection inserts an array in one statement on \
                 PostgreSQL; elsewhere, use Knex's `batchInsert`.",
                fill(
                    r#"
await {{model}}.query().insert(rows); // PostgreSQL: one INSERT

// MySQL / SQLite:
// await {{model}}.knex().batchInsert('{{table}}', rows, 500);"#,
                    &vars,
                ),
            ),
            StatementKind::Update => Advice::new(
                "Rows are patched one at a time. Patch them with one statement when they get the same values; \
                 otherwise run the loop in one transaction so it commits once.",
                fill(
                    r#"
await {{model}}.query().patch(values).whereIn('id', ids);

// Different values per row:
// await {{model}}.transaction(async (trx) => {
//   for (const r of rows) await {{model}}.query(trx).patch(r.values).findById(r.id);
// });"#,
                    &vars,
                ),
            ),
            _ => Advice::new(
                "Rows are deleted one at a time. Delete them with one statement.",
                fill("await {{model}}.query().delete().whereIn('id', ids);", &vars),
            ),
        }
    }

    fn large_result(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The query loads every matching row and Objection builds a model for each. `page()` fetches one page and \
             the total count; select only the columns you use.",
            fill(
                r#"
const { results, total } = await {{model}}.query()
  .select('id' /* only what you use */)
  .where(…)
  .orderBy('id')
  .page(page, 50);"#,
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
            "An index lets the database find these rows without scanning the table. Add it with a Knex migration.",
            fill(
                r#"
// migrations/XXXXXXXX_add_{{table}}_index.js
exports.up = (knex) => knex.schema.alterTable('{{table}}', (t) => t.index([{{columns}}]));
exports.down = (knex) => knex.schema.alterTable('{{table}}', (t) => t.dropIndex([{{columns}}]));"#,
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
await {{model}}.query().insert(row).onConflict('…' /* the unique column */).merge();
// Or skip it: .onConflict('…').ignore()"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn chatty_request(&self) -> Advice {
        Advice::text(
            "Most of these statements come from relations queried one row at a time (`$relatedQuery` inside loops). \
             Fix the N+1 findings for this route first: `withGraphFetched` on the query that lists the rows.",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::orm::templates::test_support::{covers_every_kind, fix_for};
    use crate::model::FindingKind;

    // As Objection 4 writes them (over Knex, PostgreSQL).
    const ORDERS: &str = r#"select "orders".* from "orders" where "user_id" = $1"#;
    const ITEMS: &str = r#"select "order_items".* from "order_items" where "order_items"."order_id" in ($1)"#;
    const PRODUCT: &str = r#"select "products".* from "products" where "products"."id" = $1"#;

    #[test]
    fn n_plus_one_uses_with_graph_fetched() {
        let fix = fix_for(&Objection, FindingKind::NPlusOne, ITEMS, Some(ORDERS));
        let code = fix.code.unwrap();
        assert!(code.contains("const orders = await Order.query()"), "{code}");
        assert!(code.contains(".withGraphFetched('orderItems')"), "{code}");
        assert!(code.contains("Order.fetchGraph(orders, 'orderItems')"), "{code}");
        assert!(fix.text.contains("WHERE order_id IN (…)"), "{}", fix.text);

        let code = fix_for(&Objection, FindingKind::NPlusOne, PRODUCT, Some(ITEMS)).code.unwrap();
        assert!(code.contains("const orderItems = await OrderItem.query()"), "{code}");
        assert!(code.contains(".withGraphFetched('product')"), "{code}");
    }

    #[test]
    fn looped_patches_become_one() {
        let patch = r#"update "orders" set "status" = $1 where "orders"."id" = $2"#;
        let code = fix_for(&Objection, FindingKind::LoopedWrites, patch, None).code.unwrap();
        assert!(code.starts_with("await Order.query().patch(values).whereIn('id', ids);"), "{code}");
    }

    #[test]
    fn every_kind() {
        covers_every_kind(&Objection, ORDERS);
    }
}
