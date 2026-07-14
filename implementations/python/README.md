# HoloCubic CLI — Python experiment

This package is an experimental Python implementation of the shared HoloCubic
CLI bootstrap contract. It currently supports version output and the read-only
device handshake; use the Node.js implementation for file and app operations.

The `Private :: Do Not Upload` classifier intentionally prevents accidental
PyPI publication while the package name and release policy are under review.

```sh
python -m pip install .
cubic-py --version
cubic-py --host 192.0.2.42 --json info
```

Development checks:

```sh
python -m unittest discover -s tests -v
python -m build
```
