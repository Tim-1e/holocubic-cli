"""Named device configuration with atomic JSON persistence."""

import json
import os
import secrets
from pathlib import Path
from typing import Any, Mapping

from .errors import CubicError, UsageError
from .url import normalize_device_url


def default_config_path(
    env: Mapping[str, str] | None = None, platform: str | None = None
) -> Path:
    values = os.environ if env is None else env
    if values.get("CUBIC_CONFIG"):
        return Path(values["CUBIC_CONFIG"]).expanduser().resolve()
    target_platform = platform or os.name
    if target_platform in {"nt", "win32"}:
        base = Path(values.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        base = Path(values.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "cubic" / "config.json"


def validate_device_name(name: str) -> str:
    trimmed = name.strip()
    if (
        not trimmed
        or trimmed in {".", ".."}
        or "/" in trimmed
        or "\\" in trimmed
        or any(ord(character) < 32 for character in trimmed)
    ):
        raise UsageError(f"Invalid device name: {name}")
    return trimmed


class ConfigStore:
    def __init__(self, file_path: str | Path | None = None) -> None:
        self.file_path = (
            Path(file_path).resolve()
            if file_path is not None
            else default_config_path()
        )

    def read(self) -> dict[str, Any]:
        try:
            parsed = json.loads(self.file_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"version": 1, "current": None, "devices": {}}
        except (OSError, json.JSONDecodeError) as error:
            raise CubicError(
                f"Unable to read config {self.file_path}.", code="CONFIG_ERROR"
            ) from error
        if (
            not isinstance(parsed, dict)
            or parsed.get("version") != 1
            or not isinstance(parsed.get("devices"), dict)
        ):
            raise CubicError(
                f"Config {self.file_path} has an unsupported format.",
                code="CONFIG_ERROR",
            )
        devices: dict[str, dict[str, str]] = {}
        for name, raw_profile in parsed["devices"].items():
            if (
                not isinstance(name, str)
                or not isinstance(raw_profile, dict)
                or not isinstance(raw_profile.get("url"), str)
            ):
                continue
            profile = {"url": normalize_device_url(raw_profile["url"])}
            if isinstance(raw_profile.get("version"), str):
                profile["version"] = raw_profile["version"]
            devices[name] = profile
        current = (
            parsed.get("current") if isinstance(parsed.get("current"), str) else None
        )
        if current not in devices:
            current = None
        return {"version": 1, "current": current, "devices": devices}

    def write(self, config: dict[str, Any]) -> None:
        self.file_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.file_path.with_name(
            f"{self.file_path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
        )
        try:
            temporary.write_text(
                json.dumps(config, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            try:
                temporary.chmod(0o600)
            except OSError:
                pass
            os.replace(temporary, self.file_path)
        except OSError as error:
            temporary.unlink(missing_ok=True)
            raise CubicError(
                f"Unable to write config {self.file_path}.", code="CONFIG_ERROR"
            ) from error


def resolve_device(
    store: ConfigStore,
    option_host: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, str | None]:
    values = os.environ if env is None else env
    if option_host:
        return {
            "url": normalize_device_url(option_host),
            "name": None,
            "source": "option",
        }
    if values.get("CUBIC_HOST"):
        return {
            "url": normalize_device_url(values["CUBIC_HOST"]),
            "name": None,
            "source": "environment",
        }
    config = store.read()
    current = config["current"]
    profile = config["devices"].get(current) if current else None
    if not current or not profile:
        raise CubicError(
            "No device selected. Run `cubic-py device add <name> <host>` or pass --host.",
            code="NO_DEVICE",
        )
    return {"url": profile["url"], "name": current, "source": "config"}
