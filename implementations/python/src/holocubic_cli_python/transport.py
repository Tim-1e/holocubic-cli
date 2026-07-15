"""HTTP transport with stable timeout, connection, and device error handling."""

import json
import socket
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .errors import CubicError, HttpError
from .url import api_url, normalize_device_url


@dataclass(frozen=True)
class HttpResponse:
    body: bytes
    headers: Mapping[str, str]


class HttpTransport:
    def __init__(self, base_url: str, timeout_ms: int = 60_000) -> None:
        if timeout_ms <= 0:
            raise CubicError(
                "Timeout must be greater than zero.", code="INVALID_TIMEOUT"
            )
        self.base_url = normalize_device_url(base_url)
        self.timeout_ms = timeout_ms

    def request(
        self,
        route: str,
        *,
        method: str = "GET",
        query: Mapping[str, str | int | bool | None] | None = None,
        body: bytes | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> HttpResponse:
        url = api_url(self.base_url, route, query)
        request = Request(
            url,
            data=body,
            method=method,
            headers={"Accept": "application/json", **(headers or {})},
        )
        try:
            with urlopen(request, timeout=self.timeout_ms / 1000) as response:
                return HttpResponse(response.read(), dict(response.headers.items()))
        except HTTPError as error:
            request_path = url.removeprefix(self.base_url)
            message = f"{method} {request_path} failed with HTTP {error.code}."
            try:
                payload = json.loads(error.read().decode("utf-8"))
                if isinstance(payload, dict):
                    detail = (
                        payload.get("error")
                        if isinstance(payload.get("error"), str)
                        else payload.get("message")
                    )
                    if isinstance(detail, str):
                        message = f"{message} {detail}"
            except (json.JSONDecodeError, UnicodeDecodeError, OSError):
                pass
            raise HttpError(message, error.code, method, request_path) from error
        except (socket.timeout, TimeoutError) as error:
            raise CubicError(
                f"Request timed out after {self.timeout_ms} ms.", code="TIMEOUT"
            ) from error
        except URLError as error:
            if isinstance(error.reason, (socket.timeout, TimeoutError)):
                raise CubicError(
                    f"Request timed out after {self.timeout_ms} ms.", code="TIMEOUT"
                ) from error
            raise CubicError(
                f"Unable to connect to {self.base_url}.", code="CONNECTION_ERROR"
            ) from error
        except OSError as error:
            raise CubicError(
                f"Unable to connect to {self.base_url}.", code="CONNECTION_ERROR"
            ) from error

    def json(
        self,
        route: str,
        *,
        method: str = "GET",
        query: Mapping[str, str | int | bool | None] | None = None,
        body: bytes | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        response = self.request(
            route, method=method, query=query, body=body, headers=headers
        )
        try:
            return json.loads(response.body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise CubicError(
                f"Device returned malformed JSON for /api/{route}.",
                code="INVALID_RESPONSE",
            ) from error
