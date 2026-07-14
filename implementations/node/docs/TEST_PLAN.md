# Cubic CLI v0.1 Test Plan

This document is the release gate for the first npm CLI release. A checked item
must be backed by an automated test or a recorded manual/E2E result. Publishing
to npm is deliberately outside this plan.

## 1. API contract and connection

- [ ] Accept a bare IPv4 address, host name, or full HTTP URL and normalize it
  to one `/devtools` base URL.
- [ ] Reject unsupported schemes, embedded credentials, query strings, and
  fragments.
- [ ] Handshake with `GET /devtools/api/info` and validate the response.
- [ ] Accept the deployed legacy info response that has no explicit
  `api_version` or `capabilities` fields, deriving API v1 capabilities safely.
- [ ] Prefer explicit server capabilities when a future firmware returns them.
- [ ] Turn timeouts, connection failures, non-2xx responses, and malformed JSON
  into stable, readable CLI errors without leaking request data.
- [ ] Resolve the target in this order: `--host`, `CUBIC_HOST`, selected stored
  device.

## 2. Device configuration

- [ ] Add a named device only after a successful handshake.
- [ ] List devices and identify the selected device.
- [ ] Select and remove devices.
- [ ] Store configuration atomically in the platform config directory, with
  `CUBIC_CONFIG` available for tests and automation.
- [ ] Preserve Unicode device names and reject empty/reserved names.
- [ ] Support both human-readable and `--json` output.

## 3. Remote path safety

- [ ] Normalize `/`, repeated separators, `.` segments, and Windows slashes.
- [ ] Resolve relative paths below `/sd`.
- [ ] Reject paths that escape `/sd`, NUL characters, and deletion of `/sd`.
- [ ] Encode spaces, Unicode, `#`, `%`, and other query characters correctly.
- [ ] Refuse malicious directory entries that would escape the local download
  destination.

## 4. Low-level file API

- [ ] Cover `info`, `list`, `stat`, `read`, `mkdir`, `rename`, `upload`,
  `remove`, `rmdir`, `apps`, `code/read`, `code/save`, and `code/run` with a
  mock DevTools server.
- [ ] Read binary chunks using `x-file-size`, `x-next-offset`, and `x-eof`.
- [ ] Upload binary chunks with correct `offset` and `total` values.
- [ ] Parse the device JSON error body and retain the HTTP status.
- [ ] Treat a missing path as a typed not-found result only where expected.

## 5. Upload and recursive upload

- [ ] Upload empty, text, Unicode-name, and binary files.
- [ ] Split files according to the server-provided chunk size.
- [ ] Reject files larger than the server-provided maximum before writing.
- [ ] Upload into a temporary sibling, verify remote size, then commit by
  rename so an interrupted transfer does not leave a partial target.
- [ ] Refuse overwrites by default; `--force` replaces files deliberately.
- [ ] Recursively create directories, including empty directories.
- [ ] Do not follow local symbolic links.
- [ ] Enforce maximum depth 32 and maximum entries 4096 before remote writes.
- [ ] Retry transient chunk failures with bounded backoff and clean temporary
  remote files after a terminal failure.

## 6. Download and recursive download

- [ ] Download empty, text, Unicode-name, and binary files without corruption.
- [ ] Resume the read loop using server offsets until EOF.
- [ ] Write to a local temporary sibling and rename only after size validation.
- [ ] Refuse overwrites by default; `--force` replaces files deliberately.
- [ ] Recursively download directories and preserve empty directories.
- [ ] Enforce maximum depth 32, maximum entries 4096, and a default aggregate
  safety limit of 128 MiB.
- [ ] Remove local temporary files after a failed transfer.
- [ ] Verify a downloaded test tree byte-for-byte against its source.

## 7. CLI behavior and destructive operations

- [ ] Provide `device add/list/use/remove`, `ping`, `info`, `ls`, `stat`, `cat`,
  `push`/`upload`, `pull`/`download`, `mkdir`, `mv`, and `rm`.
- [ ] Require `rm -r --yes` for recursive directory deletion.
- [ ] Reject `rm /sd` even when all force flags are supplied.
- [ ] Send progress to stderr so stdout remains machine-readable.
- [ ] Use exit code 0 for success, 1 for runtime/device errors, and 2 for CLI
  usage errors.
- [ ] Support quiet automation and stable JSON output.

## 8. DevRun and app workflows

- [ ] Read, save, and run DevRun source through the dedicated endpoints.
- [ ] Reject DevRun source larger than the advertised/default 192 KiB limit.
- [ ] List installed apps through `/api/apps`.
- [ ] Install an app directory under `/sd/apps/<id>` after validating
  `app.info` and `main.lua`.
- [ ] Refuse to overwrite an installed app unless `--force` is provided.
- [ ] Do not claim general app launch/rescan support until the firmware exposes
  those capabilities.

## 9. Real-device E2E

- [ ] Handshake with the HoloCubic at the configured LAN address.
- [ ] Create an isolated `/sd/cubic-cli-e2e-*` directory.
- [ ] Upload a nested tree containing empty, text, Unicode-name, and binary
  files.
- [ ] List/stat the uploaded data and compare downloaded hashes locally.
- [ ] Rename a remote file, delete a file, then recursively delete the test
  directory.
- [ ] Back up, test, and byte-for-byte restore DevRun if the run/save endpoint is
  exercised.
- [ ] Leave no E2E files on the SD card after either success or failure.

## 10. Platform and package gates

- [ ] Run type checking, unit tests, integration tests, build, and package
  inspection on Windows with a supported Node LTS.
- [ ] Run the same built artifact and tests in a clean Linux environment
  (native/WSL or an official Node Docker image).
- [ ] Configure GitHub Actions for Node 22 and 24 on Windows, Ubuntu, and macOS.
- [ ] Verify the built `dist/cli.js` keeps its executable shebang.
- [ ] Run `npm pack --dry-run` and confirm the tarball contains only intended
  files and no local device configuration or secrets.
- [ ] Install the generated tarball into a clean temporary prefix and run
  `cubic --version` and `cubic --help`.
- [ ] Complete `docs/RELEASE_CHECKLIST.md`; stop before `npm publish`.
