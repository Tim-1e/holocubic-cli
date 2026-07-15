use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use clap::{ArgAction, Args, Parser, Subcommand};
use holocubic_cli_rust::app::{validate_app_directory, validate_app_id};
use holocubic_cli_rust::client::{CubicClient, public_info};
use holocubic_cli_rust::config::{
    ConfigStore, DeviceProfile, ResolvedDevice, resolve_device, validate_device_name,
};
use holocubic_cli_rust::error::{CubicError, Result};
use holocubic_cli_rust::model::TransferLimits;
use holocubic_cli_rust::remote_path::{
    assert_can_delete_remote, normalize_remote_path, remote_join,
};
use holocubic_cli_rust::transfer::{
    TransferProgress, download_path, ensure_remote_directory, upload_path,
};
use holocubic_cli_rust::url::normalize_device_url;
use serde::Serialize;
use serde_json::{Value, json};

fn positive_usize(value: &str) -> std::result::Result<usize, String> {
    value
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "must be a positive integer".into())
}

fn positive_u64(value: &str) -> std::result::Result<u64, String> {
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "must be a positive integer".into())
}

#[derive(Parser)]
#[command(
    name = "cubic-rs",
    version,
    about = "Manage HoloCubic DevTools devices and SD-card files"
)]
struct Cli {
    /// Use a device without changing saved configuration.
    #[arg(short = 'H', long, global = true)]
    host: Option<String>,

    /// HTTP timeout in milliseconds.
    #[arg(
        long,
        global = true,
        default_value_t = 60_000,
        value_parser = positive_u64,
        value_name = "MILLISECONDS"
    )]
    timeout: u64,

    /// Write stable JSON to stdout.
    #[arg(long, global = true)]
    json: bool,

    /// Suppress progress and success messages.
    #[arg(long, global = true)]
    quiet: bool,

    /// Override the configuration file.
    #[arg(long, global = true)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Manage saved devices.
    Device {
        #[command(subcommand)]
        command: DeviceCommand,
    },
    /// Test the selected device.
    Ping,
    /// Show device capabilities and transfer limits.
    Info,
    /// List a remote directory.
    Ls { remote: Option<String> },
    /// Show remote file or directory metadata.
    Stat { remote: String },
    /// Write a remote file to stdout.
    Cat { remote: String },
    /// Create a remote directory and missing parents.
    Mkdir { remote: String },
    /// Rename or move a remote path.
    Mv { source: String, target: String },
    /// Remove a remote file or directory.
    Rm {
        remote: String,
        #[arg(short = 'r', long)]
        recursive: bool,
        #[arg(short = 'y', long)]
        yes: bool,
    },
    /// Upload a file or directory recursively.
    #[command(alias = "upload")]
    Push {
        local: PathBuf,
        remote: Option<String>,
        #[command(flatten)]
        transfer: TransferArgs,
    },
    /// Download a file or directory recursively.
    #[command(alias = "download")]
    Pull {
        remote: String,
        local: Option<PathBuf>,
        #[command(flatten)]
        transfer: DownloadArgs,
    },
    /// Read, save, or run DevRun source.
    Devrun {
        #[command(subcommand)]
        command: DevRunCommand,
    },
    /// List and install SD-card apps.
    App {
        #[command(subcommand)]
        command: AppCommand,
    },
}

#[derive(Subcommand)]
enum DeviceCommand {
    /// Verify and save a device.
    Add {
        name: String,
        host: String,
        #[arg(long = "no-use", action = ArgAction::SetFalse, default_value_t = true)]
        use_device: bool,
    },
    /// List saved devices.
    List,
    /// Select a saved device.
    Use { name: String },
    /// Remove a saved device.
    Remove { name: String },
}

#[derive(Args, Clone, Copy)]
struct TransferArgs {
    /// Replace an existing target.
    #[arg(short = 'f', long)]
    force: bool,
    /// Retry transient chunk failures.
    #[arg(long, default_value_t = 2, value_parser = positive_usize)]
    retries: usize,
    /// Recursive depth limit.
    #[arg(long, default_value_t = 32, value_parser = positive_usize)]
    max_depth: usize,
    /// Recursive entry limit.
    #[arg(long, default_value_t = 4096, value_parser = positive_usize)]
    max_entries: usize,
}

#[derive(Args, Clone, Copy)]
struct DownloadArgs {
    #[command(flatten)]
    transfer: TransferArgs,
    /// Aggregate directory download limit.
    #[arg(long, default_value_t = 128 * 1024 * 1024, value_parser = positive_u64)]
    max_bytes: u64,
}

#[derive(Subcommand)]
enum DevRunCommand {
    /// Read DevRun source.
    Read {
        output: Option<PathBuf>,
        #[arg(short = 'f', long)]
        force: bool,
    },
    /// Save DevRun source.
    Save { file: PathBuf },
    /// Save and run DevRun source.
    Run { file: PathBuf },
}

#[derive(Subcommand)]
enum AppCommand {
    /// List installed apps.
    List,
    /// Validate and upload an app directory.
    Install {
        directory: PathBuf,
        #[arg(long)]
        id: Option<String>,
        #[arg(short = 'f', long)]
        force: bool,
    },
    /// Remove an installed app directory.
    Remove {
        id: String,
        #[arg(short = 'y', long, required = true, action = ArgAction::SetTrue)]
        yes: bool,
    },
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn json_value(value: &impl Serialize) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| {
        CubicError::new(
            format!("Unable to serialize output: {error}"),
            "OUTPUT_ERROR",
        )
    })
}

struct Target {
    client: CubicClient,
    name: Option<String>,
    url: String,
}

struct Runtime<'a> {
    cli: &'a Cli,
    store: ConfigStore,
}

impl<'a> Runtime<'a> {
    fn new(cli: &'a Cli) -> Result<Self> {
        Ok(Self {
            cli,
            store: ConfigStore::new(cli.config.clone())?,
        })
    }

    fn target(&self) -> Result<Target> {
        let ResolvedDevice { url, name } = resolve_device(&self.store, self.cli.host.as_deref())?;
        Ok(Target {
            client: CubicClient::new(&url, self.cli.timeout)?,
            name,
            url,
        })
    }

    fn output(&self, value: Value, human: impl IntoIterator<Item = String>) -> Result<()> {
        if self.cli.json {
            println!(
                "{}",
                serde_json::to_string(&value).map_err(|error| {
                    CubicError::new(
                        format!("Unable to serialize output: {error}"),
                        "OUTPUT_ERROR",
                    )
                })?
            );
        } else if !self.cli.quiet {
            for line in human {
                println!("{line}");
            }
        }
        Ok(())
    }

    fn progress(&self, event: &TransferProgress) {
        if self.cli.json || self.cli.quiet {
            return;
        }
        if event.phase == "scan" {
            eprintln!("Scanning {} ...", event.path);
            return;
        }
        if event.phase == "commit" || event.transferred_bytes == event.total_bytes {
            let total = if event.total_bytes == 0 {
                String::new()
            } else {
                format!(" / {}", format_bytes(event.total_bytes))
            };
            eprintln!(
                "{:<8} {}{}  {}",
                event.phase,
                format_bytes(event.transferred_bytes),
                total,
                event.path
            );
        }
    }

    fn execute(&self) -> Result<()> {
        match &self.cli.command {
            Commands::Device { command } => self.device(command),
            Commands::Ping => {
                let target = self.target()?;
                let started = Instant::now();
                let info = target.client.info(true)?;
                let latency = started.elapsed().as_millis() as u64;
                let display_target = target.name.as_deref().unwrap_or(&target.url);
                let version_suffix = info
                    .version
                    .as_ref()
                    .map(|version| format!(" ({version})"))
                    .unwrap_or_default();
                self.output(
                    json!({
                        "ok": true,
                        "name": target.name,
                        "url": target.url,
                        "latency_ms": latency,
                        "version": info.version,
                    }),
                    [format!(
                        "Connected to {display_target} in {latency} ms{version_suffix}."
                    )],
                )
            }
            Commands::Info => {
                let target = self.target()?;
                let info = target.client.info(true)?;
                self.output(
                    public_info(&info, &target.url, target.name.as_deref()),
                    [
                        format!(
                            "Device:       {}",
                            target.name.as_deref().unwrap_or("(temporary)")
                        ),
                        format!("URL:          {}", target.url),
                        format!(
                            "Version:      {}",
                            info.version.as_deref().unwrap_or("unknown")
                        ),
                        format!("API:          v{}", info.api_version),
                        format!("Root:         {}", info.root_path),
                        format!("Chunk size:   {}", format_bytes(info.chunk_size)),
                        format!("Max file:     {}", format_bytes(info.max_file_size)),
                        format!("Capabilities: {}", info.capabilities.join(", ")),
                    ],
                )
            }
            Commands::Ls { remote } => {
                let target = self.target()?;
                let result = target
                    .client
                    .list(&normalize_remote_path(remote.as_deref())?)?;
                let lines = result
                    .items
                    .iter()
                    .map(|item| {
                        format!(
                            "{} {:>10}  {}{}",
                            if item.is_dir { "d" } else { "-" },
                            if item.is_dir {
                                String::new()
                            } else {
                                item.size.to_string()
                            },
                            item.name,
                            if item.is_dir { "/" } else { "" }
                        )
                    })
                    .collect::<Vec<_>>();
                self.output(json_value(&result)?, lines)
            }
            Commands::Stat { remote } => {
                let target = self.target()?;
                let result = target.client.stat(remote)?;
                self.output(
                    json_value(&result)?,
                    [
                        format!("Path: {}", result.path),
                        format!("Type: {}", if result.is_dir { "directory" } else { "file" }),
                        format!("Size: {} bytes", result.size),
                        format!("MIME: {}", result.mime),
                    ],
                )
            }
            Commands::Cat { remote } => self.cat(remote),
            Commands::Mkdir { remote } => {
                let target = self.target()?;
                let remote = normalize_remote_path(Some(remote))?;
                ensure_remote_directory(&target.client, &remote)?;
                self.output(json!({ "path": remote }), [format!("Created {remote}")])
            }
            Commands::Mv { source, target } => {
                let device = self.target()?;
                let source = normalize_remote_path(Some(source))?;
                let target = normalize_remote_path(Some(target))?;
                device.client.rename(&source, &target)?;
                self.output(
                    json!({ "source": source, "target": target }),
                    [format!("Moved {source} -> {target}")],
                )
            }
            Commands::Rm {
                remote,
                recursive,
                yes,
            } => self.remove(remote, *recursive, *yes),
            Commands::Push {
                local,
                remote,
                transfer,
            } => {
                let target = self.target()?;
                let progress = |event: &TransferProgress| self.progress(event);
                let result = upload_path(
                    &target.client,
                    local,
                    remote.as_deref(),
                    transfer.force,
                    transfer.retries,
                    TransferLimits {
                        max_depth: transfer.max_depth,
                        max_entries: transfer.max_entries,
                        ..TransferLimits::default()
                    },
                    Some(&progress),
                )?;
                self.output(
                    json_value(&result)?,
                    [format!(
                        "Uploaded {} file(s), {} -> {}",
                        result.files,
                        format_bytes(result.bytes),
                        result.destination
                    )],
                )
            }
            Commands::Pull {
                remote,
                local,
                transfer,
            } => {
                let target = self.target()?;
                let progress = |event: &TransferProgress| self.progress(event);
                let result = download_path(
                    &target.client,
                    remote,
                    local.as_deref(),
                    transfer.transfer.force,
                    transfer.transfer.retries,
                    TransferLimits {
                        max_depth: transfer.transfer.max_depth,
                        max_entries: transfer.transfer.max_entries,
                        max_download_bytes: transfer.max_bytes,
                    },
                    Some(&progress),
                )?;
                self.output(
                    json_value(&result)?,
                    [format!(
                        "Downloaded {} file(s), {} -> {}",
                        result.files,
                        format_bytes(result.bytes),
                        result.destination
                    )],
                )
            }
            Commands::Devrun { command } => self.devrun(command),
            Commands::App { command } => self.app(command),
        }
    }

    fn device(&self, command: &DeviceCommand) -> Result<()> {
        match command {
            DeviceCommand::Add {
                name,
                host,
                use_device,
            } => {
                let name = validate_device_name(name)?;
                let url = normalize_device_url(host)?;
                let info = CubicClient::new(&url, self.cli.timeout)?.info(true)?;
                let mut config = self.store.read()?;
                config.devices.insert(
                    name.clone(),
                    DeviceProfile {
                        url: url.clone(),
                        version: info.version.clone(),
                    },
                );
                if *use_device {
                    config.current = Some(name.clone());
                }
                let selected = config.current.as_deref() == Some(&name);
                self.store.write(&config)?;
                let mut lines = vec![format!("Added {name}: {url}")];
                if selected {
                    lines.push(format!("Selected device: {name}"));
                }
                self.output(
                    json!({
                        "name": name,
                        "url": url,
                        "selected": selected,
                        "version": info.version,
                    }),
                    lines,
                )
            }
            DeviceCommand::List => {
                let config = self.store.read()?;
                let devices = config
                    .devices
                    .iter()
                    .map(|(name, profile)| {
                        json!({
                            "name": name,
                            "url": profile.url,
                            "version": profile.version,
                            "selected": config.current.as_deref() == Some(name),
                        })
                    })
                    .collect::<Vec<_>>();
                let lines = if devices.is_empty() {
                    vec!["No saved devices.".into()]
                } else {
                    devices
                        .iter()
                        .map(|row| {
                            format!(
                                "{} {:<16} {}{}",
                                if row["selected"].as_bool() == Some(true) {
                                    "*"
                                } else {
                                    " "
                                },
                                row["name"].as_str().unwrap_or_default(),
                                row["url"].as_str().unwrap_or_default(),
                                row["version"]
                                    .as_str()
                                    .map(|version| format!("  {version}"))
                                    .unwrap_or_default()
                            )
                        })
                        .collect()
                };
                self.output(
                    json!({ "current": config.current, "devices": devices }),
                    lines,
                )
            }
            DeviceCommand::Use { name } => {
                let name = validate_device_name(name)?;
                let mut config = self.store.read()?;
                if !config.devices.contains_key(&name) {
                    return Err(CubicError::new(
                        format!("Unknown device: {name}"),
                        "NO_DEVICE",
                    ));
                }
                config.current = Some(name.clone());
                self.store.write(&config)?;
                self.output(
                    json!({ "current": name }),
                    [format!("Selected device: {name}")],
                )
            }
            DeviceCommand::Remove { name } => {
                let name = validate_device_name(name)?;
                let mut config = self.store.read()?;
                if config.devices.remove(&name).is_none() {
                    return Err(CubicError::new(
                        format!("Unknown device: {name}"),
                        "NO_DEVICE",
                    ));
                }
                if config.current.as_deref() == Some(&name) {
                    config.current = None;
                }
                self.store.write(&config)?;
                self.output(
                    json!({ "removed": name, "current": config.current }),
                    [format!("Removed device: {name}")],
                )
            }
        }
    }

    fn cat(&self, remote: &str) -> Result<()> {
        if self.cli.json {
            return Err(CubicError::usage("`cat` cannot be combined with --json."));
        }
        let target = self.target()?;
        let remote = normalize_remote_path(Some(remote))?;
        let item = target.client.stat(&remote)?;
        if item.is_dir {
            return Err(CubicError::new(
                format!("Remote source is a directory: {remote}"),
                "NOT_A_FILE",
            ));
        }
        let info = target.client.info(false)?;
        let stdout = io::stdout();
        let mut writer = stdout.lock();
        let mut offset = 0;
        while offset < item.size {
            let chunk =
                target
                    .client
                    .read(&remote, offset, info.chunk_size.min(item.size - offset))?;
            if chunk.next_offset != offset + chunk.bytes.len() as u64 || chunk.bytes.is_empty() {
                return Err(CubicError::new(
                    format!("Device returned an invalid read offset for {remote}."),
                    "INVALID_RESPONSE",
                ));
            }
            writer.write_all(&chunk.bytes).map_err(|error| {
                CubicError::new(format!("Unable to write stdout: {error}"), "OUTPUT_ERROR")
            })?;
            offset = chunk.next_offset;
        }
        Ok(())
    }

    fn remove(&self, remote: &str, recursive: bool, yes: bool) -> Result<()> {
        let target = self.target()?;
        let remote = normalize_remote_path(Some(remote))?;
        assert_can_delete_remote(&remote)?;
        let item = target.client.stat(&remote)?;
        if item.is_dir {
            if !recursive {
                return Err(CubicError::usage(format!(
                    "Remote path is a directory; use --recursive: {remote}"
                )));
            }
            if !yes {
                return Err(CubicError::usage("Recursive deletion requires --yes."));
            }
            target.client.rmdir(&remote, true)?;
        } else {
            target.client.remove(&remote)?;
        }
        self.output(
            json!({ "removed": remote, "recursive": item.is_dir }),
            [format!("Removed {remote}")],
        )
    }

    fn devrun(&self, command: &DevRunCommand) -> Result<()> {
        let target = self.target()?;
        match command {
            DevRunCommand::Read { output, force } => {
                let source = target.client.read_devrun()?;
                let Some(output) = output else {
                    if self.cli.json {
                        return self.output(json!({ "source": source }), []);
                    }
                    print!("{source}");
                    return Ok(());
                };
                let output = holocubic_cli_rust::config::absolute_path(output)?;
                let mut options = OpenOptions::new();
                options.write(true);
                if *force {
                    options.create(true).truncate(true);
                } else {
                    options.create_new(true);
                }
                let mut file = options.open(&output).map_err(|error| {
                    if error.kind() == io::ErrorKind::AlreadyExists {
                        CubicError::new(
                            format!(
                                "Local target already exists: {}. Use --force to replace it.",
                                output.display()
                            ),
                            "TARGET_EXISTS",
                        )
                    } else {
                        CubicError::new(
                            format!("Unable to write {}: {error}", output.display()),
                            "LOCAL_WRITE_ERROR",
                        )
                    }
                })?;
                file.write_all(source.as_bytes()).map_err(|error| {
                    CubicError::new(
                        format!("Unable to write {}: {error}", output.display()),
                        "LOCAL_WRITE_ERROR",
                    )
                })?;
                self.output(
                    json!({ "path": output.to_string_lossy(), "bytes": source.len() }),
                    [format!("Saved DevRun source to {}", output.display())],
                )
            }
            DevRunCommand::Save { file } | DevRunCommand::Run { file } => {
                let file = holocubic_cli_rust::config::absolute_path(file)?;
                let source = fs::read_to_string(&file).map_err(|error| {
                    CubicError::new(
                        format!("Unable to read {}: {error}", file.display()),
                        "LOCAL_READ_ERROR",
                    )
                })?;
                let run = matches!(command, DevRunCommand::Run { .. });
                let result = target.client.save_devrun(&source, run)?;
                self.output(
                    json_value(&result)?,
                    [format!(
                        "{} {} ({} bytes)",
                        if run { "Ran" } else { "Saved" },
                        result.entry,
                        result.bytes
                    )],
                )
            }
        }
    }

    fn app(&self, command: &AppCommand) -> Result<()> {
        let target = self.target()?;
        match command {
            AppCommand::List => {
                let result = target.client.apps()?;
                let lines = result
                    .apps
                    .iter()
                    .map(|item| {
                        let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
                        format!(
                            "{}{}",
                            id,
                            if result.current_app_id.as_deref() == Some(id) {
                                " *"
                            } else {
                                ""
                            }
                        )
                    })
                    .collect::<Vec<_>>();
                self.output(json_value(&result)?, lines)
            }
            AppCommand::Install {
                directory,
                id,
                force,
            } => {
                let validated = validate_app_directory(directory, id.as_deref())?;
                let apps = target.client.apps()?;
                if validated.id == apps.run_app_id {
                    return Err(CubicError::usage(format!(
                        "Refusing to replace {}; use the dedicated devrun commands.",
                        apps.run_app_id
                    )));
                }
                if apps.current_app_id.as_deref() == Some(&validated.id) {
                    return Err(CubicError::usage(format!(
                        "Refusing to replace the currently running app {}; switch apps first.",
                        validated.id
                    )));
                }
                let progress = |event: &TransferProgress| self.progress(event);
                let transfer = upload_path(
                    &target.client,
                    PathBuf::from(&validated.source).as_path(),
                    Some(&validated.destination),
                    *force,
                    2,
                    TransferLimits::default(),
                    Some(&progress),
                )?;
                self.output(
                    json!({
                        "source": validated.source,
                        "id": validated.id,
                        "destination": validated.destination,
                        "entry": validated.entry,
                        "transfer": transfer,
                        "rescanRequired": true,
                    }),
                    [
                        format!("Installed {} -> {}", validated.id, validated.destination),
                        "Rescan apps on the device before first launch.".into(),
                    ],
                )
            }
            AppCommand::Remove { id, yes: _ } => {
                let id = validate_app_id(id)?;
                let remote = remote_join("/sd/apps", &id)?;
                let apps = target.client.apps()?;
                if id == apps.run_app_id {
                    return Err(CubicError::usage(format!(
                        "Refusing to remove {}; it is managed by the dedicated devrun commands.",
                        apps.run_app_id
                    )));
                }
                if apps.current_app_id.as_deref() == Some(&id) {
                    return Err(CubicError::usage(format!(
                        "Refusing to remove the currently running app {id}; switch apps first."
                    )));
                }
                target.client.rmdir(&remote, true)?;
                self.output(
                    json!({ "removed": id, "path": remote }),
                    [format!("Removed app {id}")],
                )
            }
        }
    }
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            let code = error.exit_code();
            let _ = error.print();
            return ExitCode::from(code as u8);
        }
    };
    match Runtime::new(&cli).and_then(|runtime| runtime.execute()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cubic-rs: {error}");
            ExitCode::from(error.exit_code)
        }
    }
}
