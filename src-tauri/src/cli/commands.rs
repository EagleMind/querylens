//! Subcommand implementations. Each resolves its inputs, calls the capture
//! services, and prints; no analysis logic lives here.

use std::io::Write;
use std::net::SocketAddr;
use std::path::Path;
use std::process::ExitStatus;
use std::sync::Arc;
use std::time::Duration;

use super::child::{self, ChildSpec};
use super::discover::{self, Profile};
use super::init::{self, Edit};
use super::{CaptureArgs, CheckArgs, Command, InitArgs, McpArgs, ProxyArgs, ReportArgs};
use crate::capture::baseline::{self, Baseline, Gate};
use crate::capture::ingest::collector;
use crate::capture::{RunningCapture, StartOptions, render, report};
use crate::error::{AppError, AppResult};
use crate::format::fmt_ms;
use crate::model::{CaptureReport, CaptureSource};
use crate::services::target::Target;
use crate::storage::Store;
use crate::paths;

pub fn run(command: Command) -> i32 {
    // The MCP server runs its own loop and runtime.
    if let Command::Mcp(args) = command {
        return mcp(args);
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("querylens: {e}");
            return 1;
        }
    };
    let result = runtime.block_on(async move {
        match command {
            Command::Init(a) => init(a).await,
            Command::Capture(a) => capture(a).await,
            Command::Check(a) => check(a).await,
            Command::Report(a) => report(a).await,
            Command::Captures => captures(),
            Command::Mcp(_) => unreachable!("handled above"),
        }
    });
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("querylens: {}", e.message);
            1
        }
    }
}

fn open_store() -> AppResult<Arc<Store>> {
    Ok(Arc::new(Store::open(&paths::db_path()?)?))
}

/// The database to work on, and the variables the app reads it from.
struct Resolved {
    target: Target,
    /// Variables to point at the proxy, with {url} / {host} / {port} placeholders.
    overrides: Vec<(String, String)>,
}

/// `--db`, else whatever the project uses (environment, .env files, ORM config).
/// `None` when nothing is found.
fn resolve(store: &Store, db: Option<&str>, profile: Profile) -> AppResult<Option<Resolved>> {
    if let Some(db) = db {
        return Ok(Some(Resolved { target: Target::resolve(store, db)?, overrides: Vec::new() }));
    }
    let dir = std::env::current_dir()?;
    let Some(found) = discover::discover(&dir, profile, &|k| std::env::var(k).ok()) else { return Ok(None) };
    let target = Target::from_url(&found.url)?;
    eprintln!("QueryLens: database {} (from {})", target.conn.name, found.source);
    Ok(Some(Resolved { target, overrides: found.overrides }))
}

const NOT_FOUND: &str = "Couldn't find your database: no DATABASE_URL (or DB_HOST/PGHOST…) in the environment or \
    .env files, and no config/config.json. Pass it with --db postgres://user:password@host:5432/dbname";

/// The discovered overrides plus `--env` and `--set`.
fn overrides(resolved: Option<&Resolved>, proxy: &ProxyArgs) -> AppResult<Vec<(String, String)>> {
    let mut all = resolved.map(|r| r.overrides.clone()).unwrap_or_default();
    all.extend(proxy.env.iter().map(|name| (name.clone(), "{url}".to_string())));
    for item in &proxy.set {
        all.push(child::parse_set(item)?);
    }
    Ok(all)
}

/// The app URL with its password hidden, for printing.
fn masked(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut u) if u.password().is_some() => {
            let _ = u.set_password(Some("****"));
            u.to_string()
        }
        _ => url.to_string(),
    }
}

struct Captured {
    report: CaptureReport,
    /// The command's exit status (None when capturing until Ctrl+C).
    status: Option<ExitStatus>,
}

/// Record while `command` runs (or until Ctrl+C), then build the report.
///
/// The SDK is the main source: a command QueryLens runs gets it preloaded (Node.js)
/// and reports through a spool directory; an app started separately reports to the
/// collector on the default port. When the database is known, a proxy (on `listen`,
/// else `preferred`, else any free port) also catches apps without the SDK.
async fn capture_around(
    store: &Arc<Store>,
    resolved: Option<&Resolved>,
    listen: Option<SocketAddr>,
    preferred: SocketAddr,
    proxy: &ProxyArgs,
    command: &[String],
    options: &report::ReportOptions,
) -> AppResult<Captured> {
    let target = resolved.map(|r| &r.target);
    let overrides = overrides(resolved, proxy)?;
    let manual = command.is_empty();
    let spool = (!manual).then(|| paths::runtime_dir().map(|d| d.join(format!("spool-{}", uuid::Uuid::new_v4())))).transpose()?;
    let start = |proxy_addr: Option<SocketAddr>| {
        let opts = StartOptions {
            name: proxy.name.clone(),
            source: CaptureSource::Cli,
            collector: manual.then(|| SocketAddr::from(([127, 0, 0, 1], collector::DEFAULT_PORT))),
            spool: spool.clone(),
            proxy: proxy_addr,
            collector_fallback: true,
        };
        RunningCapture::start(store.clone(), target, opts)
    };
    let wanted = target.map(|_| listen.unwrap_or(preferred));
    let running = match (start(wanted).await, listen) {
        (Ok(r), _) => r,
        // The default proxy port is taken: any free port will do.
        (Err(_), None) if wanted.is_some() => start(Some(SocketAddr::from(([127, 0, 0, 1], 0)))).await?,
        (Err(e), _) => return Err(e),
    };

    // Ctrl+C stops the command (it shares the terminal); QueryLens keeps going to report.
    let ignore_interrupts = tokio::spawn(async {
        while tokio::signal::ctrl_c().await.is_ok() {}
    });
    let status = if manual {
        print_manual_instructions(&running);
        wait_for_interrupt(&running).await;
        None
    } else {
        let proxy_addr = running.proxy_addr();
        let proxy_host = proxy_addr.map(|a| a.ip().to_string()).unwrap_or_default();
        let spec = ChildSpec {
            command,
            app_url: running.app_url(),
            proxy_host: &proxy_host,
            proxy_port: proxy_addr.map(|a| a.port()).unwrap_or(0),
            overrides: &overrides,
            spool: running.spool_dir(),
            sdk: !proxy.no_sdk,
        };
        eprintln!("QueryLens: recording. Running: {}\n", command.join(" "));
        Some(child::run(&spec).await?)
    };
    ignore_interrupts.abort();

    let summary = running.stop(store).await?;
    if summary.statements == 0 {
        eprintln!(
            "\nNo statements were recorded. Node.js apps on `pg` are recorded automatically; for other stacks, \
             QueryLens needs the database (--db) and the setting your app reads pointed at its proxy \
             (--env NAME for a URL variable, or --set KEY={{port}} for separate settings)."
        );
    }
    eprintln!("\nAnalyzing {} statements…", summary.statements);
    if target.is_none() {
        eprintln!("(Plans aren't checked: {NOT_FOUND})");
    }
    let report = report::build(store, &summary.id, target, options).await?;
    Ok(Captured { report, status })
}

fn print_manual_instructions(running: &RunningCapture) {
    let mut lines = vec!["QueryLens: recording. Start your app (or run its tests) in another terminal:".to_string()];
    if let Some(url) = running.collector_url() {
        let default = format!("http://127.0.0.1:{}", collector::DEFAULT_PORT);
        let env = if url == default { String::new() } else { format!(" with QUERYLENS_URL={url}") };
        lines.push(format!("  - apps with querylens-node (npx querylens-cli init) report here by themselves{env}"));
    }
    if let Some(url) = running.app_url() {
        lines.push(format!("  - any other app: point it at {}", masked(url)));
    }
    lines.push("Press Ctrl+C to stop and see the report.".into());
    eprintln!("{}\n", lines.join("\n"));
}

async fn wait_for_interrupt(running: &RunningCapture) {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = tick.tick() => {
                let live = running.live();
                eprint!(
                    "\r  {} statements · {} · {} app processes · {} proxy connections   ",
                    live.statements,
                    fmt_ms(live.total_ms),
                    live.sdk_processes,
                    live.open_connections
                );
                let _ = std::io::stderr().flush();
            }
        }
    }
    eprintln!();
}

fn exit_code(status: &ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

async fn init(a: InitArgs) -> AppResult<i32> {
    let dir = std::env::current_dir()?;
    let plan = init::plan(&dir, a.entry.as_deref())?;
    let install = plan.manager.install(&a.package);
    let change = match &plan.edit {
        Edit::Prepend { file, line } => format!("add `{line}` at the top of {}", file.display()),
        Edit::CreateInstrumentation { file } => format!("create {} (Next.js instrumentation hook)", file.display()),
        Edit::PatchInstrumentation { file } => format!("load the SDK in register() in {}", file.display()),
        Edit::AlreadyDone { file } => format!("nothing to change: {} already loads the SDK", file.display()),
    };
    let will_install = !a.no_install && !plan.installed;
    if a.dry_run {
        if will_install {
            println!("Would run: {}", install.join(" "));
        }
        match plan.edit {
            Edit::AlreadyDone { .. } => println!("{}.", capitalize(&change)),
            _ => println!("Would {change}."),
        }
        return Ok(0);
    }
    if will_install {
        println!("Running {}…", install.join(" "));
        let program = which::which(&install[0]).map_err(|_| AppError::validation(format!("{} isn't installed", install[0])))?;
        let status = tokio::process::Command::new(program).args(&install[1..]).status().await?;
        if !status.success() {
            return Err(AppError::validation(format!("`{}` failed", install.join(" "))));
        }
    }
    match &plan.edit {
        Edit::Prepend { file, line } => {
            let path = dir.join(file);
            std::fs::write(&path, init::prepend(&std::fs::read_to_string(&path)?, line))?;
        }
        Edit::CreateInstrumentation { file } => std::fs::write(dir.join(file), init::INSTRUMENTATION)?,
        Edit::PatchInstrumentation { file } => {
            let path = dir.join(file);
            let patched = init::patch_instrumentation(&std::fs::read_to_string(&path)?).ok_or_else(|| {
                AppError::validation(format!("Couldn't find register() in {}; add the import there yourself", file.display()))
            })?;
            std::fs::write(&path, patched)?;
        }
        Edit::AlreadyDone { .. } => {}
    }
    match plan.edit {
        Edit::AlreadyDone { .. } => println!("{}.", capitalize(&change)),
        _ => println!("Done: {change}."),
    }
    println!(
        "\nNow run your app as usual and open QueryLens (desktop app → Capture → Start capture),\n\
         or record from the terminal:\n\n  npx querylens-cli capture -- npm run dev\n\n\
         The SDK only records while QueryLens is capturing, stays on your machine, and is off in production."
    );
    Ok(0)
}

/// Proxy port tried first by `capture`, so the URL stays the same between runs.
const DEFAULT_PORT: u16 = 6543;

async fn capture(a: CaptureArgs) -> AppResult<i32> {
    let store = open_store()?;
    let resolved = resolve(&store, a.db.db.as_deref(), Profile::Development)?;
    let preferred = SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT));
    let captured =
        capture_around(&store, resolved.as_ref(), a.listen, preferred, &a.proxy, &a.command, &a.analysis.options())
            .await?;
    println!("\n{}", render::summary(&captured.report));
    write_outputs(&captured.report, &a.report, None)?;
    Ok(captured.status.as_ref().map(exit_code).unwrap_or(0))
}

async fn check(a: CheckArgs) -> AppResult<i32> {
    let store = open_store()?;
    let resolved = resolve(&store, a.db.db.as_deref(), Profile::Test)?;
    let any_port = SocketAddr::from(([127, 0, 0, 1], 0));
    let captured =
        capture_around(&store, resolved.as_ref(), a.listen, any_port, &a.proxy, &a.command, &a.analysis.options())
            .await?;
    let status = captured.status.expect("check always runs a command");
    let report = &captured.report;
    if !status.success() {
        eprintln!("\nThe command failed (exit {}). The check reports what it captured and fails with that code.", exit_code(&status));
    }

    if a.update_baseline {
        Baseline::from_report(report).save(&a.baseline)?;
        println!("\nBaseline written to {} ({} findings accepted).", a.baseline.display(), report.findings.len());
        write_outputs(report, &a.report, None)?;
        return Ok(if status.success() { 0 } else { exit_code(&status) });
    }

    let known = Baseline::load(&a.baseline)?;
    let verdict = baseline::evaluate(report, known.as_ref(), Gate { fail_on: a.fail_on() });
    let verdict_md = render::verdict(&verdict, &a.baseline.display().to_string(), known.is_some());
    println!("\n{verdict_md}");
    write_outputs(report, &a.report, Some(&verdict_md))?;
    Ok(if !status.success() {
        exit_code(&status)
    } else if verdict.passed() {
        0
    } else {
        1
    })
}

/// The report file, and the GitHub Actions job summary when running there.
fn write_outputs(report: &CaptureReport, path: &Path, verdict: Option<&str>) -> AppResult<()> {
    let markdown = || match verdict {
        Some(v) => format!("{v}\n\n{}", render::markdown(report)),
        None => render::markdown(report),
    };
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
        // Reports are local; only the baseline in .querylens/ belongs in git.
        let ignore = dir.join(".gitignore");
        if dir.ends_with(".querylens") && !ignore.exists() {
            std::fs::write(ignore, "# QueryLens: reports are local, commit baseline.json only\nreport.*\n")?;
        }
    }
    let is_json = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json"));
    std::fs::write(path, if is_json { serde_json::to_string_pretty(report)? } else { markdown() })?;
    eprintln!("Full report, with the fixes: {}", path.display());
    if let Some(summary) = std::env::var_os("GITHUB_STEP_SUMMARY") {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(summary)?;
        writeln!(f, "{}", markdown())?;
    }
    Ok(())
}

async fn report(a: ReportArgs) -> AppResult<i32> {
    let store = open_store()?;
    let id = if a.id == "latest" {
        store.list_captures(1)?.into_iter().next().map(|c| c.id).ok_or_else(|| AppError::not_found("No captures yet"))?
    } else {
        // Accept a unique prefix of the id, as printed by `captures`.
        let all = store.list_captures(100)?;
        let matches: Vec<_> = all.iter().filter(|c| c.id.starts_with(&a.id)).collect();
        match matches.as_slice() {
            [one] => one.id.clone(),
            [] => return Err(AppError::not_found(format!("No capture with id {}", a.id))),
            _ => return Err(AppError::validation(format!("{} matches several captures; use more characters", a.id))),
        }
    };
    let stored = if a.db.db.is_none() { store.capture_report(&id)? } else { None };
    let report = match stored {
        Some(r) => r,
        None => {
            let target = a.db.db.as_deref().map(|db| Target::resolve(&store, db)).transpose()?;
            report::build(&store, &id, target.as_ref(), &a.analysis.options()).await?
        }
    };
    if a.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("{}", render::markdown(&report));
    }
    Ok(0)
}

fn captures() -> AppResult<i32> {
    let store = open_store()?;
    let list = store.list_captures(30)?;
    if list.is_empty() {
        println!("No captures yet. Start one with: querylens capture -- <your command>");
        return Ok(0);
    }
    println!("{:<10} {:<20} {:>10} {:>10}  NAME", "ID", "STARTED", "STATEMENTS", "TIME");
    for c in list {
        let started = chrono::DateTime::parse_from_rfc3339(&c.started_at)
            .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or(c.started_at.clone());
        let id: String = c.id.chars().take(8).collect();
        println!("{id:<10} {started:<20} {:>10} {:>10}  {}", c.statements, fmt_ms(c.total_ms), c.name);
    }
    Ok(0)
}

fn mcp(a: McpArgs) -> i32 {
    let store = match open_store() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("querylens mcp: {}", e.message);
            return 1;
        }
    };
    match resolve(&store, a.connection.as_deref(), Profile::Development) {
        Ok(Some(resolved)) => crate::mcp::serve(store, resolved.target),
        Ok(None) => {
            eprintln!("querylens mcp: {NOT_FOUND}");
            2
        }
        Err(e) => {
            eprintln!("querylens mcp: {}", e.message);
            2
        }
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}
