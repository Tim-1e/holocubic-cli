import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  bytes: number;
}

export interface MockDevToolsOptions {
  chunkSize?: number;
  maxFileSize?: number;
  explicitCapabilities?: string[];
  uploadFailures?: number;
  malformedInfo?: boolean;
  malformedJsonInfo?: boolean;
  infoDelayMs?: number;
  readFailures?: number;
  maliciousListEntry?: boolean;
}

export class MockDevTools {
  readonly options: MockDevToolsOptions;
  readonly requests: RecordedRequest[] = [];
  rootDir = "";
  baseUrl = "";
  private server: Server | null = null;
  private uploadFailuresRemaining: number;
  private readFailuresRemaining: number;

  constructor(options: MockDevToolsOptions = {}) {
    this.options = options;
    this.uploadFailuresRemaining = options.uploadFailures ?? 0;
    this.readFailuresRemaining = options.readFailures ?? 0;
  }

  async start(): Promise<this> {
    this.rootDir = await mkdtemp(path.join(os.tmpdir(), "cubic-mock-"));
    await mkdir(path.join(this.rootDir, "apps", "devrun"), { recursive: true });
    await writeFile(path.join(this.rootDir, "apps", "devrun", "main.lua"), "print('ready')\n");
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.json(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind TCP");
    this.baseUrl = `http://127.0.0.1:${address.port}/devtools`;
    return this;
  }

  async close(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => this.server?.close((error) => (error ? reject(error) : resolve())));
      this.server = null;
    }
    if (this.rootDir) await rm(this.rootDir, { recursive: true, force: true });
  }

  localPath(remotePath: string): string {
    if (remotePath !== "/sd" && !remotePath.startsWith("/sd/")) throw new Error(`unsafe mock path ${remotePath}`);
    const relative = remotePath === "/sd" ? "" : remotePath.slice(4);
    const resolved = path.resolve(this.rootDir, ...relative.split("/"));
    const prefix = `${path.resolve(this.rootDir)}${path.sep}`;
    if (resolved !== path.resolve(this.rootDir) && !resolved.startsWith(prefix)) throw new Error(`mock path escaped ${remotePath}`);
    return resolved;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const route = url.pathname.replace(/^\/devtools\/api\/?/, "");
    const method = request.method ?? "GET";
    const body = await this.body(request);
    this.requests.push({ method, path: route, query: new URLSearchParams(url.searchParams), bytes: body.length });

    if (route === "info" && method === "GET") {
      if (this.options.infoDelayMs) await new Promise((resolve) => setTimeout(resolve, this.options.infoDelayMs));
      if (this.options.malformedJsonInfo) {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end("{");
        return;
      }
      if (this.options.malformedInfo) return this.json(response, 200, { ok: true, root_path: "/sd" });
      const payload: Record<string, unknown> = {
        ok: true,
        version: "mock-v1",
        route_base: "/devtools",
        root_path: "/sd",
        chunk_size: this.options.chunkSize ?? 4,
        max_file_size: this.options.maxFileSize ?? 1024 * 1024,
        max_code_bytes: 192 * 1024,
        run_app_id: "devrun",
        run_app_main: "/sd/apps/devrun/main.lua",
      };
      if (this.options.explicitCapabilities) {
        payload.api_version = 1;
        payload.capabilities = this.options.explicitCapabilities;
      }
      return this.json(response, 200, payload);
    }

    if (route === "list" && method === "GET") {
      const remote = this.remoteQuery(url, "path");
      const local = this.localPath(remote);
      let entries;
      try {
        entries = await readdir(local, { withFileTypes: true });
      } catch {
        return this.json(response, 404, { ok: false, error: "directory not found" });
      }
      const items = await Promise.all(
        entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(async (entry) => {
            const itemStat = await stat(path.join(local, entry.name));
            return {
              name: entry.name,
              path: `${remote === "/sd" ? "/sd" : remote}/${entry.name}`,
              size: entry.isDirectory() ? 0 : itemStat.size,
              is_dir: entry.isDirectory(),
              ext: path.extname(entry.name).slice(1),
              mime: "application/octet-stream",
              category: entry.isDirectory() ? "folder" : "other",
            };
          }),
      );
      const dirs = items.filter((item) => item.is_dir);
      const files = items.filter((item) => !item.is_dir);
      if (this.options.maliciousListEntry && items[0]) items[0].path = "/sd/escape";
      return this.json(response, 200, {
        ok: true,
        path: remote,
        parent: remote === "/sd" ? "/sd" : remote.slice(0, remote.lastIndexOf("/")) || "/sd",
        dir_count: dirs.length,
        file_count: files.length,
        total_bytes: files.reduce((sum, item) => sum + item.size, 0),
        items: items.length ? items : {},
      });
    }

    if (route === "stat" && method === "GET") {
      const remote = this.remoteQuery(url, "path");
      let itemStat;
      try {
        itemStat = await stat(this.localPath(remote));
      } catch {
        return this.json(response, 404, { ok: false, error: "path not found" });
      }
      return this.json(response, 200, {
        ok: true,
        path: remote,
        name: remote === "/sd" ? "sd" : remote.slice(remote.lastIndexOf("/") + 1),
        parent: remote === "/sd" ? "/sd" : remote.slice(0, remote.lastIndexOf("/")) || "/sd",
        size: itemStat.isDirectory() ? 0 : itemStat.size,
        is_dir: itemStat.isDirectory(),
        ext: path.extname(remote).slice(1),
        mime: "application/octet-stream",
        category: itemStat.isDirectory() ? "folder" : "other",
      });
    }

    if (route === "read" && method === "GET") {
      if (this.readFailuresRemaining > 0) {
        this.readFailuresRemaining -= 1;
        return this.json(response, 503, { ok: false, error: "transient read failure" });
      }
      const remote = this.remoteQuery(url, "path");
      const offset = this.intQuery(url, "offset", 0);
      const requested = this.intQuery(url, "size", this.options.chunkSize ?? 4);
      let bytes;
      try {
        bytes = await readFile(this.localPath(remote));
      } catch {
        return this.json(response, 404, { ok: false, error: "not found" });
      }
      const size = Math.min(requested, this.options.chunkSize ?? 4);
      const chunk = bytes.subarray(offset, offset + size);
      response.statusCode = 200;
      response.setHeader("content-type", "application/octet-stream");
      response.setHeader("x-file-size", String(bytes.length));
      response.setHeader("x-next-offset", String(offset + chunk.length));
      response.setHeader("x-eof", offset + chunk.length >= bytes.length ? "1" : "0");
      response.setHeader("x-file-name", encodeURIComponent(path.basename(remote)));
      response.end(chunk);
      return;
    }

    if (route === "mkdir" && method === "POST") {
      const remote = this.remoteQuery(url, "path");
      try {
        await mkdir(this.localPath(remote));
      } catch {
        return this.json(response, 400, { ok: false, error: "mkdir failed" });
      }
      return this.json(response, 200, { ok: true, path: remote });
    }

    if (route === "rename" && method === "POST") {
      const remote = this.remoteQuery(url, "path");
      const target = this.remoteQuery(url, "new_path");
      try {
        await rename(this.localPath(remote), this.localPath(target));
      } catch {
        return this.json(response, 400, { ok: false, error: "rename failed" });
      }
      return this.json(response, 200, { ok: true, path: remote, new_path: target });
    }

    if (route === "upload" && method === "PUT") {
      if (this.uploadFailuresRemaining > 0) {
        this.uploadFailuresRemaining -= 1;
        return this.json(response, 503, { ok: false, error: "transient failure" });
      }
      const remote = this.remoteQuery(url, "path");
      const offset = this.intQuery(url, "offset", 0);
      const total = this.intQuery(url, "total", -1);
      if (total < 0 || total > (this.options.maxFileSize ?? 1024 * 1024)) {
        return this.json(response, 413, { ok: false, error: "file too large" });
      }
      const local = this.localPath(remote);
      let handle;
      try {
        handle = await open(local, offset === 0 ? "w+" : "r+");
        await handle.write(body, 0, body.length, offset);
        await handle.close();
      } catch {
        await handle?.close().catch(() => undefined);
        return this.json(response, 400, { ok: false, error: "upload failed" });
      }
      const nextOffset = offset + body.length;
      return this.json(response, 200, {
        ok: true,
        path: remote,
        next_offset: nextOffset,
        total,
        done: nextOffset >= total,
        size: (await stat(local)).size,
      });
    }

    if (route === "remove" && method === "DELETE") {
      const remote = this.remoteQuery(url, "path");
      try {
        await rm(this.localPath(remote));
      } catch {
        return this.json(response, 404, { ok: false, error: "file not found" });
      }
      return this.json(response, 200, { ok: true, path: remote });
    }

    if (route === "rmdir" && method === "DELETE") {
      const remote = this.remoteQuery(url, "path");
      try {
        if (url.searchParams.get("recursive") === "1") await rm(this.localPath(remote), { recursive: true });
        else await rmdir(this.localPath(remote));
      } catch {
        return this.json(response, 400, { ok: false, error: "rmdir failed" });
      }
      return this.json(response, 200, { ok: true, path: remote, recursive: url.searchParams.get("recursive") === "1" });
    }

    if (route === "apps" && method === "GET") {
      const entries = await readdir(path.join(this.rootDir, "apps"), { withFileTypes: true });
      return this.json(response, 200, {
        ok: true,
        apps: entries.filter((entry) => entry.isDirectory()).map((entry) => ({ id: entry.name, path: `/sd/apps/${entry.name}` })),
        current_app_id: null,
        run_app_id: "devrun",
        run_app_main: "/sd/apps/devrun/main.lua",
      });
    }

    if (route === "code/read" && method === "GET") {
      const source = await readFile(path.join(this.rootDir, "apps", "devrun", "main.lua"));
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(source);
      return;
    }

    if ((route === "code/save" || route === "code/run") && method === "POST") {
      await writeFile(path.join(this.rootDir, "apps", "devrun", "main.lua"), body);
      return this.json(response, 200, {
        ok: true,
        id: "devrun",
        entry: "/sd/apps/devrun/main.lua",
        bytes: body.length,
        launched: route === "code/run",
        rescan_requested: route === "code/run",
      });
    }

    this.json(response, 404, { ok: false, error: "not found" });
  }

  private remoteQuery(url: URL, key: string): string {
    const value = url.searchParams.get(key);
    if (!value) throw new Error(`missing query ${key}`);
    return value;
  }

  private intQuery(url: URL, key: string, fallback: number): number {
    const value = Number(url.searchParams.get(key));
    return Number.isInteger(value) ? value : fallback;
  }

  private async body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent) return;
    const body = Buffer.from(JSON.stringify(value));
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-length", String(body.length));
    response.end(body);
  }
}
