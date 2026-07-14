use std::env;
use std::process::ExitCode;
use std::time::Duration;

use clap::error::ErrorKind;
use clap::{CommandFactory, Parser, Subcommand};
use holocubic_cli_rust::{normalize_device_url, public_info};
use serde_json::Value;
use ureq::Agent;

#[derive(Parser)]
#[command(name = "cubic-rs", version, about = "Experimental Rust HoloCubic CLI")]
struct Cli {
    #[arg(long, global = true)]
    host: Option<String>,
    #[arg(
        long,
        global = true,
        default_value_t = 60_000,
        value_name = "MILLISECONDS"
    )]
    timeout: u64,
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Show device capabilities and transfer limits.
    Info,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let host = cli
        .host
        .or_else(|| env::var("CUBIC_HOST").ok())
        .unwrap_or_else(|| {
            Cli::command()
                .error(
                    ErrorKind::MissingRequiredArgument,
                    "a device target is required through --host or CUBIC_HOST",
                )
                .exit()
        });

    match run(&cli.command, &host, cli.timeout, cli.json) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cubic-rs: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(command: &Commands, host: &str, timeout_ms: u64, json_output: bool) -> Result<(), String> {
    if timeout_ms == 0 {
        return Err("Timeout must be greater than zero.".into());
    }
    let base_url = normalize_device_url(host)?;
    match command {
        Commands::Info => {
            let config = Agent::config_builder()
                .timeout_global(Some(Duration::from_millis(timeout_ms)))
                .build();
            let agent = Agent::new_with_config(config);
            let mut response = agent
                .get(&format!("{base_url}/api/info"))
                .call()
                .map_err(|error| format!("Could not connect to HoloCubic: {error}"))?;
            let raw: Value = response.body_mut().read_json().map_err(|error| {
                format!("Device returned invalid JSON for GET /api/info: {error}")
            })?;
            let info = public_info(&raw, &base_url)?;
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string(&info).map_err(|error| error.to_string())?
                );
            } else {
                println!("URL:        {}", info["url"].as_str().unwrap_or("unknown"));
                println!(
                    "Version:    {}",
                    info["version"].as_str().unwrap_or("unknown")
                );
                println!("API:        v{}", info["api_version"]);
                println!(
                    "Root:       {}",
                    info["root_path"].as_str().unwrap_or("unknown")
                );
                println!("Chunk size: {} bytes", info["chunk_size"]);
                println!("Max file:   {} bytes", info["max_file_size"]);
            }
        }
    }
    Ok(())
}
