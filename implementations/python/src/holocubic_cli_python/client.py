"""Validated HoloCubic DevTools API v1 client."""

from typing import Any

from .errors import CubicError, is_not_found
from .models import (
    LEGACY_V1_CAPABILITIES,
    AppsResult,
    DeviceInfo,
    DevRunResult,
    ListResult,
    ReadChunk,
    RemoteEntry,
    RemoteStat,
    UploadResult,
)
from .remote_path import normalize_remote_path
from .transport import HttpTransport


DEFAULT_MAX_CODE_BYTES = 192 * 1024


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CubicError(
            f"Device returned an invalid {label} response.", code="INVALID_RESPONSE"
        )
    return value


def _string(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise CubicError(
            f"Device response is missing {label}.", code="INVALID_RESPONSE"
        )
    return value


def _integer(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise CubicError(
            f"Device response has an invalid {label}.", code="INVALID_RESPONSE"
        )
    return value


def _bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise CubicError(
            f"Device response has an invalid {label}.", code="INVALID_RESPONSE"
        )
    return value


def _lua_array(value: Any, label: str) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and not value:
        return []
    raise CubicError(
        f"Device {label} response is missing a valid array.", code="INVALID_RESPONSE"
    )


def _entry(value: Any) -> RemoteEntry:
    item = _object(value, "directory entry")
    return RemoteEntry(
        name=_string(item.get("name"), "entry.name"),
        path=normalize_remote_path(_string(item.get("path"), "entry.path")),
        size=_integer(item.get("size"), "entry.size"),
        is_dir=_bool(item.get("is_dir"), "entry.is_dir"),
        ext=item.get("ext") if isinstance(item.get("ext"), str) else "",
        mime=item.get("mime")
        if isinstance(item.get("mime"), str)
        else "application/octet-stream",
        category=item.get("category")
        if isinstance(item.get("category"), str)
        else "other",
    )


class CubicClient:
    def __init__(self, base_url: str, timeout_ms: int = 60_000) -> None:
        self.transport = HttpTransport(base_url, timeout_ms)
        self._cached_info: DeviceInfo | None = None

    def info(self, force: bool = False) -> DeviceInfo:
        if self._cached_info is not None and not force:
            return self._cached_info
        raw = _object(self.transport.json("info"), "info")
        if raw.get("ok") is not True:
            raise CubicError(
                "Device handshake did not return ok=true.", code="INVALID_RESPONSE"
            )
        api_version = (
            1
            if raw.get("api_version") is None
            else _integer(raw.get("api_version"), "api_version", 1)
        )
        if api_version > 1:
            raise CubicError(
                f"Unsupported DevTools API version: {api_version}.",
                code="UNSUPPORTED_API",
            )
        root_path = _string(raw.get("root_path"), "root_path")
        if normalize_remote_path(root_path) != "/sd":
            raise CubicError(
                f"Unsupported device root path: {root_path}.", code="INVALID_RESPONSE"
            )
        explicit = raw.get("capabilities")
        capabilities = (
            tuple(item for item in explicit if isinstance(item, str))
            if isinstance(explicit, list)
            else LEGACY_V1_CAPABILITIES
        )
        info = DeviceInfo(
            api_version=api_version,
            version=raw.get("version") if isinstance(raw.get("version"), str) else None,
            route_base=raw.get("route_base")
            if isinstance(raw.get("route_base"), str)
            else "/devtools",
            root_path=root_path,
            chunk_size=_integer(raw.get("chunk_size"), "chunk_size", 1),
            max_file_size=_integer(raw.get("max_file_size"), "max_file_size", 1),
            max_code_bytes=(
                DEFAULT_MAX_CODE_BYTES
                if raw.get("max_code_bytes") is None
                else _integer(raw.get("max_code_bytes"), "max_code_bytes", 1)
            ),
            run_app_id=_string(raw.get("run_app_id"), "run_app_id"),
            run_app_main=normalize_remote_path(
                _string(raw.get("run_app_main"), "run_app_main")
            ),
            capabilities=capabilities,
            raw=raw,
        )
        self._cached_info = info
        return info

    def require_capability(self, capability: str) -> None:
        if capability not in self.info().capabilities:
            raise CubicError(
                f"Device does not support capability {capability}.",
                code="UNSUPPORTED_CAPABILITY",
            )

    def list(self, remote_path: str = "/sd") -> ListResult:
        self.require_capability("fs.list")
        raw = _object(
            self.transport.json(
                "list", query={"path": normalize_remote_path(remote_path)}
            ),
            "list",
        )
        return ListResult(
            path=normalize_remote_path(_string(raw.get("path"), "list.path")),
            parent=normalize_remote_path(_string(raw.get("parent"), "list.parent")),
            dir_count=_integer(raw.get("dir_count"), "list.dir_count"),
            file_count=_integer(raw.get("file_count"), "list.file_count"),
            total_bytes=_integer(raw.get("total_bytes"), "list.total_bytes"),
            items=tuple(
                _entry(item) for item in _lua_array(raw.get("items"), "list.items")
            ),
        )

    def stat(self, remote_path: str) -> RemoteStat:
        self.require_capability("fs.stat")
        raw = _object(
            self.transport.json(
                "stat", query={"path": normalize_remote_path(remote_path)}
            ),
            "stat",
        )
        return RemoteStat(
            path=normalize_remote_path(_string(raw.get("path"), "stat.path")),
            name=_string(raw.get("name"), "stat.name"),
            parent=normalize_remote_path(_string(raw.get("parent"), "stat.parent")),
            size=_integer(raw.get("size"), "stat.size"),
            is_dir=_bool(raw.get("is_dir"), "stat.is_dir"),
            ext=raw.get("ext") if isinstance(raw.get("ext"), str) else "",
            mime=raw.get("mime")
            if isinstance(raw.get("mime"), str)
            else "application/octet-stream",
            category=raw.get("category")
            if isinstance(raw.get("category"), str)
            else "other",
        )

    def stat_or_none(self, remote_path: str) -> RemoteStat | None:
        try:
            return self.stat(remote_path)
        except CubicError as error:
            if is_not_found(error):
                return None
            raise

    def read(self, remote_path: str, offset: int, size: int) -> ReadChunk:
        self.require_capability("fs.read")
        response = self.transport.request(
            "read",
            query={
                "path": normalize_remote_path(remote_path),
                "offset": offset,
                "size": size,
            },
            headers={"Accept": "application/octet-stream"},
        )
        lower_headers = {key.lower(): value for key, value in response.headers.items()}
        try:
            file_size = int(lower_headers["x-file-size"])
            next_offset = int(lower_headers["x-next-offset"])
        except (KeyError, ValueError) as error:
            raise CubicError(
                "Device response has invalid read headers.", code="INVALID_RESPONSE"
            ) from error
        if file_size < 0 or next_offset < 0:
            raise CubicError(
                "Device response has invalid read headers.", code="INVALID_RESPONSE"
            )
        return ReadChunk(
            data=response.body,
            size=file_size,
            next_offset=next_offset,
            eof=lower_headers.get("x-eof") == "1",
            name=lower_headers.get("x-file-name", ""),
            mime=lower_headers.get("content-type", "application/octet-stream"),
        )

    def mkdir(self, remote_path: str) -> None:
        self.require_capability("fs.mkdir")
        self.transport.json(
            "mkdir", method="POST", query={"path": normalize_remote_path(remote_path)}
        )

    def rename(self, source: str, target: str) -> None:
        self.require_capability("fs.rename")
        self.transport.json(
            "rename",
            method="POST",
            query={
                "path": normalize_remote_path(source),
                "new_path": normalize_remote_path(target),
            },
        )

    def upload(
        self, remote_path: str, data: bytes, offset: int, total: int
    ) -> UploadResult:
        self.require_capability("fs.write")
        raw = _object(
            self.transport.json(
                "upload",
                method="PUT",
                query={
                    "path": normalize_remote_path(remote_path),
                    "offset": offset,
                    "total": total,
                },
                body=data,
                headers={"Content-Type": "application/octet-stream"},
            ),
            "upload",
        )
        next_offset = _integer(raw.get("next_offset"), "upload.next_offset")
        return UploadResult(
            path=normalize_remote_path(_string(raw.get("path"), "upload.path")),
            next_offset=next_offset,
            total=_integer(raw.get("total"), "upload.total"),
            done=_bool(raw.get("done"), "upload.done"),
            size=next_offset
            if raw.get("size") is None
            else _integer(raw.get("size"), "upload.size"),
        )

    def remove(self, remote_path: str) -> None:
        self.require_capability("fs.remove")
        self.transport.json(
            "remove",
            method="DELETE",
            query={"path": normalize_remote_path(remote_path)},
        )

    def rmdir(self, remote_path: str, recursive: bool = False) -> None:
        self.require_capability("fs.rmdir")
        self.transport.json(
            "rmdir",
            method="DELETE",
            query={
                "path": normalize_remote_path(remote_path),
                "recursive": 1 if recursive else 0,
            },
        )

    def apps(self) -> AppsResult:
        self.require_capability("apps.list")
        raw = _object(self.transport.json("apps"), "apps")
        apps = tuple(
            item
            for item in _lua_array(raw.get("apps"), "apps.apps")
            if isinstance(item, dict)
        )
        current = (
            raw.get("current_app_id")
            if isinstance(raw.get("current_app_id"), str)
            else None
        )
        return AppsResult(
            apps=apps,
            current_app_id=current,
            run_app_id=_string(raw.get("run_app_id"), "apps.run_app_id"),
            run_app_main=normalize_remote_path(
                _string(raw.get("run_app_main"), "apps.run_app_main")
            ),
        )

    def read_devrun(self) -> str:
        self.require_capability("devrun.read")
        response = self.transport.request("code/read", headers={"Accept": "text/plain"})
        try:
            return response.body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise CubicError(
                "Device returned invalid UTF-8 DevRun source.", code="INVALID_RESPONSE"
            ) from error

    def save_devrun(self, source: str, run: bool = False) -> DevRunResult:
        self.require_capability("devrun.run" if run else "devrun.save")
        encoded = source.encode("utf-8")
        info = self.info()
        if len(encoded) > info.max_code_bytes:
            raise CubicError(
                f"DevRun source is {len(encoded)} bytes; device limit is {info.max_code_bytes} bytes.",
                code="FILE_TOO_LARGE",
            )
        raw = _object(
            self.transport.json(
                "code/run" if run else "code/save",
                method="POST",
                body=encoded,
                headers={"Content-Type": "text/plain; charset=utf-8"},
            ),
            "DevRun",
        )
        return DevRunResult(
            id=_string(raw.get("id"), "DevRun.id"),
            entry=normalize_remote_path(_string(raw.get("entry"), "DevRun.entry")),
            bytes=_integer(raw.get("bytes"), "DevRun.bytes"),
            launched=_bool(raw.get("launched"), "DevRun.launched"),
            rescan_requested=_bool(
                raw.get("rescan_requested"), "DevRun.rescan_requested"
            ),
        )


def public_info(info: DeviceInfo, url: str, name: str | None = None) -> dict[str, Any]:
    return {
        "name": name,
        "url": url,
        "version": info.version,
        "api_version": info.api_version,
        "route_base": info.route_base,
        "root_path": info.root_path,
        "chunk_size": info.chunk_size,
        "max_file_size": info.max_file_size,
        "max_code_bytes": info.max_code_bytes,
        "run_app_id": info.run_app_id,
        "run_app_main": info.run_app_main,
        "capabilities": list(info.capabilities),
    }


def fetch_info(host: str, timeout_ms: int = 60_000) -> dict[str, Any]:
    client = CubicClient(host, timeout_ms)
    return public_info(client.info(force=True), client.transport.base_url)
