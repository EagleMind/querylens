//! Table and column names → the names an ORM's code uses for them (models, properties,
//! relations). Every ORM derives table names from model names its own way; these
//! reverse the common conventions. Guesses, so the fixes say where they guess.

/// `order_items` → `order_item`, `categories` → `category`, `addresses` → `address`.
pub fn singular(word: &str) -> String {
    if let Some(stem) = word.strip_suffix("ies") {
        return format!("{stem}y");
    }
    for suffix in ["sses", "xes", "ches", "shes", "zzes"] {
        if word.ends_with(suffix) {
            return word[..word.len() - 2].to_string();
        }
    }
    if word.ends_with("ss") || word.ends_with("us") || word.ends_with("is") {
        return word.to_string();
    }
    word.strip_suffix('s').unwrap_or(word).to_string()
}

pub fn plural(word: &str) -> String {
    if let Some(stem) = word.strip_suffix('y').filter(|s| !s.ends_with(['a', 'e', 'o', 'u'])) {
        format!("{stem}ies")
    } else if word.ends_with('s') || word.ends_with('x') || word.ends_with("ch") || word.ends_with("sh") {
        format!("{word}es")
    } else {
        format!("{word}s")
    }
}

/// The model (entity) name for a table: `order_items` → `OrderItem`, and a table
/// already named after its model (Prisma's `"OrderItem"`) stays as it is.
pub fn model_from_table(table: &str) -> String {
    pascal(&singular(table))
}

/// `order_id` → `orderId` (the property ORMs map a snake_case column to).
pub fn camel(name: &str) -> String {
    lower_first(&pascal(name))
}

pub fn pascal(name: &str) -> String {
    name.split('_').map(upper_first).collect()
}

pub fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_lowercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn upper_first(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// The columns of a `CREATE INDEX … ON t (a, b)`, unquoted.
pub fn index_columns(ddl: &str) -> Vec<String> {
    ddl.rsplit_once('(')
        .map(|(_, cols)| cols.trim_end_matches([')', ';', ' ']).split(',').map(|c| c.trim().trim_matches(['"', '`']).to_string()).collect())
        .unwrap_or_default()
}

/// `['a', 'b']`-style list of quoted names.
pub fn quoted_list(names: &[String]) -> String {
    names.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_from_tables() {
        assert_eq!(model_from_table("order_items"), "OrderItem");
        assert_eq!(model_from_table("categories"), "Category");
        assert_eq!(model_from_table("addresses"), "Address");
        assert_eq!(model_from_table("boxes"), "Box");
        assert_eq!(model_from_table("status"), "Status");
        assert_eq!(model_from_table("OrderItem"), "OrderItem");
        assert_eq!(model_from_table("Address"), "Address");
        assert_eq!(model_from_table("order_item"), "OrderItem");
    }

    #[test]
    fn plurals_and_cases() {
        assert_eq!(plural("Category"), "Categories");
        assert_eq!(plural("Day"), "Days");
        assert_eq!(plural("Address"), "Addresses");
        assert_eq!(plural("OrderItem"), "OrderItems");
        assert_eq!(camel("order_id"), "orderId");
        assert_eq!(camel("orderId"), "orderId");
        assert_eq!(camel("order_items"), "orderItems");
    }

    #[test]
    fn index_ddl() {
        let cols = index_columns(r#"CREATE INDEX "order_items_order_id_idx" ON "order_items" ("order_id", "created_at")"#);
        assert_eq!(cols, ["order_id", "created_at"]);
        assert_eq!(quoted_list(&cols), "'order_id', 'created_at'");
    }
}
