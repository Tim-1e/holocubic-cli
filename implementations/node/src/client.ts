import { CubicError, isNotFound } from "./errors.js";
import { normalizeRemotePath } from "./remote-path.js";
import { HttpTransport } from "./transport.js";
import {
  LEGACY_V1_CAPABILITIES,
  type AppRecord,
  type AppsResult,
  type DeviceInfo,
  type DevRunResult,
  type ListResult,
  type ReadChunk,
  type RemoteEntry,
  type RemoteStat,
  type UploadResult,
} from "./types.js";

const DEFAULT_MAX_CODE_BYTES = 192 * 1024;

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CubicError(`Device returned an invalid ${label} response.`, { code: "INVALID_RESPONSE" });
  }
  return value as JsonObject;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new CubicError(`Device response is missing ${label}.`, { code: "INVALID_RESPONSE" });
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new CubicError(`Device response has an invalid ${label}.`, { code: "INVALID_RESPONSE" });
  }
  return value as number;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new CubicError(`Device response has an invalid ${label}.`, { code: "INVALID_RESPONSE" });
  return value;
}

function luaArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value)) return value;
  // Lua JSON encoders commonly serialize an empty table as `{}` because no
  // numeric key exists to disambiguate it from an object.
  if (value && typeof value === "object" && Object.keys(value).length === 0) return [];
  throw new CubicError(`Device ${label} response is missing a valid array.`, { code: "INVALID_RESPONSE" });
}

function parseEntry(value: unknown): RemoteEntry {
  const item = object(value, "directory entry");
  return {
    name: stringValue(item.name, "entry.name"),
    path: normalizeRemotePath(stringValue(item.path, "entry.path")),
    size: integer(item.size, "entry.size"),
    isDir: bool(item.is_dir, "entry.is_dir"),
    ext: typeof item.ext === "string" ? item.ext : "",
    mime: typeof item.mime === "string" ? item.mime : "application/octet-stream",
    category: typeof item.category === "string" ? item.category : "other",
  };
}

export class CubicClient {
  readonly transport: HttpTransport;
  private cachedInfo: DeviceInfo | null = null;

  constructor(baseUrl: string, timeoutMs = 60_000) {
    this.transport = new HttpTransport(baseUrl, timeoutMs);
  }

  async info(force = false): Promise<DeviceInfo> {
    if (this.cachedInfo && !force) return this.cachedInfo;
    const raw = object(await this.transport.json<unknown>("info"), "info");
    if (raw.ok !== true) throw new CubicError("Device handshake did not return ok=true.", { code: "INVALID_RESPONSE" });
    const apiVersion = raw.api_version === undefined ? 1 : integer(raw.api_version, "api_version", 1);
    if (apiVersion > 1) throw new CubicError(`Unsupported DevTools API version: ${apiVersion}.`, { code: "UNSUPPORTED_API" });
    const rootPath = stringValue(raw.root_path, "root_path");
    if (normalizeRemotePath(rootPath) !== "/sd") {
      throw new CubicError(`Unsupported device root path: ${rootPath}.`, { code: "INVALID_RESPONSE" });
    }
    const explicit = Array.isArray(raw.capabilities)
      ? raw.capabilities.filter((item): item is string => typeof item === "string")
      : null;
    const info: DeviceInfo = {
      ok: true,
      apiVersion,
      version: typeof raw.version === "string" ? raw.version : null,
      routeBase: typeof raw.route_base === "string" ? raw.route_base : "/devtools",
      rootPath,
      chunkSize: integer(raw.chunk_size, "chunk_size", 1),
      maxFileSize: integer(raw.max_file_size, "max_file_size", 1),
      maxCodeBytes: raw.max_code_bytes === undefined ? DEFAULT_MAX_CODE_BYTES : integer(raw.max_code_bytes, "max_code_bytes", 1),
      runAppId: stringValue(raw.run_app_id, "run_app_id"),
      runAppMain: normalizeRemotePath(stringValue(raw.run_app_main, "run_app_main")),
      capabilities: new Set(explicit ?? LEGACY_V1_CAPABILITIES),
      raw,
    };
    this.cachedInfo = info;
    return info;
  }

  async requireCapability(capability: string): Promise<void> {
    const info = await this.info();
    if (!info.capabilities.has(capability)) {
      throw new CubicError(`Device does not support capability ${capability}.`, { code: "UNSUPPORTED_CAPABILITY" });
    }
  }

  async list(remotePath = "/sd"): Promise<ListResult> {
    await this.requireCapability("fs.list");
    const raw = object(await this.transport.json<unknown>("list", { query: { path: normalizeRemotePath(remotePath) } }), "list");
    const items = luaArray(raw.items, "list.items");
    return {
      path: normalizeRemotePath(stringValue(raw.path, "list.path")),
      parent: normalizeRemotePath(stringValue(raw.parent, "list.parent")),
      dirCount: integer(raw.dir_count, "list.dir_count"),
      fileCount: integer(raw.file_count, "list.file_count"),
      totalBytes: integer(raw.total_bytes, "list.total_bytes"),
      items: items.map(parseEntry),
    };
  }

  async stat(remotePath: string): Promise<RemoteStat> {
    await this.requireCapability("fs.stat");
    const raw = object(await this.transport.json<unknown>("stat", { query: { path: normalizeRemotePath(remotePath) } }), "stat");
    return {
      path: normalizeRemotePath(stringValue(raw.path, "stat.path")),
      name: stringValue(raw.name, "stat.name"),
      parent: normalizeRemotePath(stringValue(raw.parent, "stat.parent")),
      size: integer(raw.size, "stat.size"),
      isDir: bool(raw.is_dir, "stat.is_dir"),
      ext: typeof raw.ext === "string" ? raw.ext : "",
      mime: typeof raw.mime === "string" ? raw.mime : "application/octet-stream",
      category: typeof raw.category === "string" ? raw.category : "other",
    };
  }

  async statOrNull(remotePath: string): Promise<RemoteStat | null> {
    try {
      return await this.stat(remotePath);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async read(remotePath: string, offset: number, size: number): Promise<ReadChunk> {
    await this.requireCapability("fs.read");
    const response = await this.transport.request("read", {
      query: { path: normalizeRemotePath(remotePath), offset, size },
      headers: { Accept: "application/octet-stream" },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const fileSize = integer(Number(response.headers.get("x-file-size")), "x-file-size");
    const nextOffset = integer(Number(response.headers.get("x-next-offset")), "x-next-offset");
    return {
      bytes,
      size: fileSize,
      nextOffset,
      eof: response.headers.get("x-eof") === "1",
      name: response.headers.get("x-file-name") ?? "",
      mime: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.requireCapability("fs.mkdir");
    await this.transport.json("mkdir", { method: "POST", query: { path: normalizeRemotePath(remotePath) } });
  }

  async rename(source: string, target: string): Promise<void> {
    await this.requireCapability("fs.rename");
    await this.transport.json("rename", {
      method: "POST",
      query: { path: normalizeRemotePath(source), new_path: normalizeRemotePath(target) },
    });
  }

  async upload(remotePath: string, bytes: Uint8Array, offset: number, total: number): Promise<UploadResult> {
    await this.requireCapability("fs.write");
    const raw = object(
      await this.transport.json<unknown>("upload", {
        method: "PUT",
        query: { path: normalizeRemotePath(remotePath), offset, total },
        body: Uint8Array.from(bytes).buffer,
        headers: { "Content-Type": "application/octet-stream" },
      }),
      "upload",
    );
    return {
      path: normalizeRemotePath(stringValue(raw.path, "upload.path")),
      nextOffset: integer(raw.next_offset, "upload.next_offset"),
      total: integer(raw.total, "upload.total"),
      done: bool(raw.done, "upload.done"),
      size: raw.size === undefined ? integer(raw.next_offset, "upload.next_offset") : integer(raw.size, "upload.size"),
    };
  }

  async remove(remotePath: string): Promise<void> {
    await this.requireCapability("fs.remove");
    await this.transport.json("remove", { method: "DELETE", query: { path: normalizeRemotePath(remotePath) } });
  }

  async rmdir(remotePath: string, recursive = false): Promise<void> {
    await this.requireCapability("fs.rmdir");
    await this.transport.json("rmdir", {
      method: "DELETE",
      query: { path: normalizeRemotePath(remotePath), recursive: recursive ? 1 : 0 },
    });
  }

  async apps(): Promise<AppsResult> {
    await this.requireCapability("apps.list");
    const raw = object(await this.transport.json<unknown>("apps"), "apps");
    const apps = luaArray(raw.apps, "apps.apps");
    return {
      apps: apps.filter((item): item is AppRecord => Boolean(item && typeof item === "object" && !Array.isArray(item))),
      currentAppId: typeof raw.current_app_id === "string" ? raw.current_app_id : null,
      runAppId: stringValue(raw.run_app_id, "apps.run_app_id"),
      runAppMain: normalizeRemotePath(stringValue(raw.run_app_main, "apps.run_app_main")),
    };
  }

  async readDevRun(): Promise<string> {
    await this.requireCapability("devrun.read");
    const response = await this.transport.request("code/read", { headers: { Accept: "text/plain" } });
    return response.text();
  }

  async saveDevRun(source: string, run = false): Promise<DevRunResult> {
    await this.requireCapability(run ? "devrun.run" : "devrun.save");
    const info = await this.info();
    const bytes = Buffer.byteLength(source, "utf8");
    if (bytes > info.maxCodeBytes) {
      throw new CubicError(`DevRun source is ${bytes} bytes; device limit is ${info.maxCodeBytes} bytes.`, {
        code: "FILE_TOO_LARGE",
      });
    }
    const raw = object(
      await this.transport.json<unknown>(run ? "code/run" : "code/save", {
        method: "POST",
        body: source,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      "DevRun",
    );
    return {
      id: stringValue(raw.id, "DevRun.id"),
      entry: normalizeRemotePath(stringValue(raw.entry, "DevRun.entry")),
      bytes: integer(raw.bytes, "DevRun.bytes"),
      launched: bool(raw.launched, "DevRun.launched"),
      rescanRequested: bool(raw.rescan_requested, "DevRun.rescan_requested"),
    };
  }
}
