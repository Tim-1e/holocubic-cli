# HoloCubic CLI 🧊⌨️

[![English](https://img.shields.io/badge/README-English-4C9AFF?style=for-the-badge&logo=github)](README.md)
[![简体中文](https://img.shields.io/badge/README-简体中文-F06292?style=for-the-badge&logo=github)](README.zh-CN.md)

## Part of the HoloCubic ecosystem

| 🧊 Firmware & device | 🧩 App ecosystem | ⌨️ CLI companion |
| --- | --- | --- |
| **[clocteck/holocubic-nes-esp32](https://github.com/clocteck/holocubic-nes-esp32)** | **[clocteck/holocubic-apps](https://github.com/clocteck/holocubic-apps)** | **[Tim-1e/holocubic-cli](https://github.com/Tim-1e/holocubic-cli)** |
| Upstream firmware and DevTools | Upstream HoloCubic applications | Cross-platform device automation |
| Official upstream repository | Official upstream repository | Community companion · you are here ✨ |

HoloCubic CLI is a community companion project for the two upstream HoloCubic
repositories above. It does not replace the firmware or app collection; it
makes their DevTools workflow scriptable from Windows, Linux, and macOS.

[![npm](https://img.shields.io/npm/v/%40princival%2Fholocubic-cli?label=npm&color=CB3837)](https://www.npmjs.com/package/@princival/holocubic-cli)
[![PyPI](https://img.shields.io/pypi/v/holocubic-cli-python?label=PyPI&color=3775A9)](https://pypi.org/project/holocubic-cli-python/)
[![crates.io](https://img.shields.io/crates/v/holocubic-cli-rust?label=crates.io&color=DEA584)](https://crates.io/crates/holocubic-cli-rust)
[![License](https://img.shields.io/github/license/Tim-1e/holocubic-cli)](LICENSE)

[![Node CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-node.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-node.yml)
[![Python CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-python.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-python.yml)
[![Rust CI](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-rust.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-rust.yml)
[![Full CLI conformance](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-conformance.yml/badge.svg?branch=main)](https://github.com/Tim-1e/holocubic-cli/actions/workflows/ci-conformance.yml)

HoloCubic CLI provides three stable, cross-platform command-line clients for
the HoloCubic DevTools HTTP API. Choose the runtime you already use; all three
implementations expose the same device, SD-card, DevRun, and app workflows.

> [!WARNING]
> The current DevTools API has no authentication. Use it only on a trusted
> local network and never expose the device HTTP service to the public internet.

## Stable packages

| Node.js | Python | Rust |
| --- | --- | --- |
| **Reference · stable** | **Compatible · stable** | **Compatible · stable** |
| Package: [`@princival/holocubic-cli`](https://www.npmjs.com/package/@princival/holocubic-cli) | Package: [`holocubic-cli-python`](https://pypi.org/project/holocubic-cli-python/) | Crate: [`holocubic-cli-rust`](https://crates.io/crates/holocubic-cli-rust) |
| Command: `cubic` | Command: `cubic-py` | Command: `cubic-rs` |
| Node.js 22.12+ | Python 3.10+ | Rust 1.85+ |
| [Implementation details](implementations/node/README.md) | [Implementation details](implementations/python/README.md) | [Implementation details](implementations/rust/README.md) |

All three packages are released as version `0.1.0`.

## Installation

Install one implementation. You do not need all three.

### Node.js / npm

```sh
npm install --global @princival/holocubic-cli
cubic --version
```

### Python / PyPI

```sh
python -m pip install holocubic-cli-python
cubic-py --version
```

With uv, the CLI can be installed as an isolated tool:

```sh
uv tool install holocubic-cli-python
cubic-py --version
```

### Rust / crates.io

```sh
cargo install holocubic-cli-rust --version 0.1.0 --locked
cubic-rs --version
```

## Quick start

The examples use `cubic`. Substitute `cubic-py` or `cubic-rs` when using the
Python or Rust package.

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

## Built for developers and agents

- **Developers** can manage SD-card files and apps directly from a terminal,
  automate repeated deployment steps, and keep device profiles locally.
- **Scripts and CI** can select a device explicitly, isolate configuration with
  `CUBIC_CONFIG`, consume `--json` output, and rely on meaningful exit codes.
- **AI agents** can install any of the three packages and invoke the CLI as a
  controlled subprocess instead of reproducing the DevTools HTTP protocol.

A machine-friendly session can begin with read-only discovery:

```sh
cubic --host 192.168.3.26 --json ping
cubic --host 192.168.3.26 --json info
cubic --host 192.168.3.26 --json ls /sd/apps
```

Agents should prefer explicit hosts and JSON output, inspect before mutating,
and preserve the CLI's `--force`, `--recursive`, and `--yes` safeguards.

## What it can do

| Module | Capabilities |
| --- | --- |
| 🔌 Device connection | Saved profiles, temporary hosts, ping, capability discovery, and JSON output |
| 💾 SD-card filesystem | List, inspect, read, create, rename, delete, and recursive upload/download |
| 🛠️ Developer workflow | DevRun read/save/run plus app list/install/remove |

All implementations support the same command surface:

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

## Source installation

```sh
git clone https://github.com/Tim-1e/holocubic-cli.git
cd holocubic-cli
```

Then use the development instructions in the relevant implementation README:

- [Node.js](implementations/node/README.md)
- [Python](implementations/python/README.md)
- [Rust](implementations/rust/README.md)

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
exit codes. Maintainer release procedures are documented in
[`docs/RELEASING.md`](docs/RELEASING.md).

## Support the project 💙

If this companion makes your HoloCubic workflow easier, please use it, share
it with other HoloCubic users, and give the repository a ⭐. Issues and focused
pull requests are welcome.

Released under the [MIT License](LICENSE).
