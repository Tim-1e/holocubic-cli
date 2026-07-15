# HoloCubic CLI — Python

`cubic-py` is the Python implementation of the shared HoloCubic CLI v1
contract. It supports the same device configuration, SD-card filesystem,
recursive transfer, DevRun, and app workflows as the Node.js reference.

The package requires Python 3.10 or newer. Stable version `0.1.0` is published
on [`PyPI`](https://pypi.org/project/holocubic-cli-python/).

## Installation

```sh
python -m pip install holocubic-cli-python
cubic-py --version
```

Alternatively, install it as an isolated uv tool:

```sh
uv tool install holocubic-cli-python
cubic-py --version
```

## Installation from source

```sh
python -m venv .venv
python -m pip install --editable .
cubic-py --version
```

Activate `.venv` first if you want `cubic-py` available only inside the virtual
environment. Connect and inspect a device with:

```sh
cubic-py device add desk 192.168.3.26
cubic-py info
cubic-py ls /sd/apps
cubic-py push ./my-app /sd/apps/my-app
```

## Command overview

```text
cubic-py device add|list|use|remove
cubic-py ping|info
cubic-py ls|stat|cat|mkdir|mv|rm
cubic-py push|upload
cubic-py pull|download
cubic-py devrun read|save|run
cubic-py app list|install|remove
```

Use `--host` for one-off access, `--json` for scripts, and `--help` on a command
for its transfer limits and safety options.

## Development checks

```sh
uv sync --locked
uvx ruff check src tests
uvx ruff format --check src tests
uv run --locked python -m unittest discover -s tests -v
uv build --clear --no-sources
```

The API and CLI contracts live in the repository's
[`spec`](https://github.com/Tim-1e/holocubic-cli/tree/main/spec) directory.
