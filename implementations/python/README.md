# HoloCubic CLI — Python

`cubic-py` is the Python implementation of the shared HoloCubic CLI v1
contract. It supports the same device configuration, SD-card filesystem,
recursive transfer, DevRun, and app workflows as the Node.js reference.

The package requires Python 3.10 or newer. It is source-ready but has not been
published to PyPI yet.

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
python -m ruff check src tests
python -m ruff format --check src tests
python -m unittest discover -s tests -v
python -m build
python -m pip install .
cubic-py --version
```

The API and CLI contracts live in [`../../spec`](../../spec).
