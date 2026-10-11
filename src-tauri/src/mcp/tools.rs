//! Tool schemas: only what each engine can do safely, plus capture tools outside
//! advisor mode.

use serde_json::{Value, json};

use crate::model::Engine;

pub fn instructions(capture: bool) -> &'static str {
    if capture {
        "QueryLens profiles the database queries of the application you're working on. To find N+1 queries, \
         missing indexes and other ORM problems: capture_start, run the app or its tests with the database URL \
         it returns, then capture_stop for findings with fixes written for the app's ORM. After changing the code, \
         capture again and compare_captures to confirm the fix. explain_query and test_index measure a single \
         query; everything they run is rolled back."
    } else {
        "Tools to plan and measure queries against the user's database; everything runs in a transaction that is \
         rolled back."
    }
}

pub fn definitions(engine: Engine, capture: bool) -> Value {
    let mut tools = query_tools(engine);
    if capture && engine == Engine::Postgres {
        tools.extend(capture_tools());
    }
    Value::Array(tools)
}

fn query_tools(engine: Engine) -> Vec<Value> {
    let (explain_desc, sql_desc) = match engine {
        Engine::Mongodb => (
            "Explain a MongoDB query against the user's database (executionStats runs reads; writes are \
             never applied). Returns execution time and the annotated plan tree. Use it to measure a \
             rewrite, or an existing index via .hint({ … }).",
            "The query in mongosh syntax, e.g. db.orders.find({ status: \"paid\" }).sort({ total: -1 }).",
        ),
        Engine::Mysql => (
            "Run EXPLAIN ANALYZE on a SQL query against the user's MySQL database, in a read-only \
             transaction. Returns execution time and the annotated plan tree. Use it to measure a \
             rewrite, or session settings via setup_sql.",
            "A single SELECT statement.",
        ),
        Engine::Postgres | Engine::Duckdb => (
            "Run EXPLAIN on a SQL query against the user's database, inside a transaction that is \
             always rolled back (read-only after setup). Returns execution time and the annotated \
             plan tree. Use it to measure a rewrite, or pass setup_sql to measure the effect of a \
             candidate index or setting.",
            "A single SELECT (or other explainable) statement.",
        ),
    };
    let mut explain_props = json!({
        "sql": { "type": "string", "description": sql_desc },
        "analyze": { "type": "boolean", "description": "Execute for real timings (default true). false = planner estimate only." }
    });
    let setup_desc = match engine {
        Engine::Postgres => Some(
            "Optional statement(s) run first in the same rolled-back transaction: CREATE [UNIQUE] INDEX, \
             CREATE STATISTICS, SET or ANALYZE. A string or an array of strings.",
        ),
        Engine::Mysql => Some("Optional SET SESSION statement(s) run first. A string or an array of strings."),
        Engine::Duckdb | Engine::Mongodb => None,
    };
    if let Some(desc) = setup_desc {
        explain_props["setup_sql"] = json!({
            "description": desc,
            "anyOf": [ { "type": "string" }, { "type": "array", "items": { "type": "string" } } ]
        });
    }
    if engine == Engine::Postgres {
        explain_props["params"] = params_schema();
    }
    let table_desc = if engine == Engine::Mongodb {
        "Sampled fields, indexes, document count and size for a collection."
    } else {
        "Columns, indexes, row estimate, size and statistics freshness for a table."
    };
    let mut tools = vec![
        json!({
            "name": "explain_query",
            "description": explain_desc,
            "inputSchema": { "type": "object", "properties": explain_props, "required": ["sql"] }
        }),
        json!({
            "name": "table_info",
            "description": table_desc,
            "inputSchema": {
                "type": "object",
                "properties": { "table": { "type": "string", "description": "Table or collection name." } },
                "required": ["table"]
            }
        }),
    ];
    // Building an index inside a rolled-back transaction (or with HypoPG) is PostgreSQL-only.
    if engine == Engine::Postgres {
        tools.push(json!({
            "name": "test_index",
            "description": "Test candidate indexes for a query. With HypoPG installed it plans with hypothetical \
                indexes: instant and lock-free, but an estimate. Otherwise it builds them inside a rolled-back \
                transaction and measures. The output starts with an EVIDENCE line saying which.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "sql": { "type": "string", "description": "The query to plan." },
                    "indexes": { "type": "array", "items": { "type": "string" }, "description": "CREATE [UNIQUE] INDEX statements to test together." },
                    "params": params_schema()
                },
                "required": ["sql", "indexes"]
            }
        }));
    }
    tools
}

fn params_schema() -> Value {
    json!({ "type": "array", "items": { "type": "string" }, "description": "Values for $1…$n, as text." })
}

fn capture_id_schema() -> Value {
    json!({ "type": "string", "description": "Capture id; default: the latest capture." })
}

fn capture_tools() -> Vec<Value> {
    vec![
        json!({
            "name": "capture_start",
            "description": "Start recording the SQL the application sends: a proxy in front of the database. \
                Returns the database URL to run the app or its tests with. Call capture_stop afterwards.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "port": { "type": "integer", "description": "Local port for the proxy (default 6543)." },
                    "name": { "type": "string", "description": "A label, e.g. \"before fix\"." }
                }
            }
        }),
        json!({
            "name": "capture_stop",
            "description": "Stop the running capture and analyze it: N+1 queries, duplicate queries, row-by-row \
                writes, missing indexes (tested), slow and unbounded queries, each with where it came from in the \
                code and a fix for the app's ORM.",
            "inputSchema": { "type": "object", "properties": { "capture_id": capture_id_schema() } }
        }),
        json!({
            "name": "capture_report",
            "description": "The full report of a past capture (Markdown).",
            "inputSchema": { "type": "object", "properties": { "capture_id": capture_id_schema() } }
        }),
        json!({
            "name": "capture_statement",
            "description": "Details of one captured statement by fingerprint: timings, the slowest execution with \
                its values, call sites, plan and tested index.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "fingerprint": { "type": "string", "description": "As shown in the report." },
                    "capture_id": capture_id_schema()
                },
                "required": ["fingerprint"]
            }
        }),
        json!({
            "name": "compare_captures",
            "description": "Compare two captures (before/after a change): findings fixed and introduced, and \
                statement count and time changes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "before": { "type": "string", "description": "Capture id before the change." },
                    "after": capture_id_schema()
                },
                "required": ["before"]
            }
        }),
        json!({
            "name": "list_captures",
            "description": "Recent captures with their ids.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(e: Engine, capture: bool) -> Vec<String> {
        definitions(e, capture).as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn tools_follow_the_engine_and_mode() {
        assert_eq!(names(Engine::Postgres, false), ["explain_query", "table_info", "test_index"]);
        assert_eq!(names(Engine::Mongodb, false), ["explain_query", "table_info"]);
        assert!(names(Engine::Postgres, true).contains(&"capture_stop".to_string()));
        // Capture needs the PostgreSQL proxy.
        assert!(!names(Engine::Mysql, true).contains(&"capture_start".to_string()));
        assert!(definitions(Engine::Mongodb, false)[0]["inputSchema"]["properties"].get("setup_sql").is_none());
        assert!(definitions(Engine::Mysql, false)[0]["inputSchema"]["properties"].get("setup_sql").is_some());
    }
}
