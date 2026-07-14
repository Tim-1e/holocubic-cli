import { UsageError } from "./errors.js";

const DEFAULT_ROUTE_BASE = "/devtools";

export function normalizeDeviceUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new UsageError("Device host cannot be empty.");
  }
  if (trimmed.includes("\0")) {
    throw new UsageError("Device host contains an invalid NUL character.");
  }

  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch (error) {
    throw new UsageError(`Invalid device host: ${input}`, { cause: error });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(`Unsupported device URL scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new UsageError("Credentials are not allowed in the device URL.");
  }
  if (url.search || url.hash) {
    throw new UsageError("Device URL must not contain a query string or fragment.");
  }

  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname) pathname = DEFAULT_ROUTE_BASE;
  if (pathname.endsWith("/api")) pathname = pathname.slice(0, -4);
  if (pathname !== DEFAULT_ROUTE_BASE) {
    throw new UsageError(`Device URL path must be ${DEFAULT_ROUTE_BASE} or ${DEFAULT_ROUTE_BASE}/api.`);
  }

  url.pathname = DEFAULT_ROUTE_BASE;
  return url.toString().replace(/\/$/, "");
}
export function apiUrl(baseUrl: string, route: string, query: Record<string, string | number | boolean | undefined> = {}): URL {
  const cleanRoute = route.replace(/^\/+/, "");
  const url = new URL(`${baseUrl}/api/${cleanRoute}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}
