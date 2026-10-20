//! Facts about a finding's statements that every advisor needs: which table and
//! alias, which column the loop looks rows up by, which table the parent read.

use crate::capture::sql::shape;

use super::HintContext;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    /// The table the statement reads or writes.
    pub table: Option<String>,
    /// Its alias in the SQL (Sequelize: the model name).
    pub alias: Option<String>,
    /// The column compared with a value on that table (the loop's lookup key).
    pub key: Option<String>,
    pub parent_table: Option<String>,
    pub parent_alias: Option<String>,
}

impl Facts {
    pub fn of(ctx: &HintContext) -> Self {
        let main = shape::main_table(&ctx.stat.sample_sql);
        let table = main.as_ref().map(|t| t.name.clone());
        let key = shape::filters(&ctx.stat.sample_sql)
            .into_iter()
            .find(|f| f.equality && (f.table.is_none() || f.table == table))
            .map(|f| f.column);
        let parent = ctx.parent.and_then(|p| shape::main_table(&p.sample_sql));
        Self {
            table,
            alias: main.and_then(|t| t.alias),
            key,
            parent_table: parent.as_ref().map(|t| t.name.clone()),
            parent_alias: parent.and_then(|t| t.alias),
        }
    }

    /// The loop looks rows up by primary key (a belongs-to association) rather
    /// than by a foreign key (has-many).
    pub fn by_primary_key(&self) -> bool {
        self.key.as_deref() == Some("id")
    }
}
