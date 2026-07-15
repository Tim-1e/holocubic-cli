# HoloCubic CLI

[![Node CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-node.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-node.yml)
[![Python CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-python.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-python.yml)
[![Rust CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-rust.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-rust.yml)
[![Full CLI conformance](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-conformance.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-conformance.yml)

Cross-platform command-line clients for the HoloCubic DevTools HTTP API. All
three implementations expose the same device, SD-card, DevRun, and app
workflows; Node.js remains the stable reference package.

> The current DevTools API has no authentication. Use it only on a trusted
> local network and never expose the device HTTP service to the public internet.

## Implementations

| Node.js | Python | Rust |
| --- | --- | --- |
| **Reference · stable** | **Compatible · alpha** | **Compatible · alpha** |
| Package: `@princival/holocubic-cli` | Package: `holocubic-cli-python` | Crate: `holocubic-cli-rust` |
| Command: `cubic` | Command: `cubic-py` | Command: `cubic-rs` |
| npm: published | PyPI: not published yet | crates.io: not published yet |
| [Details](implementations/node/README.md) | [Details](implementations/python/README.md) | [Details](implementations/rust/README.md) |

## Installation

The stable npm package requires Node.js 22.12 or newer:

```sh
npm install --global @princival/holocubic-cli
cubic --version
```

Python and Rust currently install from source. Their future registry commands
will be `python -m pip install --pre holocubic-cli-python` and
`cargo install holocubic-cli-rust --version 0.1.0-alpha.1 --locked` after the
first PyPI and crates.io releases exist.

Clone the monorepo once for a source installation:

```sh
git clone https://github.com/Tim-1e/holocubic-cli.git
cd holocubic-cli
```

### Node.js from source

```sh
cd implementations/node
npm ci
npm run check
npm link
cubic --version
```

### Python from source

```sh
cd implementations/python
python -m venv .venv
```

Activate the environment, then install in editable mode:

```powershell
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
python -m pip install --editable .
cubic-py --version
```

```sh
# Linux and macOS
. .venv/bin/activate
python -m pip install --editable .
cubic-py --version
```

### Rust from source

```sh
cd implementations/rust
cargo test --locked
cargo install --path . --locked
cubic-rs --version
```

## Quick start

The examples use `cubic`. Substitute `cubic-py` or `cubic-rs` to use another
implementation.

```sh
cubic device add desk 192.168.3.26
cubic ping
cubic info
cubic ls /sd/apps
cubic push ./my-app /sd/apps/my-app
cubic pull /sd/apps/my-app ./my-app-backup
```

One-off access does not change saved configuration:

```sh
cubic --host 192.168.3.26 --json info
```

Target resolution order is `--host`, `CUBIC_HOST`, then the selected saved
device. `CUBIC_CONFIG` can isolate the configuration file in scripts and CI.

## Shared functional modules

| Module | Node.js | Python | Rust |
| --- | --- | --- | --- |
| Device connection | Saved profiles, temporary host, ping, capability discovery, JSON | Same | Same |
| SD-card filesystem | List, inspect, read, create, rename, delete, recursive upload/download | Same | Same |
| Developer workflow | DevRun read/save/run and app list/install/remove | Same | Same |

All implementations support this command surface:

```text
device add|list|use|remove
ping
info
ls [remote]
stat <remote>
cat <remote>
mkdir <remote>
mv <source> <target>
rm [-r --yes] <remote>
push|upload <local> [remote]
pull|download <remote> [local]
devrun read|save|run
app list|install|remove
```

Directory transfers preserve empty directories and arbitrary binary data.
They enforce depth, entry-count, and download-size limits, reject symbolic
links, and commit through temporary siblings. Existing targets require
`--force`; recursive deletion requires `--recursive --yes`.

## Contract, tests, and CI

The device API is documented in [`spec/api-v1.md`](spec/api-v1.md), and shared
CLI behavior is defined in [`spec/cli-v1.md`](spec/cli-v1.md).

| Workflow | Matrix / responsibility |
| --- | --- |
| Node CI | Windows, Ubuntu, macOS × Node.js 22 and 24: 6 jobs |
| Python CI | Windows, Ubuntu, macOS × Python 3.10 and 3.13: 6 jobs |
| Rust CI | Windows, Ubuntu, macOS × stable Rust: 3 jobs |
| Full CLI conformance | One Linux job runs all three CLIs against the same mock device |

The conformance gate covers saved devices, recursive binary and empty-folder
round trips, rename/delete safeguards, DevRun, app workflows, JSON output, and
exit codes.

## Maintainer releases

Registry credentials, OIDC settings, immutable-version checks, tags, and
first-release steps belong in the maintainer guide rather than the project
homepage. See [`docs/RELEASING.md`](docs/RELEASING.md).
