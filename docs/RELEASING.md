# Releasing HoloCubic CLI packages

This is a maintainer guide. Registry versions are immutable: confirm the exact
package name and version before every final upload, and bump the version before
every later release. Never recreate or move a published version tag.

## Node.js to npm

The public package is `@princival/holocubic-cli` and uses npm Trusted
Publishing. Prepare and verify the release commit before creating a tag that
exactly matches `node-v<package.json version>`:

```sh
cd implementations/node
npm ci
npm run check
npm pack --dry-run
```

After confirming the version in `package.json`, create and push its tag. For
example, version `0.2.0` must use:

```sh
git tag node-v0.2.0
git push origin node-v0.2.0
```

The tag starts `.github/workflows/publish-node.yml`. The workflow rejects a tag
that differs from `package.json`, derives alpha/beta/prerelease dist-tags from
the version, uses `latest` only for a stable version, and publishes provenance
without an `NPM_TOKEN` secret.

Configure npm Trusted Publishing with these exact values:

| Field | Value |
| --- | --- |
| Package | `@princival/holocubic-cli` |
| Provider | GitHub Actions |
| Organization or user | `Tim-1e` |
| Repository | `holocubic-cli` |
| Workflow filename | `publish-node.yml` |
| Environment name | `npm` |
| Allowed action | `npm publish` |

## Python to PyPI

Confirm the name and version in `implementations/python/pyproject.toml`, then
build and inspect both distributions:

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

Verify installation in a clean virtual environment after each upload. For
later releases, add PyPI Trusted Publishing through GitHub Actions instead of
storing a long-lived API token.

## Rust to crates.io

The first release is intentionally blocked by `publish = false` in
`implementations/rust/Cargo.toml`. Remove that field only in the reviewed first
release commit, then run:

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

Verify `cargo install holocubic-cli-rust --version <version> --locked` from a
clean Cargo home. After the first crate exists, connect crates.io Trusted
Publishing to a GitHub Actions release workflow for short-lived OIDC
credentials.
