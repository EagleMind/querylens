//! ORM-aware fix advice.
//!
//! Detection is ORM-agnostic; this layer turns a finding into a change in the
//! application's own terms. Each Node.js ORM has its own module implementing
//! [`templates::Templates`] (one fix per finding kind, with code in that ORM's API);
//! the rest fall back to [`generic::Generic`], which names the right API but has no
//! code. MongoDB has two: Mongoose ([`mongoose`]) and the driver itself ([`mongodb`]).
//! Adding an ORM = one module implementing `Templates` + one arm in [`advisor`].

mod drizzle;
mod facts;
mod generic;
mod knex;
mod mikro_orm;
mod mongodb;
mod mongoose;
mod naming;
mod objection;
mod prisma;
mod recognize;
mod sequelize;
mod templates;
mod typeorm;

pub use facts::Facts;
pub use recognize::{mongo_api, recognize, recognize_mongo};

use crate::model::{CaptureFinding, FingerprintStat, FixHint, Orm, PlanCheck};

/// What an advisor can look at besides the finding itself.
pub struct HintContext<'a> {
    pub stat: &'a FingerprintStat,
    /// The statement whose rows an N+1 loop iterates.
    pub parent: Option<&'a FingerprintStat>,
    /// The re-planned statement, when plans were checked.
    pub plan: Option<&'a PlanCheck>,
}

pub trait OrmAdvisor {
    fn fix(&self, finding: &CaptureFinding, ctx: &HintContext) -> Option<FixHint>;
}

pub fn advisor(orm: Option<Orm>) -> Box<dyn OrmAdvisor> {
    match orm {
        Some(Orm::Sequelize) => Box::new(sequelize::Sequelize),
        Some(Orm::Prisma) => Box::new(prisma::Prisma),
        Some(Orm::TypeOrm) => Box::new(typeorm::TypeOrm),
        Some(Orm::Drizzle) => Box::new(drizzle::Drizzle),
        Some(Orm::MikroOrm) => Box::new(mikro_orm::MikroOrm),
        Some(Orm::Objection) => Box::new(objection::Objection),
        Some(Orm::Knex) => Box::new(knex::Knex),
        Some(Orm::Mongoose) => Box::new(mongoose::Mongoose),
        Some(Orm::MongoDb) => Box::new(mongodb::MongoDb),
        other => Box::new(generic::Generic(other)),
    }
}

/// `CREATE INDEX` for a tested index suggestion that the planner used.
fn tested_index(ctx: &HintContext) -> Option<String> {
    ctx.plan.and_then(|p| p.index.as_ref()).filter(|i| i.used).map(|i| i.ddl.clone())
}
