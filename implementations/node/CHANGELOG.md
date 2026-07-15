# Changelog

## 0.1.0 - 2026-07-15

- Publish the first stable npm release as `@princival/holocubic-cli` with the
  `latest` dist-tag.
- Ship the complete device, SD-card, recursive transfer, DevRun, and app
  management command set validated against real HoloCubic hardware.
- Publish from GitHub Actions through npm Trusted Publishing and short-lived
  OIDC credentials, with automatic provenance.

## 0.1.0-beta.2 - 2026-07-15 (release candidate; not published)

- Prepare the npm package as `@princival/holocubic-cli`.
- Keep package source metadata linked to `Tim-1e/holocubic-cli` for npm
  provenance verification.
- Add a tag-gated GitHub Actions release workflow using npm Trusted Publishing
  and short-lived OIDC credentials.

## 0.1.0-beta.1 - 2026-07-15

- Add named Wi-Fi device configuration and API v1 capability negotiation.
- Add safe SD-card list, stat, cat, mkdir, move, and delete commands.
- Add chunked file and recursive directory upload/download with temporary-path
  commits, retries, progress, overwrite protection, and traversal limits.
- Add DevRun read/save/run commands.
- Add validated app list/install/remove workflows with running-app and DevRun
  protection.
- Add JSON/quiet automation modes and stable exit codes.
- Add Windows and Linux package verification plus a Windows/Ubuntu/macOS GitHub
  Actions matrix.
