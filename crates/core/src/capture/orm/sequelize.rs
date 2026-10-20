//! Sequelize (v6/v7) fixes, with code in Sequelize's own API.

use super::{Facts, HintContext, OrmAdvisor, tested_index};
use crate::model::{CaptureFinding, FindingKind, FixHint, Orm, StatementKind};

pub struct Sequelize;

impl OrmAdvisor for Sequelize {
    fn fix(&self, f: &CaptureFinding, ctx: &HintContext) -> Option<FixHint> {
        let facts = Facts::of(ctx);
        let index = tested_index(ctx);
        let (text, code) = match f.kind {
            FindingKind::NPlusOne => n_plus_one(&facts),
            FindingKind::DuplicateQuery => (
                "The identical query runs again and again with the same values, typically inside a loop or once \
                 per item in a request. Load it once, before the loop, and reuse the result."
                    .into(),
                Some(format!(
                    "// Before: inside the loop\n// const x = await {model}.findOne({{ where: … }});\n\
                     const x = await {model}.findOne({{ where: … }}); // once\nfor (const item of items) {{\n  use(item, x);\n}}",
                    model = model_name(&facts)
                )),
            ),
            FindingKind::LoopedWrites => looped_writes(ctx.stat.kind, &facts),
            FindingKind::LargeResult => (
                "The query loads every matching row and Sequelize builds a model instance for each. Paginate, select \
                 only the columns you use, and skip instances when you only read the data."
                    .into(),
                Some(format!(
                    "const {{ rows, count }} = await {model}.findAndCountAll({{\n  where: …,\n  attributes: ['id', /* only what you use */],\n  \
                     limit: 50,\n  offset: page * 50,\n  raw: true, // plain objects instead of model instances\n}});",
                    model = model_name(&facts)
                )),
            ),
            FindingKind::SlowQuery | FindingKind::PlanIssue => {
                let index = index.as_ref()?;
                (
                    "An index lets the database find these rows without scanning the table. Add it with a migration \
                     and declare it on the model so `sync()` and new environments get it too."
                        .into(),
                    Some(index_code(index, &facts)),
                )
            }
            FindingKind::QueryErrors => query_error(f)?,
            FindingKind::ChattyRequest => (
                "Most of these statements come from lazy loading inside loops. Fix the N+1 findings for this route \
                 first: eager-load associations with `include` on the query that lists the rows."
                    .into(),
                None,
            ),
        };
        Some(FixHint { orm: Some(Orm::Sequelize), text, code, ddl: index })
    }
}

fn n_plus_one(facts: &Facts) -> (String, Option<String>) {
    let child = model_name(facts);
    let parent = facts.parent_alias.clone().or_else(|| facts.parent_table.as_deref().map(model_from_table));
    let parent = parent.as_deref().unwrap_or("Parent");
    let var = lower_first(&plural(parent));
    let key = facts.key.as_deref().unwrap_or("foreignKey");
    let instance = lower_first(parent);
    if facts.by_primary_key() {
        (
            format!(
                "Each {parent} loads its {child} with a separate query (a getter such as `{getter}()`, or \
                 `{child}.findByPk`, called per row). Include {child} in the query that loads the {parent} rows: \
                 one JOIN instead of one query per row.",
                getter = format_args!("{instance}.get{child}")
            ),
            Some(format!(
                "const {var} = await {parent}.findAll({{\n  where: …,\n  include: [{{ model: {child} }}], // add `as` if the association has an alias\n}});\n\n\
                 // If the association isn't declared yet:\n// {parent}.belongsTo({child}, {{ foreignKey: '…' }});"
            )),
        )
    } else {
        (
            format!(
                "For each {parent} row, its {child} rows are fetched with their own query (a getter such as \
                 `{getter}()` called in a loop). Load them together with the {parent} rows. `separate: true` fetches all \
                 children in one extra query (`WHERE \"{key}\" IN (…)`) instead of a JOIN that repeats every {parent} \
                 column per child.",
                getter = format_args!("{instance}.get{}", plural(&child))
            ),
            Some(format!(
                "const {var} = await {parent}.findAll({{\n  where: …,\n  include: [{{ model: {child}, separate: true }}], // add `as` if the association has an alias\n}});\n\n\
                 // If the association isn't declared yet:\n// {parent}.hasMany({child}, {{ foreignKey: '{key}' }});"
            )),
        )
    }
}

fn looped_writes(kind: StatementKind, facts: &Facts) -> (String, Option<String>) {
    let model = model_name(facts);
    match kind {
        StatementKind::Insert => (
            format!("Rows are inserted one `{model}.create()` at a time. `bulkCreate` sends them in one INSERT."),
            Some(format!(
                "await {model}.bulkCreate(rows); // rows: array of plain objects\n\n\
                 // Upsert instead of insert:\n// await {model}.bulkCreate(rows, {{ updateOnDuplicate: ['…'] }});"
            )),
        ),
        StatementKind::Update => (
            format!(
                "Rows are updated one at a time (`instance.save()` / `{model}.update()` in a loop). Update them with \
                 one statement when they get the same values; otherwise wrap the loop in a transaction so it commits once."
            ),
            Some(format!(
                "await {model}.update(values, {{ where: {{ id: ids }} }});\n\n\
                 // Different values per row:\n// await sequelize.transaction(async (transaction) => {{\n\
                 //   for (const r of rows) await r.save({{ transaction }});\n// }});"
            )),
        ),
        _ => (
            "Rows are deleted one at a time. Delete them with one statement.".into(),
            Some(format!("await {model}.destroy({{ where: {{ id: ids }} }});")),
        ),
    }
}

fn index_code(ddl: &str, facts: &Facts) -> String {
    let table = facts.table.as_deref().unwrap_or("table");
    let columns = ddl
        .rsplit_once('(')
        .map(|(_, cols)| cols.trim_end_matches(')').split(',').map(|c| format!("'{}'", c.trim().trim_matches('"'))).collect::<Vec<_>>())
        .unwrap_or_default()
        .join(", ");
    format!(
        "// migrations/XXXXXXXX-add-{table}-index.js\nmodule.exports = {{\n  \
         up: (queryInterface) => queryInterface.addIndex('{table}', [{columns}]),\n  \
         down: (queryInterface) => queryInterface.removeIndex('{table}', [{columns}]),\n}};\n\n\
         // and on the model:\n// {model}.init({{ … }}, {{ indexes: [{{ fields: [{columns}] }}] }});",
        model = model_name(facts)
    )
}

fn query_error(f: &CaptureFinding) -> Option<(String, Option<String>)> {
    if f.detail.contains("(23505)") {
        return Some((
            "Inserts hit a unique constraint: the row already exists. If that's expected, let the database decide \
             instead of failing: `upsert`, or `findOrCreate` inside a transaction."
                .into(),
            Some("await Model.upsert(values);\n// or\nconst [row, created] = await Model.findOrCreate({ where: { … }, defaults: { … } });".into()),
        ));
    }
    if f.detail.contains("(40P01)") {
        return Some((
            "Transactions deadlock: two of them lock the same rows in a different order. Update rows in a \
             consistent order (e.g. sorted by id), and retry the transaction on 40P01."
                .into(),
            None,
        ));
    }
    None
}

/// The model name: Sequelize aliases the table as the model in SELECTs.
fn model_name(facts: &Facts) -> String {
    facts.alias.clone().or_else(|| facts.table.as_deref().map(model_from_table)).unwrap_or_else(|| "Model".into())
}

/// `order_items` → `OrderItem` (Sequelize's default naming in reverse).
fn model_from_table(table: &str) -> String {
    let singular = if let Some(stem) = table.strip_suffix("ies") {
        format!("{stem}y")
    } else if table.ends_with("ses") || table.ends_with("xes") {
        table[..table.len() - 2].to_string()
    } else {
        table.strip_suffix('s').unwrap_or(table).to_string()
    };
    singular
        .split('_')
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect()
}

fn plural(name: &str) -> String {
    if let Some(stem) = name.strip_suffix('y') {
        format!("{stem}ies")
    } else if name.ends_with('s') {
        format!("{name}es")
    } else {
        format!("{name}s")
    }
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_lowercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FingerprintStat, SuggestionSeverity};

    fn stat(sql: &str, kind: StatementKind) -> FingerprintStat {
        FingerprintStat {
            fingerprint: "fp".into(),
            normalized: String::new(),
            sample_sql: sql.into(),
            sample_params: vec![],
            kind,
            tables: vec![],
            calls: 1,
            total_ms: 1.0,
            mean_ms: 1.0,
            p50_ms: 1.0,
            p95_ms: 1.0,
            max_ms: 1.0,
            rows: 1.0,
            max_rows: 1.0,
            bytes: 1.0,
            errors: 0,
            share: 1.0,
            origins: vec![],
        }
    }

    fn finding(kind: FindingKind) -> CaptureFinding {
        CaptureFinding {
            id: String::new(),
            kind,
            severity: SuggestionSeverity::High,
            title: String::new(),
            detail: String::new(),
            fingerprint: "fp".into(),
            parent_fingerprint: None,
            impact_ms: 0.0,
            occurrences: 1,
            origins: vec![],
            fix: None,
        }
    }

    #[test]
    fn has_many_n_plus_one_uses_include_with_separate() {
        let child = stat(r#"SELECT * FROM "order_items" AS "OrderItem" WHERE "OrderItem"."order_id" = 5;"#, StatementKind::Select);
        let parent = stat(r#"SELECT * FROM "orders" AS "Order" WHERE "Order"."user_id" = 7;"#, StatementKind::Select);
        let ctx = HintContext { stat: &child, parent: Some(&parent), plan: None };
        let fix = Sequelize.fix(&finding(FindingKind::NPlusOne), &ctx).unwrap();
        let code = fix.code.unwrap();
        assert!(code.contains("const orders = await Order.findAll({"), "{code}");
        assert!(code.contains("include: [{ model: OrderItem, separate: true }]"), "{code}");
        assert!(code.contains("Order.hasMany(OrderItem, { foreignKey: 'order_id' })"), "{code}");
        assert!(fix.text.contains("order.getOrderItems()"), "{}", fix.text);
    }

    #[test]
    fn belongs_to_n_plus_one_and_bulk_create() {
        let child = stat(r#"SELECT * FROM "products" AS "Product" WHERE "Product"."id" = 5;"#, StatementKind::Select);
        let parent = stat(r#"SELECT * FROM "order_items" AS "OrderItem" WHERE "OrderItem"."order_id" = 1;"#, StatementKind::Select);
        let ctx = HintContext { stat: &child, parent: Some(&parent), plan: None };
        let code = Sequelize.fix(&finding(FindingKind::NPlusOne), &ctx).unwrap().code.unwrap();
        assert!(code.contains("include: [{ model: Product }]"), "{code}");
        assert!(code.contains("OrderItem.belongsTo(Product"), "{code}");

        let insert = stat(r#"INSERT INTO "audit_entries" ("id","kind") VALUES (DEFAULT,$1);"#, StatementKind::Insert);
        let ctx = HintContext { stat: &insert, parent: None, plan: None };
        let code = Sequelize.fix(&finding(FindingKind::LoopedWrites), &ctx).unwrap().code.unwrap();
        assert!(code.starts_with("await AuditEntry.bulkCreate(rows)"), "{code}");
    }

    #[test]
    fn naming() {
        assert_eq!(model_from_table("order_items"), "OrderItem");
        assert_eq!(model_from_table("categories"), "Category");
        assert_eq!(model_from_table("addresses"), "Address");
        assert_eq!(plural("Category"), "Categories");
    }
}
