//! MikroORM (v6/v7) fixes, in the EntityManager API. MikroORM names tables after
//! entities in snake_case (`OrderItem` → `order_item`), aliases them `o0`, `o1`…, and
//! keeps a foreign key in the relation property (`order` for `order_id`).

use super::naming::{camel, index_columns, lower_first, model_from_table, plural, quoted_list};
use super::templates::{Advice, Templates, fill};
use super::Facts;
use crate::model::{Orm, StatementKind};

pub struct MikroOrm;

struct Names {
    entity: String,
    parent: String,
    parents: String,
    /// The property the loop filters on: the ManyToOne relation for a foreign key.
    key: String,
}

impl Names {
    fn of(facts: &Facts) -> Self {
        let parent = facts.parent_table.as_deref().map_or_else(|| "Parent".into(), model_from_table);
        Self {
            entity: facts.table.as_deref().map_or_else(|| "Entity".into(), model_from_table),
            parents: lower_first(&plural(&parent)),
            parent,
            key: facts.key.as_deref().map_or_else(|| "parent".into(), property),
        }
    }

    fn vars(&self) -> Vec<(&str, &str)> {
        vec![("entity", &self.entity), ("parent", &self.parent), ("parents", &self.parents), ("key", &self.key)]
    }
}

/// `order_id` → `order` (the relation that owns the column), `created_at` → `createdAt`.
fn property(column: &str) -> String {
    camel(column.strip_suffix("_id").unwrap_or(column))
}

impl Templates for MikroOrm {
    const ORM: Orm = Orm::MikroOrm;

    fn n_plus_one(&self, facts: &Facts) -> Advice {
        let n = Names::of(facts);
        let relation =
            if facts.by_primary_key() { lower_first(&n.entity) } else { lower_first(&plural(&n.entity)) };
        let instance = lower_first(&n.parent);
        let mut vars = n.vars();
        vars.extend([("relation", relation.as_str()), ("instance", instance.as_str())]);
        let text = if facts.by_primary_key() {
            "Each {{parent}} loads its {{entity}} with a separate query (an uninitialized reference loaded per row, \
             e.g. `wrap({{instance}}.{{relation}}).init()` or `em.findOne({{entity}}, id)`). Populate the relation on the \
             query that loads the {{parent}} rows."
        } else {
            "For each {{parent}} row, its {{entity}} collection is loaded with its own query (`{{instance}}.{{relation}}\
             .load()` or `em.find({{entity}}, { {{key}} })` in a loop). Populate the collection on the query that \
             loads the {{parent}} rows: one JOIN, or one more `IN` query with `strategy: 'select-in'`."
        };
        Advice::new(
            fill(text, &vars),
            fill(
                r#"
const {{parents}} = await em.find({{parent}}, { … }, {
  populate: ['{{relation}}'], // the relation property on {{parent}}
});

// Already have the {{parents}}? Populate all of them in one query:
// await em.populate({{parents}}, ['{{relation}}']);"#,
                &vars,
            ),
        )
    }

    fn duplicate_query(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The identical query runs again and again with the same values. Load it once, before the loop, and reuse \
             the result. (The identity map only saves the query for `findOne` by primary key, and only within one \
             EntityManager fork: use one fork per request, via `RequestContext`.)",
            fill(
                r#"
// Before: inside the loop
// const x = await em.findOne({{entity}}, { … });
const x = await em.findOne({{entity}}, { … }); // once
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
                "Rows are flushed one at a time. Persist them all and flush once: the unit of work batches the \
                 INSERTs in one transaction. Without entities, `insertMany` sends one INSERT.",
                fill(
                    r#"
for (const row of rows) {
  em.create({{entity}}, row); // persisted on flush
}
await em.flush(); // once, after the loop

// Plain rows, no entities:
// await em.insertMany({{entity}}, rows);"#,
                    &vars,
                ),
            ),
            StatementKind::Update => Advice::new(
                "Rows are updated one flush at a time. Change the entities and flush once (batched UPDATEs in one \
                 transaction), or update them all with one statement when they get the same values.",
                fill(
                    r#"
await em.nativeUpdate({{entity}}, { id: { $in: ids } }, values);

// Different values per row: change the entities, then flush once.
// for (const e of entities) em.assign(e, valuesFor(e));
// await em.flush();"#,
                    &vars,
                ),
            ),
            _ => Advice::new(
                "Rows are deleted one at a time. Delete them with one statement.",
                fill("await em.nativeDelete({{entity}}, { id: { $in: ids } });", &vars),
            ),
        }
    }

    fn large_result(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The query loads every matching row and MikroORM manages an entity for each. Paginate, load only the \
             fields you use, and get the total from `findAndCount`.",
            fill(
                r#"
const [rows, count] = await em.findAndCount({{entity}}, { … }, {
  fields: ['id' /* only what you use */],
  orderBy: { id: 'asc' },
  limit: 50,
  offset: page * 50,
});"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn index(&self, ddl: &str, facts: &Facts) -> Advice {
        let properties = quoted_list(&index_columns(ddl).iter().map(|c| property(c)).collect::<Vec<_>>());
        let n = Names::of(facts);
        let mut vars = n.vars();
        vars.push(("properties", &properties));
        Advice::new(
            "An index lets the database find these rows without scanning the table. Declare it on the entity and \
             let the migrator create it.",
            fill(
                r#"
@Entity()
@Index({ properties: [{{properties}}] })
export class {{entity}} {
  // …
}

// then: npx mikro-orm migration:create && npx mikro-orm migration:up"#,
                &vars,
            ),
        )
    }

    fn unique_violation(&self, facts: &Facts) -> Advice {
        Advice::new(
            "Inserts hit a unique constraint: the row already exists. If that's expected, let the database decide \
             instead of failing: `upsert` inserts or updates on the unique properties.",
            fill(
                r#"
const entity = await em.upsert({{entity}}, data); // matched on its primary key or a unique property

// Many rows: await em.upsertMany({{entity}}, rows);"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn chatty_request(&self) -> Advice {
        Advice::text(
            "Most of these statements come from references and collections initialized one row at a time inside \
             loops. Fix the N+1 findings for this route first: `populate` the relations on the query that lists the \
             rows.",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::orm::templates::test_support::{covers_every_kind, fix_for};
    use crate::model::FindingKind;

    // As MikroORM 7 writes them (entities Order and OrderItem, PostgreSQL).
    const ORDERS: &str = r#"select "o0".* from "order" as "o0" where "o0"."user_id" = ?"#;
    const ITEMS: &str = r#"select "o0".* from "order_item" as "o0" where "o0"."order_id" = ?"#;
    const PRODUCT: &str = r#"select "p0".* from "product" as "p0" where "p0"."id" = ? limit ?"#;

    #[test]
    fn n_plus_one_populates() {
        let fix = fix_for(&MikroOrm, FindingKind::NPlusOne, ITEMS, Some(ORDERS));
        let code = fix.code.unwrap();
        assert!(code.contains("const orders = await em.find(Order, { … }, {"), "{code}");
        assert!(code.contains("populate: ['orderItems']"), "{code}");
        assert!(fix.text.contains("em.find(OrderItem, { order })"), "{}", fix.text);

        let code = fix_for(&MikroOrm, FindingKind::NPlusOne, PRODUCT, Some(ITEMS)).code.unwrap();
        assert!(code.contains("em.find(OrderItem, { … }, {\n  populate: ['product']"), "{code}");
    }

    #[test]
    fn looped_inserts_flush_once() {
        let insert = r#"insert into "audit_entry" ("kind", "at") values (?, ?) returning "id""#;
        let code = fix_for(&MikroOrm, FindingKind::LoopedWrites, insert, None).code.unwrap();
        assert!(code.contains("em.create(AuditEntry, row)"), "{code}");
        assert!(code.contains("await em.flush(); // once"), "{code}");
    }

    #[test]
    fn properties_from_columns() {
        assert_eq!(property("order_id"), "order");
        assert_eq!(property("created_at"), "createdAt");
    }

    #[test]
    fn every_kind() {
        covers_every_kind(&MikroOrm, ORDERS);
    }
}
