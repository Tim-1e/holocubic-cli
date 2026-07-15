"""Filesystem-backed DevTools test server shared by Python integration tests."""

import json
import mimetypes
import shutil
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit


class MockDevTools:
    def __init__(
        self,
        *,
        chunk_size: int = 4,
        max_file_size: int = 1024 * 1024,
        capabilities: list[str] | None = None,
        upload_failures: int = 0,
        read_failures: int = 0,
        malicious_list_entry: bool = False,
        info_delay: float = 0,
    ) -> None:
        self.chunk_size = chunk_size
        self.max_file_size = max_file_size
        self.capabilities = capabilities
        self.upload_failures = upload_failures
        self.read_failures = read_failures
        self.malicious_list_entry = malicious_list_entry
        self.info_delay = info_delay
        self.requests: list[tuple[str, str]] = []
        self.root = Path(tempfile.mkdtemp(prefix="cubic-py-mock-"))
        (self.root / "apps" / "devrun").mkdir(parents=True)
        (self.root / "apps" / "devrun" / "main.lua").write_text(
            "print('ready')\n", encoding="utf-8"
        )
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def _json(self, status: int, payload: Any) -> None:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionAbortedError):
                    pass

            def _body(self) -> bytes:
                return self.rfile.read(int(self.headers.get("Content-Length", "0")))

            def _route(self) -> tuple[str, dict[str, list[str]]]:
                parsed = urlsplit(self.path)
                return parsed.path.removeprefix("/devtools/api/").strip("/"), parse_qs(
                    parsed.query
                )

            @staticmethod
            def _query(query: dict[str, list[str]], key: str) -> str:
                values = query.get(key)
                if not values:
                    raise ValueError(f"missing query {key}")
                return values[0]

            def _dispatch(self, method: str) -> None:
                route, query = self._route()
                body = self._body() if method in {"POST", "PUT"} else b""
                owner.requests.append((method, route))
                if route == "info" and method == "GET":
                    if owner.info_delay:
                        time.sleep(owner.info_delay)
                    payload: dict[str, Any] = {
                        "ok": True,
                        "version": "mock-v1",
                        "route_base": "/devtools",
                        "root_path": "/sd",
                        "chunk_size": owner.chunk_size,
                        "max_file_size": owner.max_file_size,
                        "max_code_bytes": 192 * 1024,
                        "run_app_id": "devrun",
                        "run_app_main": "/sd/apps/devrun/main.lua",
                    }
                    if owner.capabilities is not None:
                        payload["api_version"] = 1
                        payload["capabilities"] = owner.capabilities
                    return self._json(200, payload)
                if route == "list" and method == "GET":
                    remote = self._query(query, "path")
                    local = owner.local_path(remote)
                    if not local.is_dir():
                        return self._json(
                            404, {"ok": False, "error": "directory not found"}
                        )
                    items = []
                    for entry in sorted(local.iterdir(), key=lambda item: item.name):
                        is_dir = entry.is_dir()
                        items.append(
                            {
                                "name": entry.name,
                                "path": f"{remote.rstrip('/')}/{entry.name}",
                                "size": 0 if is_dir else entry.stat().st_size,
                                "is_dir": is_dir,
                                "ext": entry.suffix.lstrip("."),
                                "mime": mimetypes.guess_type(entry.name)[0]
                                or "application/octet-stream",
                                "category": "folder" if is_dir else "other",
                            }
                        )
                    if owner.malicious_list_entry and items:
                        items[0]["path"] = "/sd/escape"
                    directories = [item for item in items if item["is_dir"]]
                    files = [item for item in items if not item["is_dir"]]
                    parent = (
                        "/sd" if remote == "/sd" else remote.rsplit("/", 1)[0] or "/sd"
                    )
                    return self._json(
                        200,
                        {
                            "ok": True,
                            "path": remote,
                            "parent": parent,
                            "dir_count": len(directories),
                            "file_count": len(files),
                            "total_bytes": sum(item["size"] for item in files),
                            "items": items or {},
                        },
                    )
                if route == "stat" and method == "GET":
                    remote = self._query(query, "path")
                    local = owner.local_path(remote)
                    if not local.exists():
                        return self._json(404, {"ok": False, "error": "path not found"})
                    is_dir = local.is_dir()
                    return self._json(
                        200,
                        {
                            "ok": True,
                            "path": remote,
                            "name": "sd"
                            if remote == "/sd"
                            else remote.rsplit("/", 1)[-1],
                            "parent": "/sd"
                            if remote == "/sd"
                            else remote.rsplit("/", 1)[0] or "/sd",
                            "size": 0 if is_dir else local.stat().st_size,
                            "is_dir": is_dir,
                            "ext": local.suffix.lstrip("."),
                            "mime": mimetypes.guess_type(local.name)[0]
                            or "application/octet-stream",
                            "category": "folder" if is_dir else "other",
                        },
                    )
                if route == "read" and method == "GET":
                    if owner.read_failures:
                        owner.read_failures -= 1
                        return self._json(
                            503, {"ok": False, "error": "transient read failure"}
                        )
                    remote = self._query(query, "path")
                    local = owner.local_path(remote)
                    if not local.is_file():
                        return self._json(404, {"ok": False, "error": "not found"})
                    data = local.read_bytes()
                    offset = int(self._query(query, "offset"))
                    requested = min(int(self._query(query, "size")), owner.chunk_size)
                    chunk = data[offset : offset + requested]
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("X-File-Size", str(len(data)))
                    self.send_header("X-Next-Offset", str(offset + len(chunk)))
                    self.send_header(
                        "X-Eof", "1" if offset + len(chunk) >= len(data) else "0"
                    )
                    self.send_header("X-File-Name", quote(local.name))
                    self.send_header("Content-Length", str(len(chunk)))
                    self.end_headers()
                    self.wfile.write(chunk)
                    return
                if route == "mkdir" and method == "POST":
                    remote = self._query(query, "path")
                    try:
                        owner.local_path(remote).mkdir()
                    except OSError:
                        return self._json(400, {"ok": False, "error": "mkdir failed"})
                    return self._json(200, {"ok": True, "path": remote})
                if route == "rename" and method == "POST":
                    remote = self._query(query, "path")
                    target = self._query(query, "new_path")
                    try:
                        owner.local_path(remote).rename(owner.local_path(target))
                    except OSError:
                        return self._json(400, {"ok": False, "error": "rename failed"})
                    return self._json(
                        200, {"ok": True, "path": remote, "new_path": target}
                    )
                if route == "upload" and method == "PUT":
                    if owner.upload_failures:
                        owner.upload_failures -= 1
                        return self._json(
                            503, {"ok": False, "error": "transient failure"}
                        )
                    remote = self._query(query, "path")
                    offset = int(self._query(query, "offset"))
                    total = int(self._query(query, "total"))
                    if total > owner.max_file_size:
                        return self._json(413, {"ok": False, "error": "file too large"})
                    local = owner.local_path(remote)
                    try:
                        mode = "wb" if offset == 0 else "r+b"
                        with local.open(mode) as handle:
                            handle.seek(offset)
                            handle.write(body)
                    except OSError:
                        return self._json(400, {"ok": False, "error": "upload failed"})
                    next_offset = offset + len(body)
                    return self._json(
                        200,
                        {
                            "ok": True,
                            "path": remote,
                            "next_offset": next_offset,
                            "total": total,
                            "done": next_offset >= total,
                            "size": local.stat().st_size,
                        },
                    )
                if route == "remove" and method == "DELETE":
                    remote = self._query(query, "path")
                    try:
                        owner.local_path(remote).unlink()
                    except OSError:
                        return self._json(404, {"ok": False, "error": "file not found"})
                    return self._json(200, {"ok": True, "path": remote})
                if route == "rmdir" and method == "DELETE":
                    remote = self._query(query, "path")
                    local = owner.local_path(remote)
                    try:
                        if self._query(query, "recursive") == "1":
                            shutil.rmtree(local)
                        else:
                            local.rmdir()
                    except OSError:
                        return self._json(400, {"ok": False, "error": "rmdir failed"})
                    return self._json(200, {"ok": True, "path": remote})
                if route == "apps" and method == "GET":
                    apps = [
                        {"id": entry.name, "path": f"/sd/apps/{entry.name}"}
                        for entry in sorted((owner.root / "apps").iterdir())
                        if entry.is_dir()
                    ]
                    return self._json(
                        200,
                        {
                            "ok": True,
                            "apps": apps or {},
                            "current_app_id": None,
                            "run_app_id": "devrun",
                            "run_app_main": "/sd/apps/devrun/main.lua",
                        },
                    )
                if route == "code/read" and method == "GET":
                    data = (owner.root / "apps" / "devrun" / "main.lua").read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                if route in {"code/save", "code/run"} and method == "POST":
                    (owner.root / "apps" / "devrun" / "main.lua").write_bytes(body)
                    return self._json(
                        200,
                        {
                            "ok": True,
                            "id": "devrun",
                            "entry": "/sd/apps/devrun/main.lua",
                            "bytes": len(body),
                            "launched": route == "code/run",
                            "rescan_requested": route == "code/run",
                        },
                    )
                return self._json(404, {"ok": False, "error": "not found"})

            def do_GET(self) -> None:
                self._dispatch("GET")

            def do_POST(self) -> None:
                self._dispatch("POST")

            def do_PUT(self) -> None:
                self._dispatch("PUT")

            def do_DELETE(self) -> None:
                self._dispatch("DELETE")

            def log_message(self, _format: str, *args: object) -> None:
                del args

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}/devtools"

    def local_path(self, remote: str) -> Path:
        if remote != "/sd" and not remote.startswith("/sd/"):
            raise ValueError(f"unsafe mock path {remote}")
        relative = "" if remote == "/sd" else remote[4:]
        resolved = (self.root / Path(*relative.split("/"))).resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise ValueError(f"mock path escaped {remote}")
        return resolved

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        shutil.rmtree(self.root, ignore_errors=True)

    def __enter__(self) -> "MockDevTools":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()
