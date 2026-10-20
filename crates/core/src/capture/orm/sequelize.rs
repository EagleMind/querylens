//! Sequelize (v6/v7) fixes, with code in Sequelize's own API.

use super::naming::{index_columns, lower_first, model_from_table, plural, quoted_list};
use super::templates::{Advice, Templates, fill};
use super::Facts;
use crate::model::{Orm, StatementKind};

pub struct Sequelize;

impl Templates for Sequelize {
    const ORM: Orm = Orm::Sequelize;

    fn n_plus_one(&self, facts: &Facts) -> Advice {
        let child = model_name(facts);
        let parent = facts.parent_alias.clone().or_else(|| facts.parent_table.as_deref().map(model_from_table));
        let parent = parent.as_deref().unwrap_or("Parent");
        let instance = lower_first(parent);
        let vars = [
            ("child", child.as_str()),
            ("parent", parent),
            ("var", &lower_first(&plural(parent))),
            ("key", facts.key.as_deref().unwrap_or("foreignKey")),
            ("instance", &instance),
            ("children", &plural(&child)),
        ];
        if facts.by_primary_key() {
            Advice::new(
                fill(
                    "Each {{parent}} loads its {{child}} with a separate query (a getter such as \
                     `{{instance}}.get{{child}}()`, or `{{child}}.findByPk`, called per row). Include {{child}} in the \
                     query that loads the {{parent}} rows: one JOIN instead of one query per row.",
                    &vars,
                ),
                fill(
                    r#"
const {{var}} = await {{parent}}.findAll({
  where: …,
  include: [{ model: {{child}} }], // add `as` if the association has an alias
});

// If the association isn't declared yet:
// {{parent}}.belongsTo({{child}}, { foreignKey: '…' });"#,
                    &vars,
                ),
            )
        } else {
            Advice::new(
                fill(
                    "For each {{parent}} row, its {{child}} rows are fetched with their own query (a getter such as \
                     `{{instance}}.get{{children}}()` called in a loop). Load them together with the {{parent}} rows. \
                     `separate: true` fetches all children in one extra query (`WHERE \"{{key}}\" IN (…)`) instead of \
                     a JOIN that repeats every {{parent}} column per child.",
                    &vars,
                ),
                fill(
                    r#"
const {{var}} = await {{parent}}.findAll({
  where: …,
  include: [{ model: {{child}}, separate: true }], // add `as` if the association has an alias
});

// If the association isn't declared yet:
// {{parent}}.hasMany({{child}}, { foreignKey: '{{key}}' });"#,
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
// const x = await {{model}}.findOne({ where: … });
const x = await {{model}}.findOne({ where: … }); // once
for (const item of items) {
  use(item, x);
}"#,
                &[("model", &model_name(facts))],
            ),
        )
    }

    fn looped_writes(&self, kind: StatementKind, facts: &Facts) -> Advice {
        let model = model_name(facts);
        let vars = [("model", model.as_str())];
        match kind {
            StatementKind::Insert => Advice::new(
                fill("Rows are inserted one `{{model}}.create()` at a time. `bulkCreate` sends them in one INSERT.", &vars),
                fill(
                    r#"
await {{model}}.bulkCreate(rows); // rows: array of plain objects

// Upsert instead of insert:
// await {{model}}.bulkCreate(rows, { updateOnDuplicate: ['…'] });"#,
                    &vars,
                ),
            ),
            StatementKind::Update => Advice::new(
                fill(
                    "Rows are updated one at a time (`instance.save()` / `{{model}}.update()` in a loop). Update them \
                     with one statement when they get the same values; otherwise wrap the loop in a transaction so it \
                     commits once.",
                    &vars,
                ),
                fill(
                    r#"
await {{model}}.update(values, { where: { id: ids } });

// Different values per row:
// await sequelize.transaction(async (transaction) => {
//   for (const r of rows) await r.save({ transaction });
// });"#,
                    &vars,
                ),
            ),
            _ => Advice::new(
                "Rows are deleted one at a time. Delete them with one statement.",
                fill("await {{model}}.destroy({ where: { id: ids } });", &vars),
            ),
        }
    }

    fn large_result(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The query loads every matching row and Sequelize builds a model instance for each. Paginate, select only \
             the columns you use, and skip instances when you only read the data.",
            fill(
                r#"
const { rows, count } = await {{model}}.findAndCountAll({
  where: …,
  attributes: ['id', /* only what you use */],
  limit: 50,
  offset: page * 50,
  raw: true, // plain objects instead of model instances
});"#,
                &[("model", &model_name(facts))],
            ),
        )
    }

    fn index(&self, ddl: &str, facts: &Facts) -> Advice {
        let columns = quoted_list(&index_columns(ddl));
        Advice::new(
            "An index lets the database find these rows without scanning the table. Add it with a migration and \
             declare it on the model so `sync()` and new environments get it too.",
            fill(
                r#"
// migrations/XXXXXXXX-add-{{table}}-index.js
module.exports = {
  up: (queryInterface) => queryInterface.addIndex('{{table}}', [{{columns}}]),
  down: (queryInterface) => queryInterface.removeIndex('{{table}}', [{{columns}}]),
};

// and on the model:
// {{model}}.init({ … }, { indexes: [{ fields: [{{columns}}] }] });"#,
                &[("table", facts.table.as_deref().unwrap_or("table")), ("columns", &columns), ("model", &model_name(facts))],
            ),
        )
    }

    fn unique_violation(&self, facts: &Facts) -> Advice {
        Advice::new(
            "Inserts hit a unique constraint: the row already exists. If that's expected, let the database decide \
             instead of failing: `upsert`, or `findOrCreate` inside a transaction.",
            fill(
                r#"
await {{model}}.upsert(values);
// or
const [row, created] = await {{model}}.findOrCreate({ where: { … }, defaults: { … } });"#,
                &[("model", &model_name(facts))],
            ),
        )
    }

    fn chatty_request(&self) -> Advice {
        Advice::text(
            "Most of these statements come from lazy loading inside loops. Fix the N+1 findings for this route first: \
             eager-load associations with `include` on the query that lists the rows.",
        )
    }
}

/// The model name: Sequelize aliases the table as the model in SELECTs.
fn model_name(facts: &Facts) -> String {
    facts.alias.clone().or_else(|| facts.table.as_deref().map(model_from_table)).unwrap_or_else(|| "Model".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::orm::templates::test_support::{covers_every_kind, fix_for};
    use crate::model::FindingKind;

    #[test]
    fn has_many_n_plus_one_uses_include_with_separate() {
        let child = r#"SELECT * FROM "order_items" AS "OrderItem" WHERE "OrderItem"."order_id" = 5;"#;
        let parent = r#"SELECT * FROM "orders" AS "Order" WHERE "Order"."user_id" = 7;"#;
        let fix = fix_for(&Sequelize, FindingKind::NPlusOne, child, Some(parent));
        let code = fix.code.unwrap();
        assert!(code.contains("const orders = await Order.findAll({"), "{code}");
        assert!(code.contains("include: [{ model: OrderItem, separate: true }]"), "{code}");
        assert!(code.contains("Order.hasMany(OrderItem, { foreignKey: 'order_id' })"), "{code}");
        assert!(fix.text.contains("order.getOrderItems()"), "{}", fix.text);
    }

    #[test]
    fn belongs_to_n_plus_one_and_bulk_create() {
        let child = r#"SELECT * FROM "products" AS "Product" WHERE "Product"."id" = 5;"#;
        let parent = r#"SELECT * FROM "order_items" AS "OrderItem" WHERE "OrderItem"."order_id" = 1;"#;
        let code = fix_for(&Sequelize, FindingKind::NPlusOne, child, Some(parent)).code.unwrap();
        assert!(code.contains("include: [{ model: Product }]"), "{code}");
        assert!(code.contains("OrderItem.belongsTo(Product"), "{code}");

        let insert = r#"INSERT INTO "audit_entries" ("id","kind") VALUES (DEFAULT,$1);"#;
        let code = fix_for(&Sequelize, FindingKind::LoopedWrites, insert, None).code.unwrap();
        assert!(code.starts_with("await AuditEntry.bulkCreate(rows)"), "{code}");
    }

    #[test]
    fn every_kind() {
        covers_every_kind(&Sequelize, r#"SELECT "id" FROM "orders" AS "Order" WHERE "Order"."user_id" = 7;"#);
    }
}
