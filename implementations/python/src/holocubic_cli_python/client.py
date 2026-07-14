import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .url import normalize_device_url

LEGACY_CAPABILITIES = [
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
]


def _positive_integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"Device response has an invalid {field}.")
    return value


def public_info(raw: Any, url: str) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("ok") is not True:
        raise ValueError("Device handshake did not return ok=true.")

    api_version = raw.get("api_version", 1)
    if isinstance(api_version, bool) or not isinstance(api_version, int) or api_version != 1:
        raise ValueError(f"Unsupported DevTools API version: {api_version}.")
    if raw.get("root_path") != "/sd":
        raise ValueError("Device response has an invalid root_path.")

    chunk_size = _positive_integer(raw.get("chunk_size"), "chunk_size")
    max_file_size = _positive_integer(raw.get("max_file_size"), "max_file_size")
    run_app_id = raw.get("run_app_id")
    run_app_main = raw.get("run_app_main")
    if not isinstance(run_app_id, str) or not isinstance(run_app_main, str):
        raise ValueError("Device response is missing run app metadata.")
    if not run_app_main.startswith("/sd/"):
        raise ValueError("Device response has an invalid run_app_main.")

    capabilities = raw.get("capabilities")
    if not isinstance(capabilities, list) or not all(isinstance(item, str) for item in capabilities):
        capabilities = LEGACY_CAPABILITIES
    max_code_bytes = raw.get("max_code_bytes", 192 * 1024)
    max_code_bytes = _positive_integer(max_code_bytes, "max_code_bytes")

    return {
        "name": None,
        "url": url,
        "version": raw.get("version") if isinstance(raw.get("version"), str) else None,
        "api_version": api_version,
        "route_base": "/devtools",
        "root_path": "/sd",
        "chunk_size": chunk_size,
        "max_file_size": max_file_size,
        "max_code_bytes": max_code_bytes,
        "run_app_id": run_app_id,
        "run_app_main": run_app_main,
        "capabilities": capabilities,
    }


def fetch_info(host: str, timeout_ms: int = 60_000) -> dict[str, Any]:
    if timeout_ms <= 0:
        raise ValueError("Timeout must be greater than zero.")
    base_url = normalize_device_url(host)
    request = Request(f"{base_url}/api/info", headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=timeout_ms / 1000) as response:
            raw = json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"Device returned HTTP {error.code} for GET /api/info.") from error
    except URLError as error:
        raise RuntimeError(f"Could not connect to HoloCubic: {error.reason}") from error
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise RuntimeError("Device returned invalid JSON for GET /api/info.") from error
    return public_info(raw, base_url)
