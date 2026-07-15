# HoloCubic CLI — Rust

`cubic-rs` is the Rust implementation of the shared HoloCubic CLI v1 contract.
It supports the same device configuration, SD-card filesystem, recursive
transfer, DevRun, and app workflows as the Node.js reference.

The crate requires Rust 1.85 or newer. Version `0.1.0-alpha.1` is prepared for
the initial crates.io release; until that release exists, install it from
source.

## Installation from source

```sh
cargo install --path . --locked
cubic-rs --version
```

Connect and inspect a device with:

```sh
cubic-rs device add desk 192.168.3.26
cubic-rs info
cubic-rs ls /sd/apps
cubic-rs push ./my-app /sd/apps/my-app
```

## Command overview

```text
cubic-rs device add|list|use|remove
cubic-rs ping|info
cubic-rs ls|stat|cat|mkdir|mv|rm
cubic-rs push|upload
cubic-rs pull|download
cubic-rs devrun read|save|run
cubic-rs app list|install|remove
```

Use `--host` for one-off access, `--json` for scripts, and `--help` on a command
for its transfer limits and safety options.

## Development checks

```sh
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo build --release --locked
cargo package --locked
cargo publish --dry-run --locked
```

After a crates.io release exists, install an exact version with:

```sh
cargo install holocubic-cli-rust --version 0.1.0-alpha.1 --locked
cubic-rs --version
```

The API and CLI contracts live in [`../../spec`](../../spec).
