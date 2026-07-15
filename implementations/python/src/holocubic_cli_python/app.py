"""Local HoloCubic app validation."""

import os
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .errors import CubicError, UsageError
from .remote_path import remote_join


@dataclass(frozen=True)
class ValidatedApp:
    source: Path
    id: str
    destination: str
    entry: str

    def public(self) -> dict[str, str]:
        return {
            "source": str(self.source),
            "id": self.id,
            "destination": self.destination,
            "entry": self.entry,
        }


def validate_app_id(value: str) -> str:
    app_id = value.strip()
    if (
        not app_id
        or app_id in {".", ".."}
        or app_id.startswith(".cubic-")
        or "/" in app_id
        or "\\" in app_id
        or any(ord(character) < 32 for character in app_id)
    ):
        raise UsageError(f"Invalid app id: {value}")
    remote_join("/sd/apps", app_id)
    return app_id


def _require_file(file_path: Path, label: str) -> None:
    try:
        if file_path.is_symlink() or not file_path.is_file():
            raise OSError("not a regular file")
    except OSError as error:
        raise CubicError(
            f"App {label} is missing or is not a regular file: {file_path}",
            code="INVALID_APP",
        ) from error


def validate_app_directory(
    directory: str | Path, requested_id: str | None = None
) -> ValidatedApp:
    source = Path(os.path.abspath(os.fspath(directory)))
    if source.is_symlink() or not source.is_dir():
        raise CubicError(
            f"App source is not a regular directory: {source}", code="INVALID_APP"
        )
    info_path = source / "app.info"
    _require_file(info_path, "metadata")
    try:
        info = info_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise CubicError(
            f"Unable to read app metadata: {info_path}", code="INVALID_APP"
        ) from error
    match = re.search(r"^\s*entry\s*=\s*(.+?)\s*$", info, flags=re.MULTILINE)
    entry = match.group(1).strip() if match else "main.lua"
    pure_entry = PurePosixPath(entry)
    if (
        not entry
        or pure_entry.is_absolute()
        or ".." in pure_entry.parts
        or "\\" in entry
    ):
        raise CubicError(
            f"app.info declares an unsafe entry: {entry}", code="INVALID_APP"
        )
    _require_file(source.joinpath(*pure_entry.parts), "entry")
    _require_file(source / "main.lua", "main.lua")
    app_id = validate_app_id(requested_id if requested_id is not None else source.name)
    return ValidatedApp(source, app_id, remote_join("/sd/apps", app_id), entry)
