//! Fixes for the MongoDB driver used directly (`db.collection(…)`), with code in its API.
//! The statement's target is the collection (`db.order_items.find(…)`).

use super::Facts;
use super::naming::{camel, quoted_list, singular};
use super::templates::{Advice, Templates, fill};
use crate::model::{Orm, StatementKind};

pub struct MongoDb;

fn collection(facts: &Facts) -> String {
    facts.table.clone().unwrap_or_else(|| "items".into())
}

/// `order_items` → `orderItems`, a variable for the collection's documents.
fn var(collection: &str) -> String {
    camel(&collection.replace(['.', '-'], "_"))
}

impl Templates for MongoDb {
    const ORM: Orm = Orm::MongoDb;

    fn n_plus_one(&self, facts: &Facts) -> Advice {
        let child = collection(facts);
        let parent = facts.parent_table.clone().unwrap_or_else(|| "parents".into());
        // A reference: each parent holds the child's _id (`customerId`); else the child holds the parent's.
        let (key, local, foreign, ids) = if facts.by_primary_key() {
            let reference = format!("{}Id", var(&singular(&child)));
            ("_id".to_string(), reference.clone(), "_id".to_string(), format!("p.{reference}"))
        } else {
            let key = facts.key.clone().unwrap_or_else(|| "parentId".into());
            (key.clone(), "_id".to_string(), key, "p._id".to_string())
        };
        let vars = [
            ("child", child.as_str()),
            ("parent", parent.as_str()),
            ("children", &var(&child)),
            ("parents", &var(&parent)),
            ("key", key.as_str()),
            ("local", local.as_str()),
            ("foreign", foreign.as_str()),
            ("ids", ids.as_str()),
        ];
        Advice::new(
            fill(
                "For each document of {{parent}}, documents of {{child}} are fetched with their own query (by `{{key}}`).                  Fetch them for all of them at once with `$in`, or join them in the same query with an aggregation                  `$lookup`.",
                &vars,
            ),
            fill(
                r#"
const {{children}} = await db.collection('{{child}}')
  .find({ {{key}}: { $in: {{parents}}.map((p) => {{ids}}) } })
  .toArray();

// Or in one query:
// await db.collection('{{parent}}').aggregate([
//   { $match: … },
//   { $lookup: { from: '{{child}}', localField: '{{local}}', foreignField: '{{foreign}}', as: '{{children}}' } },
// ]).toArray();"#,
                &vars,
            ),
        )
    }

    fn duplicate_query(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The identical query runs again and again with the same values, typically inside a loop. Run it once, \
             before the loop, and reuse the result.",
            fill(
                r#"
const doc = await db.collection('{{collection}}').findOne(…); // once, before the loop
for (const item of items) {
  use(item, doc);
}"#,
                &[("collection", &collection(facts))],
            ),
        )
    }

    fn looped_writes(&self, kind: StatementKind, facts: &Facts) -> Advice {
        let c = collection(facts);
        let vars = [("collection", c.as_str()), ("docs", &var(&c))];
        match kind {
            StatementKind::Insert => Advice::new(
                "Documents are inserted one `insertOne` at a time. `insertMany` sends them in one command.",
                fill(
                    r#"
await db.collection('{{collection}}').insertMany({{docs}}, { ordered: false });"#,
                    &vars,
                ),
            ),
            StatementKind::Update => Advice::new(
                "Documents are updated one command at a time. With the same change for all, `updateMany` does it at \
                 once; with a change each, `bulkWrite` sends them together.",
                fill(
                    r#"
await db.collection('{{collection}}').updateMany({ _id: { $in: ids } }, { $set: changes });

// A different change per document:
await db.collection('{{collection}}').bulkWrite(
  {{docs}}.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: d.changes } } })),
);"#,
                    &vars,
                ),
            ),
            _ => Advice::new(
                "Documents are deleted one at a time. `deleteMany` with `$in` removes them in one command.",
                fill(
                    r#"
await db.collection('{{collection}}').deleteMany({ _id: { $in: ids } });"#,
                    &vars,
                ),
            ),
        }
    }

    fn large_result(&self, facts: &Facts) -> Advice {
        Advice::new(
            "Thousands of documents come back at once. Page through them by `_id` (fast on every page), project only \
             the fields used, and iterate the cursor instead of `toArray()` when processing them all.",
            fill(
                r#"
const page = await db.collection('{{collection}}')
  .find({ ...filter, ...(after ? { _id: { $gt: after } } : {}) }, { projection: { … } })
  .sort({ _id: 1 })
  .limit(100)
  .toArray();

// Every document, without holding them all in memory:
// for await (const doc of db.collection('{{collection}}').find(filter)) { … }"#,
                &[("collection", &collection(facts))],
            ),
        )
    }

    fn index(&self, _ddl: &str, facts: &Facts) -> Advice {
        self.untested_index(facts).unwrap_or_else(|| Advice::text("Add an index on the fields this query filters on."))
    }

    fn untested_index(&self, facts: &Facts) -> Option<Advice> {
        if facts.fields.is_empty() {
            return None;
        }
        let spec = facts.fields.iter().map(|f| format!("'{f}': 1")).collect::<Vec<_>>().join(", ");
        let c = collection(facts);
        let vars = [("collection", c.as_str()), ("spec", &spec), ("fields", &quoted_list(&facts.fields))];
        Some(Advice::new(
            fill(
                "The query is slow, and filters on {{fields}}. Without an index on them MongoDB scans the whole \
                 collection. Create one (equality fields first, then sort and range fields), and check with \
                 `explain()` that the query uses it.",
                &vars,
            ),
            fill(
                r#"
await db.collection('{{collection}}').createIndex({ {{spec}} });

// Check: await db.collection('{{collection}}').find(filter).explain('executionStats');"#,
                &vars,
            ),
        ))
    }

    fn unique_violation(&self, facts: &Facts) -> Advice {
        Advice::new(
            "Inserts hit a unique index (E11000 duplicate key): the document already exists. Update it in place, or \
             insert only when it's missing, with an upsert.",
            fill(
                r#"
await db.collection('{{collection}}').updateOne(
  { email }, // the unique field(s)
  { $set: changes, $setOnInsert: { createdAt: new Date() } },
  { upsert: true },
);"#,
                &[("collection", &collection(facts))],
            ),
        )
    }

    fn chatty_request(&self) -> Advice {
        Advice::text(
            "One request runs dozens of MongoDB commands. Fetch related documents with one `$in` query per \
             collection (or an aggregation `$lookup`) instead of one by one, and batch writes with `insertMany` / \
             `bulkWrite`.",
        )
    }

    fn deadlock(&self) -> Advice {
        Advice::new(
            "Transactions conflict on the same documents (WriteConflict). Run them with `session.withTransaction()`, \
             which retries a transaction that fails with a transient error, and keep transactions short.",
            r#"
await client.withSession((session) =>
  session.withTransaction(async () => {
    // every operation with { session }
  }),
);"#
                .trim_start(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::orm::templates::test_support::{covers_every_kind, fix_for};
    use crate::model::FindingKind;

    #[test]
    fn n_plus_one_uses_in_or_lookup() {
        let fix = fix_for(&MongoDb, FindingKind::NPlusOne, r#"db.order_items.find({"orderId": ?})"#, Some(r#"db.orders.find({"userId": ?})"#));
        let code = fix.code.unwrap();
        assert!(code.contains("const orderItems = await db.collection('order_items')"), "{code}");
        assert!(code.contains(".find({ orderId: { $in: orders.map((p) => p._id) } })"), "{code}");
        assert!(code.contains("$lookup: { from: 'order_items', localField: '_id', foreignField: 'orderId', as: 'orderItems' }"), "{code}");
    }

    #[test]
    fn reference_n_plus_one_looks_up_by_id() {
        let code = fix_for(&MongoDb, FindingKind::NPlusOne, r#"db.customers.find({"_id": ?}).limit(?)"#, Some(r#"db.orders.find({})"#)).code.unwrap();
        assert!(code.contains(".find({ _id: { $in: orders.map((p) => p.customerId) } })"), "{code}");
        assert!(code.contains("localField: 'customerId', foreignField: '_id'"), "{code}");
    }

    #[test]
    fn every_kind() {
        covers_every_kind(&MongoDb, r#"db.orders.find({"userId": ?})"#);
        let slow = fix_for(&MongoDb, FindingKind::SlowQuery, r#"db.orders.find({"userId": ?, "status": ?})"#, None);
        assert!(slow.code.unwrap().contains("createIndex({ 'userId': 1, 'status': 1 })"));
    }
}
