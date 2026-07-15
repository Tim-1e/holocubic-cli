"""Remote and local path confinement helpers."""

import os
import posixpath
from pathlib import Path, PurePosixPath

from .errors import UsageError


REMOTE_ROOT = "/sd"


def _reject_nul(value: str) -> None:
    if "\0" in value:
        raise UsageError("Remote path contains an invalid NUL character.")


def normalize_remote_path(value: str | None, root: str = REMOTE_ROOT) -> str:
    candidate_value = (value or "").strip()
    _reject_nul(candidate_value)
    unix = candidate_value.replace("\\", "/")
    candidate = unix if unix.startswith("/") else posixpath.join(root, unix or ".")
    normalized = posixpath.normpath(candidate)
    if normalized != root and not normalized.startswith(f"{root}/"):
        raise UsageError(f"Remote path must stay below {root}: {value or ''}")
    return normalized


def remote_join(parent: str, name: str) -> str:
    _reject_nul(name)
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise UsageError(f"Invalid remote entry name: {name}")
    return normalize_remote_path(posixpath.join(normalize_remote_path(parent), name))


def remote_basename(remote_path: str) -> str:
    normalized = normalize_remote_path(remote_path)
    return "sd" if normalized == REMOTE_ROOT else posixpath.basename(normalized)


def assert_can_delete_remote(remote_path: str) -> None:
    if normalize_remote_path(remote_path) == REMOTE_ROOT:
        raise UsageError(f"Refusing to delete {REMOTE_ROOT}.")


def safe_local_destination(root: str | Path, relative_path: str) -> Path:
    _reject_nul(relative_path)
    normalized = relative_path.replace("\\", "/")
    pure = PurePosixPath(normalized)
    if pure.is_absolute() or ".." in pure.parts:
        raise UsageError(f"Download entry escapes destination: {relative_path}")
    resolved_root = Path(root).resolve()
    resolved = (resolved_root / Path(*pure.parts)).resolve()
    try:
        common = os.path.commonpath((resolved_root, resolved))
    except ValueError as error:
        raise UsageError(
            f"Download entry escapes destination: {relative_path}"
        ) from error
    if Path(common) != resolved_root:
        raise UsageError(f"Download entry escapes destination: {relative_path}")
    return resolved
