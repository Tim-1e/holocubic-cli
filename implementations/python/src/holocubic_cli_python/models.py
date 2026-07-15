"""Typed public models for the HoloCubic DevTools API."""

from dataclasses import dataclass, field
from typing import Any


LEGACY_V1_CAPABILITIES = (
    "fs.list",
    "fs.stat",
    "fs.read",
    "fs.write",
    "fs.mkdir",
    "fs.rename",
    "fs.remove",
    "fs.rmdir",
    "apps.list",
    "devrun.read",
    "devrun.save",
    "devrun.run",
)


@dataclass(frozen=True)
class DeviceInfo:
    api_version: int
    version: str | None
    route_base: str
    root_path: str
    chunk_size: int
    max_file_size: int
    max_code_bytes: int
    run_app_id: str
    run_app_main: str
    capabilities: tuple[str, ...]
    raw: dict[str, Any] = field(repr=False)


@dataclass(frozen=True)
class RemoteEntry:
    name: str
    path: str
    size: int
    is_dir: bool
    ext: str
    mime: str
    category: str

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": self.path,
            "size": self.size,
            "isDir": self.is_dir,
            "ext": self.ext,
            "mime": self.mime,
            "category": self.category,
        }


@dataclass(frozen=True)
class ListResult:
    path: str
    parent: str
    dir_count: int
    file_count: int
    total_bytes: int
    items: tuple[RemoteEntry, ...]

    def public(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "parent": self.parent,
            "dirCount": self.dir_count,
            "fileCount": self.file_count,
            "totalBytes": self.total_bytes,
            "items": [item.public() for item in self.items],
        }


@dataclass(frozen=True)
class RemoteStat:
    path: str
    name: str
    parent: str
    size: int
    is_dir: bool
    ext: str
    mime: str
    category: str

    def public(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "name": self.name,
            "parent": self.parent,
            "size": self.size,
            "isDir": self.is_dir,
            "ext": self.ext,
            "mime": self.mime,
            "category": self.category,
        }


@dataclass(frozen=True)
class ReadChunk:
    data: bytes
    size: int
    next_offset: int
    eof: bool
    name: str
    mime: str


@dataclass(frozen=True)
class UploadResult:
    path: str
    next_offset: int
    total: int
    done: bool
    size: int


@dataclass(frozen=True)
class AppsResult:
    apps: tuple[dict[str, Any], ...]
    current_app_id: str | None
    run_app_id: str
    run_app_main: str

    def public(self) -> dict[str, Any]:
        return {
            "apps": list(self.apps),
            "currentAppId": self.current_app_id,
            "runAppId": self.run_app_id,
            "runAppMain": self.run_app_main,
        }


@dataclass(frozen=True)
class DevRunResult:
    id: str
    entry: str
    bytes: int
    launched: bool
    rescan_requested: bool

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "entry": self.entry,
            "bytes": self.bytes,
            "launched": self.launched,
            "rescanRequested": self.rescan_requested,
        }


@dataclass(frozen=True)
class TransferLimits:
    max_depth: int = 32
    max_entries: int = 4096
    max_download_bytes: int = 128 * 1024 * 1024


@dataclass(frozen=True)
class TransferSummary:
    source: str
    destination: str
    files: int
    directories: int
    bytes: int

    def public(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "destination": self.destination,
            "files": self.files,
            "directories": self.directories,
            "bytes": self.bytes,
        }
