import { CubicError, HttpError } from "./errors.js";
import { apiUrl, normalizeDeviceUrl } from "./url.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: BodyInit | null;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpTransport {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 60_000) {
    this.baseUrl = normalizeDeviceUrl(baseUrl);
    this.timeoutMs = timeoutMs;
  }

  async request(route: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? "GET";
    const url = apiUrl(this.baseUrl, route, options.query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    timer.unref?.();
    let responseReturned = false;
    try {
      const response = await fetch(url, {
        method,
        body: options.body ?? null,
        headers: { Accept: "application/json", ...options.headers },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw await this.httpError(response, method, `${url.pathname}${url.search}`);
      }
      responseReturned = true;
      return response;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new CubicError(`Request timed out after ${options.timeoutMs ?? this.timeoutMs} ms.`, {
          code: "TIMEOUT",
          cause: error,
        });
      }
      throw new CubicError(`Unable to connect to ${url.origin}.`, { code: "CONNECTION_ERROR", cause: error });
    } finally {
      // Keep the unref'ed timer alive while callers consume the response body,
      // so a device that sends headers and then stalls is still interrupted.
      if (!responseReturned) clearTimeout(timer);
    }
  }

  async json<T>(route: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(route, options);
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new CubicError(`Device returned malformed JSON for /api/${route}.`, {
        code: "INVALID_RESPONSE",
        cause: error,
      });
    }
  }

  private async httpError(response: Response, method: string, requestPath: string): Promise<HttpError> {
    let message = `${method} ${requestPath} failed with HTTP ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: unknown; message?: unknown };
      const detail = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : null;
      if (detail) message = `${message} ${detail}`;
    } catch {
      // Keep the stable status-based message for non-JSON device errors.
    }
    return new HttpError(message, response.status, method, requestPath);
  }
}
