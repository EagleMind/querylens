//! TypeORM (0.3 and 1.x) fixes, in the repository / find-options API. TypeORM aliases
//! the table as the entity in `find` (`FROM "order_item" "OrderItem"`), and names
//! tables after entities in snake_case by default.

use super::naming::{camel, index_columns, lower_first, model_from_table, pascal, plural, quoted_list};
use super::templates::{Advice, Templates, fill};
use super::Facts;
use crate::model::{Orm, StatementKind};

pub struct TypeOrm;

struct Names {
    entity: String,
    /// `orderItemRepository`.
    repo: String,
    parent: String,
    parent_repo: String,
    parents: String,
    key: String,
}

impl Names {
    fn of(facts: &Facts) -> Self {
        let entity = entity_name(facts.alias.as_deref(), facts.table.as_deref());
        let parent = entity_name(facts.parent_alias.as_deref(), facts.parent_table.as_deref());
        Self {
            repo: format!("{}Repository", lower_first(&entity)),
            parent_repo: format!("{}Repository", lower_first(&parent)),
            parents: lower_first(&plural(&parent)),
            key: facts.key.as_deref().map_or_else(|| "parentId".into(), camel),
            entity,
            parent,
        }
    }

    fn vars(&self) -> Vec<(&str, &str)> {
        vec![
            ("entity", &self.entity),
            ("repo", &self.repo),
            ("parent", &self.parent),
            ("parentRepo", &self.parent_repo),
            ("parents", &self.parents),
            ("key", &self.key),
        ]
    }
}

/// `find` aliases the table as the entity; query builders use whatever alias the
/// code chose (`"order"`), so a lowercase alias says nothing about the class name.
fn entity_name(alias: Option<&str>, table: Option<&str>) -> String {
    match (alias, table) {
        (Some(a), _) if a.starts_with(char::is_uppercase) && !a.contains("__") => pascal(a),
        (_, Some(t)) => model_from_table(t),
        _ => "Entity".into(),
    }
}

impl Templates for TypeOrm {
    const ORM: Orm = Orm::TypeOrm;

    fn n_plus_one(&self, facts: &Facts) -> Advice {
        let n = Names::of(facts);
        if facts.by_primary_key() {
            let relation = lower_first(&n.entity);
            let mut vars = n.vars();
            vars.push(("relation", &relation));
            Advice::new(
                fill(
                    "Each {{parent}} loads its {{entity}} with a separate query (a lazy relation, or \
                     `{{repo}}.findOneBy({ id })` per row). Load the relation with the {{parent}} rows: `relations` on \
                     `find`, or `leftJoinAndSelect` on the query builder: one JOIN instead of one query per row.",
                    &vars,
                ),
                fill(
                    r#"
const {{parents}} = await {{parentRepo}}.find({
  where: { … },
  relations: { {{relation}}: true }, // the @ManyToOne property on {{parent}}
});

// Or one query for all of them:
// const all = await {{repo}}.findBy({ id: In(ids) });"#,
                    &vars,
                ),
            )
        } else {
            let relation = lower_first(&plural(&n.entity));
            let alias = lower_first(&n.parent);
            let mut vars = n.vars();
            vars.extend([("relation", relation.as_str()), ("alias", alias.as_str())]);
            Advice::new(
                fill(
                    "For each {{parent}} row, its {{entity}} rows are fetched with their own query (a lazy relation \
                     awaited per row, or `{{repo}}.findBy({ {{key}} })` in a loop). Load the relation with the \
                     {{parent}} rows. `relationLoadStrategy: 'query'` fetches all children in one extra query instead \
                     of a JOIN that repeats every {{parent}} column per child.",
                    &vars,
                ),
                fill(
                    r#"
const {{parents}} = await {{parentRepo}}.find({
  where: { … },
  relations: { {{relation}}: true }, // the @OneToMany property on {{parent}}
  relationLoadStrategy: 'query',
});

// With the query builder:
// const {{parents}} = await {{parentRepo}}
//   .createQueryBuilder('{{alias}}')
//   .leftJoinAndSelect('{{alias}}.{{relation}}', 'child')
//   .where(…)
//   .getMany();"#,
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
// const x = await {{repo}}.findOneBy({ … });
const x = await {{repo}}.findOneBy({ … }); // once
for (const item of items) {
  use(item, x);
}

// Shared across requests? TypeORM's query cache (enable `cache` on the DataSource):
// await {{repo}}.find({ where: { … }, cache: 60_000 });"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn looped_writes(&self, kind: StatementKind, facts: &Facts) -> Advice {
        let n = Names::of(facts);
        let vars = n.vars();
        match kind {
            StatementKind::Insert => Advice::new(
                fill(
                    "Rows are saved one `{{repo}}.save()` at a time, each with its own INSERT. Pass them all at once: \
                     `insert([...])` sends one multi-row INSERT; `save([...])` batches them in one transaction and \
                     still runs listeners and cascades.",
                    &vars,
                ),
                fill(
                    r#"
await {{repo}}.insert(rows); // rows: array of plain objects

// With entity listeners and cascades:
// await {{repo}}.save(entities, { chunk: 500 });
// Upsert instead of insert:
// await {{repo}}.upsert(rows, ['…']); // the conflict columns"#,
                    &vars,
                ),
            ),
            StatementKind::Update => Advice::new(
                fill(
                    "Rows are updated one at a time (`save()` / `{{repo}}.update()` in a loop). Update them with one \
                     statement when they get the same values; otherwise run the loop in one transaction so it commits \
                     once.",
                    &vars,
                ),
                fill(
                    r#"
await {{repo}}.update({ id: In(ids) }, values);

// Different values per row:
// await dataSource.transaction(async (manager) => {
//   for (const r of rows) await manager.update({{entity}}, r.id, r.values);
// });"#,
                    &vars,
                ),
            ),
            _ => Advice::new(
                "Rows are deleted one at a time. Delete them with one statement.",
                fill("await {{repo}}.delete({ id: In(ids) });", &vars),
            ),
        }
    }

    fn large_result(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The query loads every matching row and TypeORM builds an entity for each. Paginate with `take` and \
             `skip`, select only the columns you use, and read raw rows (`getRawMany()`) when you don't need \
             entities.",
            fill(
                r#"
const [rows, count] = await {{repo}}.findAndCount({
  where: { … },
  select: { id: true /* only what you use */ },
  order: { id: 'ASC' },
  take: 50,
  skip: page * 50,
});"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn index(&self, ddl: &str, facts: &Facts) -> Advice {
        let n = Names::of(facts);
        let properties = quoted_list(&index_columns(ddl).iter().map(|c| camel(c)).collect::<Vec<_>>());
        let mut vars = n.vars();
        vars.extend([("properties", properties.as_str()), ("table", facts.table.as_deref().unwrap_or("table"))]);
        Advice::new(
            "An index lets the database find these rows without scanning the table. Declare it on the entity and \
             generate the migration from it.",
            fill(
                r#"
@Entity('{{table}}')
@Index([{{properties}}])
export class {{entity}} {
  // …
}

// then: npx typeorm migration:generate src/migrations/Add{{entity}}Index -d src/data-source.ts"#,
                &vars,
            ),
        )
    }

    fn unique_violation(&self, facts: &Facts) -> Advice {
        Advice::new(
            "Inserts hit a unique constraint: the row already exists. If that's expected, let the database decide \
             instead of failing: `upsert` on the unique columns, or `orIgnore()` to skip rows that exist.",
            fill(
                r#"
await {{repo}}.upsert(values, ['…']); // the unique columns

// Or skip rows that already exist:
// await {{repo}}.createQueryBuilder().insert().values(rows).orIgnore().execute();"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn chatty_request(&self) -> Advice {
        Advice::text(
            "Most of these statements come from relations loaded one row at a time (lazy relations, or `find` inside \
             loops). Fix the N+1 findings for this route first: load relations with `relations` (or \
             `leftJoinAndSelect`) on the query that lists the rows.",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::orm::templates::test_support::{covers_every_kind, fix_for};
    use crate::model::FindingKind;

    // As TypeORM 1.1 writes them for `find` (entities Order and OrderItem).
    const ORDERS: &str = r#"SELECT "Order"."id" AS "Order_id", "Order"."status" AS "Order_status", "Order"."userId" AS "Order_userId" FROM "order" "Order" WHERE (("Order"."userId" = $1))"#;
    const ITEMS: &str = r#"SELECT "OrderItem"."id" AS "OrderItem_id", "OrderItem"."quantity" AS "OrderItem_quantity", "OrderItem"."orderId" AS "OrderItem_orderId" FROM "order_item" "OrderItem" WHERE (("OrderItem"."orderId" = $1))"#;
    const PRODUCT: &str = r#"SELECT "Product"."id" AS "Product_id", "Product"."name" AS "Product_name" FROM "product" "Product" WHERE (("Product"."id" = $1)) LIMIT 1"#;

    #[test]
    fn has_many_n_plus_one_loads_relations() {
        let fix = fix_for(&TypeOrm, FindingKind::NPlusOne, ITEMS, Some(ORDERS));
        let code = fix.code.unwrap();
        assert!(code.contains("const orders = await orderRepository.find({"), "{code}");
        assert!(code.contains("relations: { orderItems: true }"), "{code}");
        assert!(code.contains(".leftJoinAndSelect('order.orderItems', 'child')"), "{code}");
        assert!(fix.text.contains("orderItemRepository.findBy({ orderId })"), "{}", fix.text);
    }

    #[test]
    fn belongs_to_n_plus_one_and_batched_writes() {
        let code = fix_for(&TypeOrm, FindingKind::NPlusOne, PRODUCT, Some(ITEMS)).code.unwrap();
        assert!(code.contains("const orderItems = await orderItemRepository.find({"), "{code}");
        assert!(code.contains("relations: { product: true }"), "{code}");
        assert!(code.contains("productRepository.findBy({ id: In(ids) })"), "{code}");

        let insert = r#"INSERT INTO "audit_entry"("id", "kind", "at") VALUES (DEFAULT, $1, $2) RETURNING "id""#;
        let code = fix_for(&TypeOrm, FindingKind::LoopedWrites, insert, None).code.unwrap();
        assert!(code.starts_with("await auditEntryRepository.insert(rows);"), "{code}");
        let delete = r#"DELETE FROM "order" WHERE "id" = $1"#;
        let code = fix_for(&TypeOrm, FindingKind::LoopedWrites, delete, None).code.unwrap();
        assert_eq!(code, "await orderRepository.delete({ id: In(ids) });");
    }

    #[test]
    fn query_builder_aliases_are_not_entity_names() {
        assert_eq!(entity_name(Some("order"), Some("order")), "Order");
        assert_eq!(entity_name(Some("Order__Order_items"), Some("order_item")), "OrderItem");
        assert_eq!(entity_name(Some("OrderItem"), Some("order_items")), "OrderItem");
    }

    #[test]
    fn every_kind() {
        covers_every_kind(&TypeOrm, ORDERS);
        let large = fix_for(&TypeOrm, FindingKind::LargeResult, ORDERS, None).code.unwrap();
        assert!(large.contains("orderRepository.findAndCount({"), "{large}");
    }
}
