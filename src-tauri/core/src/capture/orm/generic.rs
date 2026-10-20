//! Advice for ORMs without a dedicated advisor (and for hand-written SQL): the
//! technique, and the API that implements it when the ORM is known.

use super::{Facts, HintContext, OrmAdvisor, tested_index};
use crate::model::{CaptureFinding, FindingKind, FixHint, Orm, StatementKind};

pub struct Generic(pub Option<Orm>);

impl OrmAdvisor for Generic {
    fn fix(&self, f: &CaptureFinding, ctx: &HintContext) -> Option<FixHint> {
        let facts = Facts::of(ctx);
        let index = tested_index(ctx);
        let text = match f.kind {
            FindingKind::NPlusOne => {
                let table = facts.table.as_deref().unwrap_or("the related table");
                let key = facts.key.as_deref().map(|k| format!(" by {k}")).unwrap_or_default();
                format!(
                    "Rows of {table} are loaded one at a time{key}, once per row of the previous query. Load them \
                     with that query instead: {}.",
                    self.eager_loading()
                )
            }
            FindingKind::DuplicateQuery => {
                "The identical query repeats with the same values. Run it once before the loop and reuse the result, \
                 or cache it for the duration of the request."
                    .into()
            }
            FindingKind::LoopedWrites => match ctx.stat.kind {
                StatementKind::Insert => format!("Insert the rows in one statement: {}.", self.bulk_insert()),
                _ => "Write the rows with one statement (`WHERE id IN (…)`), or at least inside one transaction so \
                      the loop commits once."
                    .into(),
            },
            FindingKind::LargeResult => {
                "Paginate (LIMIT/OFFSET or keyset), and select only the columns the code uses.".into()
            }
            FindingKind::SlowQuery | FindingKind::PlanIssue => {
                index.as_ref()?;
                "Add the index below with a migration; the planner uses it for this query.".into()
            }
            FindingKind::QueryErrors | FindingKind::ChattyRequest => return None,
        };
        Some(FixHint { orm: self.0, text, code: None, ddl: index })
    }
}

impl Generic {
    fn eager_loading(&self) -> &'static str {
        match self.0 {
            Some(Orm::Prisma) => "`include: { relation: true }` on the findMany",
            Some(Orm::TypeOrm) => "`relations: [...]` on find, or `leftJoinAndSelect` on the query builder",
            Some(Orm::Django) => "`select_related()` for foreign keys, `prefetch_related()` for reverse and many-to-many",
            Some(Orm::ActiveRecord) => "`includes(:association)` (or `preload`)",
            Some(Orm::SqlAlchemy) => "`selectinload()` for collections, `joinedload()` for many-to-one",
            Some(Orm::Hibernate) => "`JOIN FETCH` in the query, an entity graph, or `@BatchSize` on the association",
            Some(Orm::Sequelize) => "`include` on findAll",
            None => "a JOIN, or one `WHERE key IN (…)` query for all rows",
        }
    }

    fn bulk_insert(&self) -> &'static str {
        match self.0 {
            Some(Orm::Prisma) => "`createMany`",
            Some(Orm::TypeOrm) => "`repository.insert([...])` or `save([...])`",
            Some(Orm::Django) => "`bulk_create()`",
            Some(Orm::ActiveRecord) => "`insert_all`",
            Some(Orm::SqlAlchemy) => "`session.execute(insert(Model), rows)`",
            Some(Orm::Hibernate) => "JDBC batching (`hibernate.jdbc.batch_size`)",
            Some(Orm::Sequelize) => "`bulkCreate`",
            None => "a multi-row `INSERT … VALUES (…), (…)`",
        }
    }
}
