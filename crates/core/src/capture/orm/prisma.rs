//! Prisma Client (v5–v7) fixes. Prisma names tables after models (`"OrderItem"`)
//! unless `@@map` renames them, and fields after columns unless `@map` does; the
//! client exposes each model as `prisma.orderItem`.

use super::naming::{camel, index_columns, lower_first, model_from_table, plural};
use super::templates::{Advice, Templates, fill};
use super::Facts;
use crate::model::{Orm, StatementKind};

pub struct Prisma;

/// What the code calls things, guessed from the SQL.
struct Names {
    model: String,
    /// `prisma.<client>`.
    client: String,
    parent_model: String,
    parent_client: String,
    /// The variable holding the parent rows.
    parents: String,
    /// The foreign key field (`orderId`).
    key: String,
}

impl Names {
    fn of(facts: &Facts) -> Self {
        let model = facts.table.as_deref().map_or_else(|| "Model".into(), model_from_table);
        let parent_model = facts.parent_table.as_deref().map_or_else(|| "Parent".into(), model_from_table);
        Self {
            client: lower_first(&model),
            parent_client: lower_first(&parent_model),
            parents: lower_first(&plural(&parent_model)),
            key: facts.key.as_deref().map_or_else(|| "parentId".into(), camel),
            model,
            parent_model,
        }
    }

    fn vars(&self) -> Vec<(&str, &str)> {
        vec![
            ("model", &self.model),
            ("client", &self.client),
            ("parent", &self.parent_model),
            ("parentClient", &self.parent_client),
            ("parents", &self.parents),
            ("key", &self.key),
        ]
    }
}

impl Templates for Prisma {
    const ORM: Orm = Orm::Prisma;

    fn n_plus_one(&self, facts: &Facts) -> Advice {
        let n = Names::of(facts);
        if facts.by_primary_key() {
            let relation = lower_first(&n.model);
            let mut vars = n.vars();
            vars.push(("relation", &relation));
            Advice::new(
                fill(
                    "Each {{parent}} loads its {{model}} with a separate query (`prisma.{{client}}.findUnique()` per \
                     row). Include the relation in the query that loads the {{parent}} rows: Prisma then fetches every \
                     {{model}} in one more query. (`findUnique` calls started together, with `Promise.all`, are batched \
                     into one query too; awaited one by one in a loop they aren't.)",
                    &vars,
                ),
                fill(
                    r#"
const {{parents}} = await prisma.{{parentClient}}.findMany({
  where: …,
  include: { {{relation}}: true }, // the relation field on {{parent}}
});

// Or one query for all of them:
// const ids = {{parents}}.map((row) => row.{{relation}}Id);
// const all = await prisma.{{client}}.findMany({ where: { id: { in: ids } } });"#,
                    &vars,
                ),
            )
        } else {
            let relation = lower_first(&plural(&n.model));
            let mut vars = n.vars();
            vars.push(("relation", &relation));
            Advice::new(
                fill(
                    "For each {{parent}} row, its {{model}} rows are fetched with their own query \
                     (`prisma.{{client}}.findMany({ where: { {{key}} } })`, or the fluent \
                     `prisma.{{parentClient}}.findUnique(…).{{relation}}()`, in a loop). Include the relation in the \
                     query that lists the {{parent}} rows: Prisma loads the children of all of them together \
                     (`WHERE \"{{key}}\" IN (…)`).",
                    &vars,
                ),
                fill(
                    r#"
const {{parents}} = await prisma.{{parentClient}}.findMany({
  where: …,
  include: { {{relation}}: true }, // the relation field on {{parent}}
});

// Or, when you already have the {{parents}}:
// const children = await prisma.{{client}}.findMany({
//   where: { {{key}}: { in: {{parents}}.map((row) => row.id) } },
// });"#,
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
// const x = await prisma.{{client}}.findFirst({ where: … });
const x = await prisma.{{client}}.findFirst({ where: … }); // once
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
                fill(
                    "Rows are inserted one `prisma.{{client}}.create()` at a time. `createMany` sends them in one \
                     INSERT.",
                    &vars,
                ),
                fill(
                    r#"
await prisma.{{client}}.createMany({ data: rows });

// Need the created rows back (PostgreSQL, CockroachDB, SQLite):
// const created = await prisma.{{client}}.createManyAndReturn({ data: rows });
// Skip rows that already exist (not on SQLite):
// await prisma.{{client}}.createMany({ data: rows, skipDuplicates: true });"#,
                    &vars,
                ),
            ),
            StatementKind::Update => Advice::new(
                fill(
                    "Rows are updated one `prisma.{{client}}.update()` at a time. Update them with one `updateMany` \
                     when they get the same values; otherwise send the updates as one `$transaction`, which commits \
                     once.",
                    &vars,
                ),
                fill(
                    r#"
await prisma.{{client}}.updateMany({
  where: { id: { in: ids } },
  data: values,
});

// Different values per row:
// await prisma.$transaction(
//   rows.map((r) => prisma.{{client}}.update({ where: { id: r.id }, data: r.values })),
// );"#,
                    &vars,
                ),
            ),
            _ => Advice::new(
                "Rows are deleted one at a time. Delete them with one `deleteMany`.",
                fill("await prisma.{{client}}.deleteMany({ where: { id: { in: ids } } });", &vars),
            ),
        }
    }

    fn large_result(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The query loads every matching row, with every field. Paginate with `take` and `skip` (or a cursor), \
             `select` only the fields you use, and count separately when the page needs a total.",
            fill(
                r#"
const [rows, count] = await prisma.$transaction([
  prisma.{{client}}.findMany({
    where,
    select: { id: true /* only what you use */ },
    orderBy: { id: 'asc' },
    take: 50,
    skip: page * 50, // or cursor: { id: lastId }, skip: 1
  }),
  prisma.{{client}}.count({ where }),
]);"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn index(&self, ddl: &str, facts: &Facts) -> Advice {
        let n = Names::of(facts);
        let fields = index_columns(ddl).iter().map(|c| camel(c)).collect::<Vec<_>>().join(", ");
        let migration = format!("add_{}_index", facts.table.as_deref().unwrap_or("table").to_lowercase());
        let mut vars = n.vars();
        vars.extend([("fields", fields.as_str()), ("migration", migration.as_str())]);
        Advice::new(
            "An index lets the database find these rows without scanning the table. Declare it on the model and let \
             Prisma Migrate create it.",
            fill(
                r#"
// schema.prisma
model {{model}} {
  // …
  @@index([{{fields}}])
}

// then: npx prisma migrate dev --name {{migration}}"#,
                &vars,
            ),
        )
    }

    fn unique_violation(&self, facts: &Facts) -> Advice {
        Advice::new(
            "Inserts hit a unique constraint (Prisma error P2002): the row already exists. If that's expected, let \
             the database decide with `upsert` instead of failing.",
            fill(
                r#"
await prisma.{{client}}.upsert({
  where: { … }, // a unique field
  update: { … },
  create: { … },
});"#,
                &Names::of(facts).vars(),
            ),
        )
    }

    fn deadlock(&self) -> Advice {
        Advice::text(
            "Transactions deadlock (Prisma error P2034): two of them lock the same rows in a different order. Update \
             rows in a consistent order (e.g. sorted by id), and retry the `$transaction` when it fails with P2034.",
        )
    }

    fn chatty_request(&self) -> Advice {
        Advice::text(
            "Most of these statements come from relations loaded one row at a time (`findUnique`, `findMany` or the \
             fluent API inside loops). Fix the N+1 findings for this route first: `include` the relations on the \
             query that lists the rows.",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::orm::templates::test_support::{covers_every_kind, fix_for};
    use crate::model::FindingKind;

    // As Prisma's query engine writes them (fields named after the columns).
    const ORDERS: &str = r#"SELECT "public"."Order"."id", "public"."Order"."userId" FROM "public"."Order" WHERE "public"."Order"."userId" = $1 OFFSET $2"#;
    const ITEMS: &str = r#"SELECT "public"."OrderItem"."id", "public"."OrderItem"."orderId", "public"."OrderItem"."quantity" FROM "public"."OrderItem" WHERE "public"."OrderItem"."orderId" = $1 OFFSET $2"#;
    const PRODUCT: &str = r#"SELECT "public"."Product"."id", "public"."Product"."name" FROM "public"."Product" WHERE ("public"."Product"."id" = $1 AND 1=1) LIMIT $2 OFFSET $3"#;

    #[test]
    fn has_many_n_plus_one_includes_the_relation() {
        let fix = fix_for(&Prisma, FindingKind::NPlusOne, ITEMS, Some(ORDERS));
        let code = fix.code.unwrap();
        assert!(code.contains("const orders = await prisma.order.findMany({"), "{code}");
        assert!(code.contains("include: { orderItems: true }"), "{code}");
        assert!(code.contains("where: { orderId: { in: orders.map((row) => row.id) } }"), "{code}");
        assert!(fix.text.contains("prisma.order.findUnique(…).orderItems()"), "{}", fix.text);
    }

    #[test]
    fn belongs_to_n_plus_one_includes_the_parent() {
        let code = fix_for(&Prisma, FindingKind::NPlusOne, PRODUCT, Some(ITEMS)).code.unwrap();
        assert!(code.contains("const orderItems = await prisma.orderItem.findMany({"), "{code}");
        assert!(code.contains("include: { product: true }"), "{code}");
        assert!(code.contains("prisma.product.findMany({ where: { id: { in: ids } } })"), "{code}");
    }

    #[test]
    fn looped_writes_batch() {
        let insert = r#"INSERT INTO "public"."AuditEntry" ("kind","at") VALUES ($1,$2) RETURNING "public"."AuditEntry"."id""#;
        let code = fix_for(&Prisma, FindingKind::LoopedWrites, insert, None).code.unwrap();
        assert!(code.starts_with("await prisma.auditEntry.createMany({ data: rows });"), "{code}");
        let update = r#"UPDATE "public"."Order" SET "status" = $1 WHERE ("public"."Order"."id" = $2 AND 1=1)"#;
        let code = fix_for(&Prisma, FindingKind::LoopedWrites, update, None).code.unwrap();
        assert!(code.contains("prisma.order.updateMany({\n  where: { id: { in: ids } },"), "{code}");
        assert!(code.contains("prisma.$transaction("), "{code}");
    }

    #[test]
    fn every_kind() {
        covers_every_kind(&Prisma, ORDERS);
        let large = fix_for(&Prisma, FindingKind::LargeResult, ORDERS, None).code.unwrap();
        assert!(large.contains("prisma.order.count({ where })"), "{large}");
    }
}
