"""Stable error types shared by the Python client, transfers, and CLI."""


class CubicError(Exception):
    def __init__(
        self, message: str, *, code: str = "CUBIC_ERROR", exit_code: int = 1
    ) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


class UsageError(CubicError, ValueError):
    def __init__(self, message: str) -> None:
        super().__init__(message, code="USAGE_ERROR", exit_code=2)


class HttpError(CubicError):
    def __init__(self, message: str, status: int, method: str, path: str) -> None:
        super().__init__(message, code="NOT_FOUND" if status == 404 else "HTTP_ERROR")
        self.status = status
        self.method = method
        self.path = path


def is_not_found(error: BaseException) -> bool:
    return isinstance(error, HttpError) and error.status == 404
