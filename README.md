# HoloCubic CLI

This repository contains cross-language command-line clients for the HoloCubic
DevTools HTTP API.

## Implementations

| Implementation | Status | Package | Command |
| --- | --- | --- | --- |
| [Node.js](implementations/node) | Beta candidate | `@tim-1e/holocubic-cli` | `cubic` |
| Python | Planned experiment | Not published | `cubic-py` |
| Rust | Planned experiment | Not published | `cubic-rs` |

Node.js is the current reference implementation. Python and Rust builds will
be evaluated against the same API and CLI compatibility contract before they
are considered stable.

## Shared contract

The deployed firmware API and compatibility rules are documented in
[`spec/api-v1.md`](spec/api-v1.md). Implementations may use different internal
designs, but filesystem safety, HTTP behavior, JSON output, and exit-code
semantics should remain compatible.

## Node.js quick start

```sh
cd implementations/node
npm install
npm run check
npm link
cubic device add desk 192.0.2.42
cubic info
```

The DevTools API currently has no authentication. Only connect over a trusted
local network.
