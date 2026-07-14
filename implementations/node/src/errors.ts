export class CubicError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, options: { code?: string; exitCode?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CubicError";
    this.code = options.code ?? "CUBIC_ERROR";
    this.exitCode = options.exitCode ?? 1;
  }
}
export class UsageError extends CubicError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { code: "USAGE_ERROR", exitCode: 2, ...options });
    this.name = "UsageError";
  }
}

export class HttpError extends CubicError {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(message: string, status: number, method: string, path: string) {
    super(message, { code: status === 404 ? "NOT_FOUND" : "HTTP_ERROR" });
    this.name = "HttpError";
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

export function isNotFound(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 404;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
