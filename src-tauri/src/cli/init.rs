//! `querylens init`: set a Node.js project up with the SDK, like Sentry's wizard.
//! Installs `querylens-node` and adds one line at the top of the app's entry file
//! (or Next.js's `instrumentation` hook). Deciding what to change is pure; applying
//! it is the only part that touches the disk or runs the package manager.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::{AppError, AppResult};

pub const PACKAGE: &str = "querylens-node";
const MARKER: &str = "querylens-node";

/// What `init` will do in a project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub manager: Manager,
    pub edit: Edit,
    /// Already in package.json.
    pub installed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl Manager {
    fn detect(dir: &Path) -> Self {
        if dir.join("pnpm-lock.yaml").exists() {
            Manager::Pnpm
        } else if dir.join("yarn.lock").exists() {
            Manager::Yarn
        } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
            Manager::Bun
        } else {
            Manager::Npm
        }
    }

    /// The install command for `spec`.
    pub fn install(self, spec: &str) -> Vec<String> {
        let (bin, verb) = match self {
            Manager::Npm => ("npm", "install"),
            Manager::Pnpm => ("pnpm", "add"),
            Manager::Yarn => ("yarn", "add"),
            Manager::Bun => ("bun", "add"),
        };
        vec![bin.into(), verb.into(), spec.into()]
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edit {
    /// Add the line at the top of this file.
    Prepend { file: PathBuf, line: String },
    /// Write Next.js's instrumentation hook (new file).
    CreateInstrumentation { file: PathBuf },
    /// Add the import inside an existing `register()` hook.
    PatchInstrumentation { file: PathBuf },
    /// The project already loads the SDK.
    AlreadyDone { file: PathBuf },
}

/// Decide what to change. `entry` overrides the detected entry file.
pub fn plan(dir: &Path, entry: Option<&Path>) -> AppResult<Plan> {
    let pkg_path = dir.join("package.json");
    let pkg: Value = std::fs::read_to_string(&pkg_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(|| {
            AppError::validation(
                "No package.json here. `querylens init` sets up Node.js projects; for other stacks, run your app \
                 with `querylens capture -- <command>`.",
            )
        })?;
    let has_dep = |name: &str| {
        ["dependencies", "devDependencies"].iter().any(|k| pkg.get(k).and_then(|d| d.get(name)).is_some())
    };
    let installed = has_dep(PACKAGE);
    let manager = Manager::detect(dir);

    let edit = if let Some(file) = entry {
        prepend_edit(dir, &dir.join(file), &pkg)?
    } else if has_dep("next") {
        next_edit(dir)?
    } else {
        let file = find_entry(dir, &pkg).ok_or_else(|| {
            AppError::validation("Couldn't tell which file starts your app. Pass it with --entry, e.g. --entry src/server.ts")
        })?;
        prepend_edit(dir, &file, &pkg)?
    };
    Ok(Plan { manager, edit, installed })
}

fn prepend_edit(dir: &Path, file: &Path, pkg: &Value) -> AppResult<Edit> {
    let source = std::fs::read_to_string(file)
        .map_err(|e| AppError::validation(format!("Can't read {}: {e}", file.display())))?;
    if source.contains(MARKER) {
        return Ok(Edit::AlreadyDone { file: relative(dir, file) });
    }
    Ok(Edit::Prepend { file: relative(dir, file), line: sdk_line(file, pkg, &source) })
}

fn next_edit(dir: &Path) -> AppResult<Edit> {
    // Next.js looks for instrumentation next to app/ or pages/, in src/ when that's used.
    let base = if dir.join("src/app").exists() || dir.join("src/pages").exists() { dir.join("src") } else { dir.to_path_buf() };
    for name in ["instrumentation.ts", "instrumentation.js"] {
        let file = base.join(name);
        if let Ok(source) = std::fs::read_to_string(&file) {
            if source.contains(MARKER) {
                return Ok(Edit::AlreadyDone { file: relative(dir, &file) });
            }
            return Ok(Edit::PatchInstrumentation { file: relative(dir, &file) });
        }
    }
    let ts = dir.join("tsconfig.json").exists();
    Ok(Edit::CreateInstrumentation { file: relative(dir, &base.join(if ts { "instrumentation.ts" } else { "instrumentation.js" })) })
}

fn relative(dir: &Path, file: &Path) -> PathBuf {
    file.strip_prefix(dir).map(Path::to_path_buf).unwrap_or_else(|_| file.to_path_buf())
}

/// The entry file: from the dev/start script, then package.json "main", then the usual names.
fn find_entry(dir: &Path, pkg: &Value) -> Option<PathBuf> {
    let exists = |rel: &str| {
        let p = dir.join(rel);
        p.is_file().then_some(p)
    };
    for script in ["dev", "start", "serve"] {
        let Some(cmd) = pkg.get("scripts").and_then(|s| s.get(script)).and_then(Value::as_str) else { continue };
        for token in cmd.split_whitespace() {
            let token = token.trim_matches(['"', '\'']);
            if !is_script_file(token) {
                continue;
            }
            if let Some(p) = exists(token).filter(|_| !is_build_output(token)) {
                return Some(p);
            }
            // `node dist/main.js` (Nest, tsc): the source is src/main.ts.
            if let Some(src) = source_of_build(token).and_then(|s| exists(&s)) {
                return Some(src);
            }
        }
    }
    if let Some(main) = pkg.get("main").and_then(Value::as_str).filter(|m| !is_build_output(m)) {
        if let Some(p) = exists(main.trim_start_matches("./")) {
            return Some(p);
        }
    }
    const USUAL: &[&str] = &[
        "src/main.ts", "src/index.ts", "src/server.ts", "src/app.ts", "server.ts", "index.ts", "app.ts",
        "src/main.js", "src/index.js", "src/server.js", "src/app.js", "server.js", "index.js", "app.js", "bin/www",
    ];
    USUAL.iter().find_map(|f| exists(f))
}

fn is_script_file(token: &str) -> bool {
    [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"].iter().any(|ext| token.ends_with(ext))
}

fn is_build_output(path: &str) -> bool {
    let p = path.trim_start_matches("./");
    ["dist/", "build/", "out/", ".next/"].iter().any(|d| p.starts_with(d))
}

/// `dist/main.js` → `src/main.ts`.
fn source_of_build(path: &str) -> Option<String> {
    let p = path.trim_start_matches("./");
    let rest = ["dist/", "build/", "out/"].iter().find_map(|d| p.strip_prefix(d))?;
    let stem = rest.rsplit_once('.')?.0;
    Some(format!("src/{stem}.ts"))
}

/// `import` for ESM and TypeScript, `require` for CommonJS; semicolon if the file uses them.
fn sdk_line(file: &Path, pkg: &Value, source: &str) -> String {
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
    let module_pkg = pkg.get("type").and_then(Value::as_str) == Some("module");
    let esm = matches!(ext, "mjs" | "ts" | "mts" | "tsx") || (ext == "js" && module_pkg) || source.contains("\nimport ");
    let statements = source.lines().filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with("//")).count().max(1);
    let semis = source.lines().filter(|l| l.trim_end().ends_with(';')).count();
    let semi = if semis * 3 >= statements { ";" } else { "" };
    if esm { format!("import '{PACKAGE}/register'{semi}") } else { format!("require('{PACKAGE}/register'){semi}") }
}

/// `source` with `line` after any shebang, `'use strict'` and leading comments.
pub fn prepend(source: &str, line: &str) -> String {
    let lines: Vec<&str> = source.split_inclusive('\n').collect();
    let mut i = 0;
    let mut in_block = false;
    while i < lines.len() {
        let t = lines[i].trim();
        let skip = in_block
            || (i == 0 && t.starts_with("#!"))
            || t.starts_with("//")
            || t.starts_with("/*")
            || t == "'use strict';"
            || t == "\"use strict\";"
            || t == "'use strict'"
            || t == "\"use strict\"";
        if !skip {
            break;
        }
        if t.starts_with("/*") && !t.contains("*/") {
            in_block = true;
        } else if in_block && t.contains("*/") {
            in_block = false;
        }
        i += 1;
    }
    let (head, tail) = lines.split_at(i);
    let comment = "// Records database queries for QueryLens (local only, off in production).\n";
    let mut out = head.concat();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(comment);
    out.push_str(line);
    out.push('\n');
    out.push_str(&tail.concat());
    out
}

pub const INSTRUMENTATION: &str = "// Records database queries for QueryLens (local only, off in production).\n\
export async function register() {\n  if (process.env.NEXT_RUNTIME === 'nodejs') {\n    await import('querylens-node/register')\n  }\n}\n";

/// An existing `register()` with the import added at the top of its body.
pub fn patch_instrumentation(source: &str) -> Option<String> {
    let at = source.find("function register")?;
    let brace = at + source[at..].find('{')?;
    let insert = "\n  if (process.env.NEXT_RUNTIME === 'nodejs') {\n    await import('querylens-node/register') // QueryLens\n  }";
    Some(format!("{}{insert}{}", &source[..=brace], &source[brace + 1..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ql-init-{}", uuid::Uuid::new_v4()));
        for (name, content) in files {
            let path = dir.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        dir
    }

    #[test]
    fn express_commonjs_app_from_the_start_script() {
        let dir = project(&[
            ("package.json", r#"{"scripts":{"start":"node server.js"},"dependencies":{"express":"4"}}"#),
            ("server.js", "'use strict';\nconst app = require('./app');\napp.listen(3000);\n"),
            ("package-lock.json", "{}"),
        ]);
        let p = plan(&dir, None).unwrap();
        assert_eq!(p.manager, Manager::Npm);
        assert!(!p.installed);
        assert_eq!(p.edit, Edit::Prepend { file: "server.js".into(), line: "require('querylens-node/register');".into() });
    }

    #[test]
    fn nest_typescript_maps_the_build_output_to_its_source() {
        let dir = project(&[
            ("package.json", r#"{"main":"dist/main.js","scripts":{"start":"node dist/main"}}"#),
            ("src/main.ts", "import { NestFactory } from '@nestjs/core'\nbootstrap()\n"),
            ("pnpm-lock.yaml", ""),
        ]);
        let p = plan(&dir, None).unwrap();
        assert_eq!(p.manager, Manager::Pnpm);
        assert_eq!(p.edit, Edit::Prepend { file: PathBuf::from("src").join("main.ts"), line: "import 'querylens-node/register'".into() });
    }

    #[test]
    fn next_gets_an_instrumentation_hook() {
        let dir = project(&[("package.json", r#"{"dependencies":{"next":"15"}}"#), ("tsconfig.json", "{}"), ("src/app/page.tsx", "")]);
        assert_eq!(plan(&dir, None).unwrap().edit, Edit::CreateInstrumentation { file: PathBuf::from("src").join("instrumentation.ts") });
        let patched = patch_instrumentation("export async function register() {\n  await other()\n}\n").unwrap();
        assert!(patched.starts_with("export async function register() {\n  if (process.env.NEXT_RUNTIME === 'nodejs') {"));
        assert!(patched.ends_with("  await other()\n}\n"));
    }

    #[test]
    fn already_set_up_and_missing_package_json() {
        let dir = project(&[("package.json", r#"{"dependencies":{"querylens-node":"1"}}"#), ("index.js", "require('querylens-node/register')\n")]);
        let p = plan(&dir, None).unwrap();
        assert!(p.installed);
        assert_eq!(p.edit, Edit::AlreadyDone { file: "index.js".into() });
        assert!(plan(&project(&[("x", "")]), None).is_err());
    }

    #[test]
    fn the_line_goes_after_shebang_strict_mode_and_header_comments() {
        let src = "#!/usr/bin/env node\n/**\n * Server\n */\n'use strict';\nconst x = 1;\n";
        let out = prepend(src, "require('querylens-node/register');");
        assert_eq!(
            out,
            "#!/usr/bin/env node\n/**\n * Server\n */\n'use strict';\n\
             // Records database queries for QueryLens (local only, off in production).\n\
             require('querylens-node/register');\nconst x = 1;\n"
        );
        assert!(prepend("", "x").ends_with("x\n"));
    }
}
