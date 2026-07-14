# CLI bootstrap compatibility v1

This contract is the first cross-language compatibility slice. Passing it does
not imply support for recursive transfer, mutation, DevRun, or app workflows.

Each implementation must provide:

- a unique executable name (`cubic`, `cubic-py`, or `cubic-rs`);
- `--version` with exit code 0;
- `--host <host> --json info` and the `CUBIC_HOST` fallback;
- target URL normalization compatible with `api-v1.md`;
- a validated `GET /devtools/api/info` handshake;
- JSON output with the Node reference implementation's public info fields;
- exit code 0 for success, 1 for connection/response failures, and 2 for usage
  errors.

Current conformance levels:

| Implementation | Bootstrap v1 | Full filesystem v1 |
| --- | --- | --- |
| Node.js | Yes | Yes |
| Python | Experimental | No |
| Rust | Experimental | No |
