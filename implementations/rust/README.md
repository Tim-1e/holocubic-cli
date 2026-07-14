# HoloCubic CLI — Rust experiment

This crate is an experimental Rust implementation of the shared HoloCubic CLI
bootstrap contract. It currently supports version output and the read-only
device handshake; use the Node.js implementation for file and app operations.

`publish = false` intentionally prevents accidental crates.io publication while
the crate name and release policy are under review.

```sh
cargo run -- --version
cargo run -- --host 192.0.2.42 --json info
```

Development checks:

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo package
```
