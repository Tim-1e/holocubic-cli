from urllib.parse import SplitResult, urlsplit, urlunsplit


def normalize_device_url(value: str) -> str:
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("Device host cannot be empty.")
    if "\0" in trimmed:
        raise ValueError("Device host contains an invalid NUL character.")

    candidate = trimmed if "://" in trimmed else f"http://{trimmed}"
    try:
        parsed = urlsplit(candidate)
        _ = parsed.port
    except ValueError as error:
        raise ValueError(f"Invalid device host: {value}") from error

    if parsed.scheme not in {"http", "https"}:
        raise ValueError(f"Unsupported device URL scheme: {parsed.scheme}")
    if not parsed.hostname:
        raise ValueError(f"Invalid device host: {value}")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Credentials are not allowed in the device URL.")
    if parsed.query or parsed.fragment:
        raise ValueError("Device URL must not contain a query string or fragment.")

    path = parsed.path.rstrip("/")
    if path in {"", "/devtools"}:
        path = "/devtools"
    elif path == "/devtools/api":
        path = "/devtools"
    else:
        raise ValueError("Device URL path must be /devtools or /devtools/api.")

    normalized = SplitResult(parsed.scheme.lower(), parsed.netloc, path, "", "")
    return urlunsplit(normalized)
