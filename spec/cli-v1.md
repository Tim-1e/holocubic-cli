# CLI compatibility contract v1

This contract defines the shared black-box behavior of the Node.js, Python,
and Rust HoloCubic CLIs. The executable names differ, but command names,
arguments, JSON fields, safety rules, and exit status semantics are compatible.

## Executables and target resolution

| Implementation | Executable |
| --- | --- |
| Node.js | `cubic` |
| Python | `cubic-py` |
| Rust | `cubic-rs` |

All implementations support `--version`, `-H/--host`, `--timeout`, `--json`,
`--quiet`, and `--config`. A target is resolved in this order:

1. `--host`;
2. `CUBIC_HOST`;
3. the selected profile in the configuration file.

`CUBIC_CONFIG` overrides the default configuration path. Host names and URLs
are normalized according to [`api-v1.md`](api-v1.md).

## Commands

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

`--json` writes one stable JSON object to stdout and suppresses progress
output. `cat` is binary output and therefore rejects `--json`.

## Filesystem and transfer safety

- Remote paths are confined to `/sd`; deleting `/sd` itself is rejected.
- Recursive directory deletion requires both `--recursive` and `--yes`.
- Uploads reject symbolic links and non-file/non-directory entries.
- Downloads reject unsafe or inconsistent paths returned by a device.
- Recursive depth defaults to 32 entries deep and the tree entry limit
  defaults to 4096.
- Aggregate directory downloads default to a 128 MiB limit.
- File chunks use device-advertised limits and retry transient failures.
- Transfers write a temporary sibling, verify it, and rename it into place.
  Existing targets require `--force` and are backed up during commit.
- Empty directories and arbitrary file bytes survive a recursive round trip.

## Developer workflows

DevRun commands read, save, and launch only the dedicated DevRun source. App
installation validates `app.info`, `main.lua`, and the configured entry before
upload. The currently running app and the reserved DevRun app cannot be
replaced or removed through generic app commands.

## Exit status

| Code | Meaning |
| --- | --- |
| `0` | Success, help, or version output |
| `1` | Device, HTTP, response, transfer, or local I/O failure |
| `2` | Invalid arguments or a rejected destructive operation |

## Conformance coverage

`tools/conformance.py` runs every implementation against the same
filesystem-backed mock device and verifies target configuration, binary and
recursive file round trips, empty directories, rename/delete safeguards,
DevRun, app installation/removal, JSON output, and exit codes.

| Implementation | CLI v1 | Full filesystem v1 |
| --- | --- | --- |
| Node.js | Yes | Yes |
| Python | Yes | Yes |
| Rust | Yes | Yes |
