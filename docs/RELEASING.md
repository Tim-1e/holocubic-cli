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

The public package is `holocubic-cli-python` and uses PyPI Trusted Publishing.
Confirm the name and version in `implementations/python/pyproject.toml`, then
build and inspect both distributions:

```sh
cd implementations/python
uv sync --locked
uvx ruff check src tests
uvx ruff format --check src tests
uv run --locked python -m unittest discover -s tests -v
uv build --clear --no-sources
uvx twine check dist/*
uv publish --dry-run dist/*
```

Smoke-test the built wheel and source distribution rather than the editable
checkout. For example:

```sh
uv run --isolated --no-project --with dist/*.whl cubic-py --version
uv run --isolated --no-project --with dist/*.tar.gz cubic-py --version
```

After confirming the version, create and push a tag that exactly matches
`python-v<pyproject.toml version>`. For example, version `0.1.0` must use:

```sh
git tag python-v0.1.0
git push origin python-v0.1.0
```

The tag starts `.github/workflows/publish-python.yml`. The workflow rejects a
tag that differs from `pyproject.toml`, repeats the checks above, tests both
distribution formats, and publishes through OIDC without a `PYPI_TOKEN`
secret.

Configure the PyPI Trusted Publisher with these exact values:

| Field | Value |
| --- | --- |
| PyPI project | `holocubic-cli-python` |
| Owner | `Tim-1e` |
| Repository | `holocubic-cli` |
| Workflow filename | `publish-python.yml` |
| Environment name | `pypi` |

For an existing project, add the publisher under `Manage` → `Publishing`. For
a project that has not been created yet, the same values can be registered as
a pending publisher under the account-level `Publishing` page. TestPyPI is a
separate registry and requires its own account, credentials, and trusted
publisher configuration.

## Rust to crates.io

The public crate is `holocubic-cli-rust`, and its installed command is
`cubic-rs`. crates.io requires the first release to use an API token because a
Trusted Publisher can only be attached after the crate exists.

For the initial prerelease, confirm `0.1.0-alpha.1` in `Cargo.toml` and run:

```sh
cd implementations/rust
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo build --release --locked
cargo package --locked
cargo publish --dry-run --locked
cargo login
cargo publish --locked
```

`cargo login` stores the crates.io token in Cargo's credentials file. It is
needed only for the initial manual publication; never add the token to this
repository or a workflow file.

Verify the published artifact from crates.io rather than the source checkout:

```sh
cargo install holocubic-cli-rust --version 0.1.0-alpha.1 --locked --root ./target/registry-smoke
./target/registry-smoke/bin/cubic-rs --version
```

After the first crate exists, configure its crates.io Trusted Publisher with
these exact values:

| Field | Value |
| --- | --- |
| Crate | `holocubic-cli-rust` |
| Platform | GitHub |
| Repository owner | `Tim-1e` |
| Repository name | `holocubic-cli` |
| Workflow filename | `publish-rust.yml` |
| Environment name | `crates-io` |

For later releases, update both `Cargo.toml` and `Cargo.lock`, run all local
checks, commit and push the release change, then create a tag that exactly
matches `rust-v<Cargo.toml version>`. For example, stable version `0.1.0` uses:

```sh
git tag rust-v0.1.0
git push origin rust-v0.1.0
```

The tag starts `.github/workflows/publish-rust.yml`. The workflow rejects a tag
that differs from `Cargo.toml`, repeats formatting, lint, test, release-build,
and package verification, then exchanges GitHub's OIDC identity for a
short-lived crates.io token. No `CARGO_REGISTRY_TOKEN` GitHub secret is used.
