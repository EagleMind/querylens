//! Mongoose fixes, with code in Mongoose's API. The statement's target is the model
//! (`OrderItem.find(…)`), and the key a loop looks documents up by is its filter field.

use super::Facts;
use super::naming::{lower_first, plural, quoted_list};
use super::templates::{Advice, Templates, fill};
use crate::model::{Orm, StatementKind};

pub struct Mongoose;

fn model(facts: &Facts) -> String {
    facts.table.clone().unwrap_or_else(|| "Model".into())
}

fn parent(facts: &Facts) -> String {
    facts.parent_table.clone().unwrap_or_else(|| "Parent".into())
}

impl Templates for Mongoose {
    const ORM: Orm = Orm::Mongoose;

    fn n_plus_one(&self, facts: &Facts) -> Advice {
        let child = model(facts);
        let parent = parent(facts);
        let vars = [
            ("child", child.as_str()),
            ("parent", parent.as_str()),
            ("parents", &lower_first(&plural(&parent))),
            ("children", &lower_first(&plural(&child))),
            ("ref", &lower_first(&child)),
            ("key", facts.key.as_deref().unwrap_or("parent")),
            ("schema", &format!("{}Schema", lower_first(&parent))),
        ];
        if facts.by_primary_key() {
            Advice::new(
                fill(
                    "Each {{parent}} loads the {{child}} it references with its own query (`{{child}}.findById()` per \
                     document). Populate the reference in the query that loads the {{parent}} documents: Mongoose then \
                     fetches every {{child}} in one `$in` query.",
                    &vars,
                ),
                fill(
                    r#"
const {{parents}} = await {{parent}}.find(…).populate('{{ref}}'); // the {{parent}} field that references {{child}}"#,
                    &vars,
                ),
            )
        } else {
            Advice::new(
                fill(
                    "For each {{parent}}, its {{child}} documents are fetched with their own query (by `{{key}}`). Fetch \
                     them for every {{parent}} at once with `$in` and group them, or declare a virtual and populate it.",
                    &vars,
                ),
                fill(
                    r#"
const {{parents}} = await {{parent}}.find(…).lean();
const {{children}} = await {{child}}.find({ {{key}}: { $in: {{parents}}.map((p) => p._id) } }).lean();
const byParent = new Map();
for (const c of {{children}}) byParent.set(String(c.{{key}}), [...(byParent.get(String(c.{{key}})) ?? []), c]);
for (const p of {{parents}}) p.{{children}} = byParent.get(String(p._id)) ?? [];

// Or populate a virtual (one $in query too):
// {{schema}}.virtual('{{children}}', { ref: '{{child}}', localField: '_id', foreignField: '{{key}}' });
// const {{parents}} = await {{parent}}.find(…).populate('{{children}}');"#,
                    &vars,
                ),
            )
        }
    }

    fn duplicate_query(&self, facts: &Facts) -> Advice {
        Advice::new(
            "The identical query runs again and again with the same values, typically inside a loop. Run it once, \
             before the loop, and reuse the result.",
            fill(
                r#"
const doc = await {{model}}.findOne(…).lean(); // once, before the loop
for (const item of items) {
  use(item, doc);
}"#,
                &[("model", &model(facts))],
            ),
        )
    }

    fn looped_writes(&self, kind: StatementKind, facts: &Facts) -> Advice {
        let model = model(facts);
        let vars = [("model", model.as_str()), ("docs", &lower_first(&plural(&model)))];
        match kind {
            StatementKind::Insert => Advice::new(
                fill("Documents are created one at a time (`{{model}}.create()` or `save()` in a loop). `insertMany` sends them together.", &vars),
                fill(
                    r#"
await {{model}}.insertMany({{docs}}); // { ordered: false } keeps going past duplicates"#,
                    &vars,
                ),
            ),
            StatementKind::Update => Advice::new(
                fill(
                    "Documents are updated one at a time (`save()` or `{{model}}.updateOne()` in a loop). With the same \
                     change for all, `updateMany` does it in one command; with a change each, `bulkWrite` sends them \
                     together.",
                    &vars,
                ),
                fill(
                    r#"
await {{model}}.updateMany({ _id: { $in: ids } }, { $set: changes });

// A different change per document:
await {{model}}.bulkWrite(
  {{docs}}.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: d.changes } } })),
);"#,
                    &vars,
                ),
            ),
            _ => Advice::new(
                fill("Documents are deleted one at a time. `deleteMany` with `$in` removes them in one command.", &vars),
                fill(
                    r#"
await {{model}}.deleteMany({ _id: { $in: ids } });"#,
                    &vars,
                ),
            ),
        }
    }

    fn large_result(&self, facts: &Facts) -> Advice {
        Advice::new(
            "Thousands of documents come back at once, each hydrated into a Mongoose document. Page through them \
             (by `_id`, which stays fast on later pages), select only the fields used, and use `lean()` when the \
             documents are only read. To process them all, stream them with a cursor.",
            fill(
                r#"
const page = await {{model}}.find({ ...filter, ...(after ? { _id: { $gt: after } } : {}) })
  .sort({ _id: 1 })
  .limit(100)
  .select('…') // the fields the code uses
  .lean();

// Every document, without holding them all in memory:
// for await (const doc of {{model}}.find(filter).lean().cursor()) { … }"#,
                &[("model", &model(facts))],
            ),
        )
    }

    fn index(&self, _ddl: &str, facts: &Facts) -> Advice {
        // MongoDB has no tested CREATE INDEX: the advice comes from `untested_index`.
        self.untested_index(facts).unwrap_or_else(|| Advice::text("Add an index on the fields this query filters on."))
    }

    fn untested_index(&self, facts: &Facts) -> Option<Advice> {
        if facts.fields.is_empty() {
            return None;
        }
        let model = model(facts);
        let spec = facts.fields.iter().map(|f| format!("'{f}': 1")).collect::<Vec<_>>().join(", ");
        let vars = [("model", model.as_str()), ("schema", &format!("{}Schema", lower_first(&model))), ("spec", &spec), ("fields", &quoted_list(&facts.fields))];
        Some(Advice::new(
            fill(
                "The query is slow, and filters on {{fields}}. Without an index on them MongoDB scans the whole \
                 collection. Declare one on the schema (equality fields first, then sort and range fields), and check \
                 with `.explain()` that the query uses it.",
                &vars,
            ),
            fill(
                r#"
{{schema}}.index({ {{spec}} });

// Build it once on deploy (autoIndex is best off in production):
// await {{model}}.syncIndexes();
// Check: await {{model}}.find(filter).explain('executionStats');"#,
                &vars,
            ),
        ))
    }

    fn unique_violation(&self, facts: &Facts) -> Advice {
        Advice::new(
            "Inserts hit a unique index (E11000 duplicate key): the document already exists. Update it in place, \
             or insert only when it's missing, with an upsert.",
            fill(
                r#"
await {{model}}.updateOne(
  { email }, // the unique field(s)
  { $set: changes, $setOnInsert: { createdAt: new Date() } },
  { upsert: true },
);"#,
                &[("model", &model(facts))],
            ),
        )
    }

    fn chatty_request(&self) -> Advice {
        Advice::text(
            "One request runs dozens of MongoDB commands. Load related documents with `populate` (one `$in` query \
             per path) instead of one by one, batch writes with `insertMany` / `bulkWrite`, and consider one \
             `aggregate` with `$lookup` when a page needs data from several collections.",
        )
    }

    fn deadlock(&self) -> Advice {
        Advice::new(
            "Transactions conflict on the same documents (WriteConflict). Run them with `session.withTransaction()`, \
             which retries a transaction that fails with a transient error, and keep transactions short.",
            r#"
await mongoose.connection.transaction(async (session) => {
  // every operation with { session }
});"#
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
    fn has_many_n_plus_one_uses_in_or_a_virtual() {
        let fix = fix_for(&Mongoose, FindingKind::NPlusOne, r#"OrderItem.find({"order": ?})"#, Some(r#"Order.find({"customer": ?})"#));
        let code = fix.code.unwrap();
        assert!(code.contains("OrderItem.find({ order: { $in: orders.map((p) => p._id) } })"), "{code}");
        assert!(code.contains("orderSchema.virtual('orderItems', { ref: 'OrderItem', localField: '_id', foreignField: 'order' })"), "{code}");
        assert_eq!(fix.orm, Some(Orm::Mongoose));
    }

    #[test]
    fn reference_n_plus_one_populates() {
        let fix = fix_for(&Mongoose, FindingKind::NPlusOne, r#"Customer.findOne({"_id": ?})"#, Some(r#"Order.find({})"#));
        assert!(fix.code.unwrap().contains("Order.find(…).populate('customer')"));
    }

    #[test]
    fn slow_queries_get_an_index_on_their_filter() {
        let fix = fix_for(&Mongoose, FindingKind::SlowQuery, r#"Order.find({"customer": ?, "status": {"$in": [?]}}).sort({"createdAt": -1})"#, None);
        assert!(fix.code.unwrap().contains("orderSchema.index({ 'customer': 1, 'status': 1 })"));
    }

    #[test]
    fn every_kind() {
        covers_every_kind(&Mongoose, r#"Order.find({"customer": ?})"#);
        let write = fix_for(&Mongoose, FindingKind::LoopedWrites, "Event.insert([?])", None);
        assert!(write.code.unwrap().contains("Event.insertMany(events)"));
    }
}
