from collections.abc import Mapping
from urllib.parse import SplitResult, urlencode, urlsplit, urlunsplit

from .errors import UsageError


def normalize_device_url(value: str) -> str:
    trimmed = value.strip()
    if not trimmed:
        raise UsageError("Device host cannot be empty.")
    if "\0" in trimmed:
        raise UsageError("Device host contains an invalid NUL character.")

    candidate = trimmed if "://" in trimmed else f"http://{trimmed}"
    try:
        parsed = urlsplit(candidate)
        _ = parsed.port
    except ValueError as error:
        raise UsageError(f"Invalid device host: {value}") from error

    if parsed.scheme not in {"http", "https"}:
        raise UsageError(f"Unsupported device URL scheme: {parsed.scheme}")
    if not parsed.hostname:
        raise UsageError(f"Invalid device host: {value}")
    if parsed.username is not None or parsed.password is not None:
        raise UsageError("Credentials are not allowed in the device URL.")
    if parsed.query or parsed.fragment:
        raise UsageError("Device URL must not contain a query string or fragment.")

    path = parsed.path.rstrip("/")
    if path in {"", "/devtools"}:
        path = "/devtools"
    elif path == "/devtools/api":
        path = "/devtools"
    else:
        raise UsageError("Device URL path must be /devtools or /devtools/api.")

    normalized = SplitResult(parsed.scheme.lower(), parsed.netloc, path, "", "")
    return urlunsplit(normalized)


def api_url(
    base_url: str,
    route: str,
    query: Mapping[str, str | int | bool | None] | None = None,
) -> str:
    clean_route = route.lstrip("/")
    pairs = [
        (key, str(value)) for key, value in (query or {}).items() if value is not None
    ]
    suffix = f"?{urlencode(pairs)}" if pairs else ""
    return f"{base_url}/api/{clean_route}{suffix}"
