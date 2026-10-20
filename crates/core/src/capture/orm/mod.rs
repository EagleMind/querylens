//! ORM-aware fix advice.
//!
//! Detection is ORM-agnostic; this layer turns a finding into a change in the
//! application's own terms. Each ORM is an [`OrmAdvisor`]: Sequelize has a full
//! implementation, the rest fall back to [`generic::Generic`], which names the
//! right API but has no code templates. Adding an ORM = one module implementing
//! the trait + one arm in [`advisor`].

mod facts;
mod generic;
mod recognize;
mod sequelize;

pub use facts::Facts;
pub use recognize::recognize;

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
        other => Box::new(generic::Generic(other)),
    }
}

/// `CREATE INDEX` for a tested index suggestion that the planner used.
fn tested_index(ctx: &HintContext) -> Option<String> {
    ctx.plan.and_then(|p| p.index.as_ref()).filter(|i| i.used).map(|i| i.ddl.clone())
}
