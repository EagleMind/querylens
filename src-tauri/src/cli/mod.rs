//! The `querylens` command line: capture, check (CI), report, captures, mcp.
//!
//! The same binary is the desktop app: without a subcommand it opens the GUI
//! (when built with the `gui` feature).

mod child;
mod commands;
mod console;
mod discover;
mod init;

use std::net::SocketAddr;
use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

use crate::capture::{PlanDepth, ReportOptions, Thresholds};
use crate::model::SuggestionSeverity;

#[derive(Parser)]
#[command(
    name = "querylens",
    version,
    about = "Find the N+1 queries, missing indexes and other database problems in what your app actually sends.",
    after_help = "Run it in your project: the database is found in DATABASE_URL, .env files or config/config.json.\n\n\
        Examples:\n  \
        querylens init                            # Node.js: add the SDK, then just run your app\n  \
        querylens capture -- npm test             # run your tests through QueryLens, get the report\n  \
        querylens capture -- npm run dev          # use the app, press Ctrl+C for the report\n  \
        querylens check -- npm test               # CI: fail when the tests introduce a new problem"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Set up a Node.js project: install the SDK and add one line to your app.
    Init(InitArgs),
    /// Record what an application sends to PostgreSQL, then report problems and fixes.
    Capture(CaptureArgs),
    /// Capture a command (your tests) and fail if it introduces problems not in the baseline.
    Check(CheckArgs),
    /// Print the report of a past capture.
    Report(ReportArgs),
    /// List recent captures.
    Captures,
    /// Run the MCP server that gives coding agents QueryLens's tools (stdio).
    Mcp(McpArgs),
}

#[derive(Args)]
struct InitArgs {
    /// The file that starts your app (default: detected from package.json).
    #[arg(long, value_name = "FILE")]
    entry: Option<PathBuf>,
    /// Only add the line; don't run the package manager.
    #[arg(long)]
    no_install: bool,
    /// Show what would change, without changing anything.
    #[arg(long)]
    dry_run: bool,
    /// What to install (a version, a path or a tarball of querylens-node).
    #[arg(long, value_name = "SPEC", default_value = init::PACKAGE, hide = true)]
    package: String,
}

#[derive(Args)]
struct DbArgs {
    /// The real database: a postgres:// URL or a saved connection name.
    /// Default: found in DATABASE_URL, .env files or config/config.json.
    #[arg(long, short = 'd', value_name = "URL|NAME")]
    db: Option<String>,
}

#[derive(Args)]
struct ProxyArgs {
    /// More environment variables holding the database URL, to point at the proxy.
    /// (DATABASE_URL and the variables the database was found in are handled already.)
    #[arg(long = "env", value_name = "NAME")]
    env: Vec<String>,
    /// Extra variables for the command, with {url}, {host} and {port} for the proxy (e.g. DB_PORT={port}).
    #[arg(long = "set", value_name = "KEY=VALUE")]
    set: Vec<String>,
    /// Don't preload the QueryLens SDK into Node.js processes the command starts.
    #[arg(long)]
    no_sdk: bool,
    /// A name for the capture.
    #[arg(long)]
    name: Option<String>,
}

#[derive(Clone, Copy, ValueEnum)]
enum Plans {
    /// Don't re-plan statements.
    Off,
    /// Planner estimates only; nothing is executed again.
    Explain,
    /// Run SELECTs once more (read-only, rolled back) for real timings.
    Profile,
}

#[derive(Args)]
struct AnalysisArgs {
    /// Re-plan the flagged and most expensive statements on the database.
    #[arg(long, value_enum, default_value_t = Plans::Explain)]
    plans: Plans,
    /// Executions in a row that count as a loop (N+1).
    #[arg(long, default_value_t = 5)]
    loop_min: u32,
    /// Statements slower than this are flagged, ms.
    #[arg(long, default_value_t = 100.0)]
    slow_ms: f64,
}

impl AnalysisArgs {
    fn options(&self) -> ReportOptions {
        ReportOptions {
            thresholds: Thresholds { loop_min: self.loop_min.max(2), slow_ms: self.slow_ms, ..Thresholds::default() },
            plans: match self.plans {
                Plans::Off => PlanDepth::Off,
                Plans::Explain => PlanDepth::Explain,
                Plans::Profile => PlanDepth::Profile,
            },
            ..ReportOptions::default()
        }
    }
}

#[derive(Args)]
struct CaptureArgs {
    #[command(flatten)]
    db: DbArgs,
    /// Address the proxy listens on. Default: 127.0.0.1:6543, or a free port if it's taken.
    #[arg(long)]
    listen: Option<SocketAddr>,
    #[command(flatten)]
    proxy: ProxyArgs,
    #[command(flatten)]
    analysis: AnalysisArgs,
    /// Where to write the full report (.md or .json).
    #[arg(long, short = 'o', value_name = "FILE", default_value = ".querylens/report.md")]
    report: PathBuf,
    /// The command to run against the proxy. Without one, capture until Ctrl+C.
    #[arg(last = true, value_name = "COMMAND")]
    command: Vec<String>,
}

#[derive(Clone, Copy, ValueEnum)]
enum FailOn {
    High,
    Medium,
    Low,
}

#[derive(Args)]
struct CheckArgs {
    #[command(flatten)]
    db: DbArgs,
    /// Address the proxy listens on. Default: a free port.
    #[arg(long)]
    listen: Option<SocketAddr>,
    #[command(flatten)]
    proxy: ProxyArgs,
    #[command(flatten)]
    analysis: AnalysisArgs,
    /// Accepted findings. Commit it; update it with --update-baseline.
    #[arg(long, default_value = ".querylens/baseline.json")]
    baseline: PathBuf,
    /// Accept the current findings: write them to the baseline and pass.
    #[arg(long)]
    update_baseline: bool,
    /// Lowest severity of a new finding that fails the check.
    #[arg(long, value_enum, default_value_t = FailOn::Medium)]
    fail_on: FailOn,
    /// Where to write the full report (.md or .json).
    #[arg(long, short = 'o', value_name = "FILE", default_value = ".querylens/report.md")]
    report: PathBuf,
    /// The command to run, typically your test suite.
    #[arg(last = true, required = true, value_name = "COMMAND")]
    command: Vec<String>,
}

impl CheckArgs {
    fn fail_on(&self) -> SuggestionSeverity {
        match self.fail_on {
            FailOn::High => SuggestionSeverity::High,
            FailOn::Medium => SuggestionSeverity::Medium,
            FailOn::Low => SuggestionSeverity::Low,
        }
    }
}

#[derive(Args)]
struct ReportArgs {
    /// Capture id, or "latest".
    #[arg(default_value = "latest")]
    id: String,
    /// Print JSON instead of Markdown.
    #[arg(long)]
    json: bool,
    /// Rebuild the report (re-planning on this database) instead of printing the stored one.
    #[command(flatten)]
    db: DbArgs,
    #[command(flatten)]
    analysis: AnalysisArgs,
}

#[derive(Args)]
struct McpArgs {
    /// The database the tools work on: a saved connection name/id or a postgres:// URL.
    /// Default: $DATABASE_URL.
    #[arg(long, alias = "db", value_name = "URL|NAME")]
    connection: Option<String>,
}

const SUBCOMMANDS: &[&str] = &["init", "capture", "check", "report", "captures", "mcp", "help", "--help", "-h", "--version", "-V"];

/// Run the CLI if `args` ask for it. `None` = no subcommand: start the desktop app.
pub fn main(args: &[String]) -> Option<i32> {
    let first = args.get(1).map(String::as_str);
    // Kept for the Claude Code provider, which launches `querylens --mcp --connection <id>`.
    if first == Some("--mcp") {
        return Some(crate::mcp::run_from_args(args));
    }
    match first {
        Some(cmd) if SUBCOMMANDS.contains(&cmd) => {}
        _ if cfg!(feature = "gui") => return None,
        _ => {}
    }
    // The MCP server talks over stdio pipes; a console would only get in the way.
    if first != Some("mcp") {
        console::attach();
    }
    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(e) => {
            let _ = e.print();
            return Some(if e.use_stderr() { 2 } else { 0 });
        }
    };
    Some(commands::run(cli.command))
}
