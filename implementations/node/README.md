# Cubic CLI

`cubic` is a cross-platform command-line client for the HoloCubic DevTools
HTTP API. Version 0.1 focuses on Wi-Fi device configuration, safe SD-card file
operations, recursive transfer, DevRun, and app installation.

> Pre-release status: this package uses the npm `beta` dist-tag while its first
> public releases are validated.

This is the Node.js reference implementation in the multi-language
[`holocubic-cli`](../..) repository.

## Requirements

- Node.js 22.12 or newer
- HoloCubic with the `/devtools/api` service running
- The computer and device on the same trusted network

## Installation

After the package is published:

```sh
npm install --global @princival/holocubic-cli@beta
```

Before publication, development builds can be linked locally:

```sh
cd implementations/node
npm install
npm run build
npm link
```

Then configure and test a device:

```sh
cubic device add desk 192.0.2.42
cubic info
cubic ls /sd/apps
```

## Local development

```sh
npm install
npm run check
node dist/cli.js --help
```

The complete release gate is documented in
[`docs/TEST_PLAN.md`](docs/TEST_PLAN.md).

## Command overview

```text
cubic device add <name> <host>
cubic device list|use|remove
cubic ping
cubic info
cubic ls [remote]
cubic stat <remote>
cubic cat <remote>
cubic push|upload <local> [remote]
cubic pull|download <remote> [local]
cubic mkdir <remote>
cubic mv <source> <target>
cubic rm [-r --yes] <remote>
cubic devrun read|save|run
cubic app list|install|remove
```

The optional destination argument is the exact target path. Directory
transfers are committed through a temporary sibling. Existing targets are not
replaced unless `--force` is supplied.

Target resolution order is `--host`, `CUBIC_HOST`, then the selected device in
the config file. Use `CUBIC_CONFIG` to place the config elsewhere in CI.

The current device API has no authentication. Use the CLI only on a trusted
LAN and do not expose the DevTools HTTP service to the public internet.

The default HTTP timeout is 60 seconds because SD-card writes on the ESP32 can
take noticeably longer than metadata requests. It can be changed per command
with `--timeout <milliseconds>`.
