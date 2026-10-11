//! The QueryLens SDK for Node.js (`integrations/node`, published as `querylens-node`),
//! embedded so `querylens capture -- npm test` works in projects that haven't installed
//! it: the CLI preloads it through NODE_OPTIONS. When the project has it installed too,
//! the first copy loaded wins (the SDK guards with a process-wide symbol).

use std::path::{Path, PathBuf};

use crate::error::AppResult;
use crate::paths;

const INDEX: &str = include_str!("../../../integrations/node/index.cjs");
const REGISTER: &str = include_str!("../../../integrations/node/register.cjs");

/// Write the SDK where Node can preload it, and return the path to `register.cjs`.
pub fn install() -> AppResult<PathBuf> {
    let dir = paths::runtime_dir()?.join("querylens-node");
    std::fs::create_dir_all(&dir)?;
    for (name, content) in [("index.cjs", INDEX), ("register.cjs", REGISTER)] {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(content) {
            std::fs::write(&path, content)?;
        }
    }
    Ok(dir.join("register.cjs"))
}

/// `--require "<path>"`, appended to any existing NODE_OPTIONS. Node parses
/// backslashes in NODE_OPTIONS as escapes, so Windows paths use forward slashes.
pub fn node_options(existing: &str, hook: &Path) -> String {
    let path = hook.display().to_string().replace('\\', "/");
    format!("{existing} --require \"{path}\"").trim().to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn node_options_use_forward_slashes() {
        let opts = super::node_options("--max-old-space-size=4096", std::path::Path::new(r"C:\Users\me\register.cjs"));
        assert_eq!(opts, r#"--max-old-space-size=4096 --require "C:/Users/me/register.cjs""#);
    }
}
