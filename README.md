# HoloCubic CLI

[![Node CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-node.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-node.yml)
[![Python CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-python.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-python.yml)
[![Rust CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-rust.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-rust.yml)
[![Bootstrap conformance](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-conformance.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-conformance.yml)

Cross-language command-line clients for the HoloCubic DevTools HTTP API.
The Node.js package is the reference implementation; Python and Rust are
smaller experiments that currently implement the same read-only bootstrap
handshake.

> The DevTools API currently has no authentication. Connect only over a
> trusted local network and do not expose the device HTTP service publicly.

## Implementations

| Node.js | Python | Rust |
| --- | --- | --- |
| **Reference · beta candidate** | **Bootstrap experiment** | **Bootstrap experiment** |
| Package: `@princival/holocubic-cli` | Package: `holocubic-cli-python` | Crate: `holocubic-cli-rust` |
| Command: `cubic` | Command: `cubic-py` | Command: `cubic-rs` |
| Full device, SD-card, DevRun, and app workflow | Version and read-only `info` | Version and read-only `info` |
| [Details](implementations/node/README.md) | [Details](implementations/python/README.md) | [Details](implementations/rust/README.md) |

Python and Rust are intentionally not feature-equivalent to Node.js yet. Use
`cubic` for file transfer, file management, DevRun, and app installation.

## Remote installation from registries

The registry names are declared in the manifests but the first releases have
not been published yet. These commands become available after publication.

### Node.js / npm

Requires Node.js 22.12 or newer. The beta release uses the `beta` dist-tag:

```sh
npm install --global @princival/holocubic-cli@beta
cubic --version
```

### Python / PyPI

Requires Python 3.10 or newer. `--pre` opts in to the `0.1.0a1` pre-release:

```sh
python -m pip install --pre holocubic-cli-python
cubic-py --version
```

### Rust / crates.io

Requires Rust 1.85 or newer. Pin the initial alpha version explicitly:

```sh
cargo install holocubic-cli-rust --version 0.1.0-alpha.1 --locked
cubic-rs --version
```

## Local installation from source

Clone the monorepo once:

```sh
git clone https://github.com/Tim-1e/holocubic-cli.git
cd holocubic-cli
```

### Node.js

```sh
cd implementations/node
npm ci
npm run check
npm link
cubic --version
```

`npm link` exposes the local build as the global `cubic` command. Run
`npm unlink --global @princival/holocubic-cli` to remove the link.

### Python

```sh
cd implementations/python
python -m venv .venv
```

Activate the environment, then install the package in editable mode:

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

### Rust

```sh
cd implementations/rust
cargo test --locked
cargo install --path . --locked
cubic-rs --version
```

Run `cargo uninstall holocubic-cli-rust` to remove the locally installed
binary.

## Three functional modules per implementation

### Node.js reference implementation

1. **Device connection** — saved device profiles, `--host`, `CUBIC_HOST`,
   health checks, capability discovery, JSON output, and stable exit codes.
2. **SD-card filesystem** — list, inspect, read, create, rename, remove, and
   recursively upload or download files and directories with safety limits.
3. **Developer workflow** — read/save/run DevRun code and list/install/remove
   SD-card apps.

Example:

```sh
cubic device add desk 192.168.3.26
cubic info
cubic ls /sd/apps
cubic push ./my-app /sd/apps/my-app
```

### Python bootstrap experiment

1. **CLI shell** — `cubic-py --version`, `--host`, `--json`, and `info`.
2. **HTTP client** — read-only `GET /devtools/api/info` with normalized output
   and request error handling.
3. **URL validation** — accepts a device host or DevTools URL and safely
   derives the API base URL.

Example:

```sh
cubic-py --host 192.168.3.26 --json info
```

### Rust bootstrap experiment

1. **CLI shell** — `cubic-rs --version`, `--host`, `--json`, and `info`.
2. **HTTP client** — typed read-only bootstrap request and stable JSON output.
3. **URL validation** — shared host/URL normalization behavior verified by the
   cross-language compatibility fixture.

Example:

```sh
cubic-rs --host 192.168.3.26 --json info
```

## Shared contract and CI

The deployed API contract is documented in [`spec/api-v1.md`](spec/api-v1.md).
The first shared black-box slice is documented in
[`spec/cli-bootstrap-v1.md`](spec/cli-bootstrap-v1.md).

| Workflow | Matrix / responsibility |
| --- | --- |
| Node CI | Windows, Ubuntu, macOS × Node.js 22 and 24: 6 jobs |
| Python CI | Windows, Ubuntu, macOS × Python 3.10 and 3.13: 6 jobs |
| Rust CI | Windows, Ubuntu, macOS × stable Rust: 3 jobs |
| Bootstrap conformance | One Linux job compares all three CLIs against the same fixture |

The four badges at the top report workflow-level status. They represent three
implementation test suites plus one cross-language compatibility gate.

## Publishing the three packages

Registry versions are immutable. Confirm the package name and version before
running the final upload command, and bump the version before every later
release.

### Publish Node.js to npm

The package is already configured as a public scoped package. For a first
manual beta publication:

```sh
cd implementations/node
npm ci
npm run check
npm pack --dry-run
npm login
npm whoami
npm publish --access public --tag beta --provenance=false
```

The explicit `--provenance=false` is for a local manual publish; provenance in
`package.json` is intended for a GitHub Actions OIDC release. After the first
release, prefer npm Trusted Publishing from a tag-triggered workflow and keep
the `beta` tag until the package is ready to become `latest`.

Configure the npm Trusted Publisher with these exact values:

| Field | Value |
| --- | --- |
| Package | `@princival/holocubic-cli` |
| Provider | GitHub Actions |
| Organization or user | `Tim-1e` |
| Repository | `holocubic-cli` |
| Workflow filename | `publish-node.yml` |
| Environment name | `npm` |
| Allowed action | `npm publish` |

The workflow accepts only a tag equal to `node-v<package.json version>`. It
derives `beta`, `alpha`, or another pre-release channel from the version and
uses `latest` only for a stable version.

### Publish Python to PyPI

Before publishing, remove `Private :: Do Not Upload` from
`implementations/python/pyproject.toml`. Then build and test the distributions:

```sh
cd implementations/python
python -m pip install --upgrade build twine
python -m pip install --editable .
python -m unittest discover -s tests -v
python -m build
python -m twine check dist/*
```

TestPyPI and production PyPI use separate accounts and credentials:

```sh
python -m twine upload --repository testpypi dist/*
python -m twine upload dist/*
```

For later releases, prefer PyPI Trusted Publishing from GitHub Actions instead
of storing a long-lived API token.

### Publish Rust to crates.io

Before publishing, remove `publish = false` from
`implementations/rust/Cargo.toml`. The first release must be published manually:

```sh
cd implementations/rust
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
cargo package --locked
cargo publish --dry-run --locked
cargo login
cargo publish --locked
```

After the first crate exists, crates.io Trusted Publishing can be connected to
a GitHub Actions release workflow for short-lived OIDC credentials.
