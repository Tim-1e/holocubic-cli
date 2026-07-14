import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli, type CliContext, type CliWriter } from "../src/cli.js";
import { MockDevTools } from "./helpers/mock-devtools.js";

class MemoryWriter implements CliWriter {
  readonly chunks: Buffer[] = [];
  isTTY = false;

  write(chunk: string | Uint8Array): void {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function cliContext(cwd: string, config: string, env: NodeJS.ProcessEnv = {}): { context: CliContext; stdout: MemoryWriter; stderr: MemoryWriter } {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  return { context: { stdout, stderr, cwd, env: { ...env, CUBIC_CONFIG: config } }, stdout, stderr };
}

async function execute(context: CliContext, ...args: string[]): Promise<number> {
  return runCli(["node", "cubic", ...args], context);
}

test("CLI device add/list/use/remove persists only verified devices", async () => {
  const mock = await new MockDevTools().start();
  const temp = await mkdtemp(path.join(os.tmpdir(), "cubic-cli-"));
  const config = path.join(temp, "config.json");
  try {
    let io = cliContext(temp, config);
    assert.equal(await execute(io.context, "device", "add", "桌面", mock.baseUrl), 0);
    assert.match(io.stdout.text(), /Added 桌面/);

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "device", "add", "备用", mock.baseUrl, "--no-use"), 0);
    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "device", "use", "备用"), 0);

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--json", "device", "list"), 0);
    const listed = JSON.parse(io.stdout.text()) as { current: string; devices: Array<{ name: string; selected: boolean }> };
    assert.equal(listed.current, "备用");
    assert.deepEqual(listed.devices, [
      { name: "备用", url: mock.baseUrl, version: "mock-v1", selected: true },
      { name: "桌面", url: mock.baseUrl, version: "mock-v1", selected: false },
    ]);

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "device", "remove", "桌面"), 0);
    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "device", "remove", "备用"), 0);
    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "ping"), 1);
    assert.match(io.stderr.text(), /No device selected/);
  } finally {
    await rm(temp, { recursive: true, force: true });
    await mock.close();
  }
});

test("CLI info, ls, stat, mkdir, mv, cat, and rm use stable JSON and deletion guards", async () => {
  const mock = await new MockDevTools().start();
  const temp = await mkdtemp(path.join(os.tmpdir(), "cubic-cli-"));
  const config = path.join(temp, "config.json");
  try {
    await writeFile(path.join(mock.rootDir, "binary.bin"), Buffer.from([0, 1, 255]));
    let io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "--json", "info"), 0);
    const info = JSON.parse(io.stdout.text()) as { api_version: number; chunk_size: number };
    assert.equal(info.api_version, 1);
    assert.equal(info.chunk_size, 4);

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "mkdir", "/sd/a/b"), 0);
    await stat(path.join(mock.rootDir, "a", "b"));

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "mv", "/sd/binary.bin", "/sd/a/b/moved.bin"), 0);
    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "cat", "/sd/a/b/moved.bin"), 0);
    assert.deepEqual([...io.stdout.bytes()], [0, 1, 255]);

    await writeFile(path.join(mock.rootDir, "delete-me.txt"), "delete");
    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "rm", "/sd/delete-me.txt"), 0);
    await assert.rejects(stat(path.join(mock.rootDir, "delete-me.txt")), { code: "ENOENT" });

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "--json", "stat", "/sd/a/b/moved.bin"), 0);
    assert.equal((JSON.parse(io.stdout.text()) as { size: number }).size, 3);

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "rm", "-r", "/sd/a"), 2);
    assert.match(io.stderr.text(), /requires --yes/);
    await stat(path.join(mock.rootDir, "a"));

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "rm", "-r", "--yes", "/sd"), 2);
    assert.match(io.stderr.text(), /Refusing to delete \/sd/);

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "rm", "-r", "--yes", "/sd/a"), 0);
    await assert.rejects(stat(path.join(mock.rootDir, "a")), { code: "ENOENT" });
  } finally {
    await rm(temp, { recursive: true, force: true });
    await mock.close();
  }
});

test("CLI push/upload and pull/download aliases transfer directories", async () => {
  const mock = await new MockDevTools({ chunkSize: 3 }).start();
  const temp = await mkdtemp(path.join(os.tmpdir(), "cubic-cli-"));
  const config = path.join(temp, "config.json");
  try {
    const source = path.join(temp, "source");
    await mkdir(path.join(source, "empty"), { recursive: true });
    await writeFile(path.join(source, "file.bin"), Buffer.from([0, 1, 2, 255]));
    let io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "upload", "source", "/sd/tree"), 0);
    assert.match(io.stderr.text(), /commit/);
    assert.deepEqual([...await readFile(path.join(mock.rootDir, "tree", "file.bin"))], [0, 1, 2, 255]);

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "download", "/sd/tree", "copy"), 0);
    assert.deepEqual([...await readFile(path.join(temp, "copy", "file.bin"))], [0, 1, 2, 255]);
  } finally {
    await rm(temp, { recursive: true, force: true });
    await mock.close();
  }
});

test("CLI DevRun and app workflows validate, upload, list, and remove", async () => {
  const mock = await new MockDevTools().start();
  const temp = await mkdtemp(path.join(os.tmpdir(), "cubic-cli-"));
  const config = path.join(temp, "config.json");
  try {
    await writeFile(path.join(temp, "dev.lua"), "print('cli')\n");
    let io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "devrun", "save", "dev.lua"), 0);
    assert.equal(await readFile(path.join(mock.rootDir, "apps", "devrun", "main.lua"), "utf8"), "print('cli')\n");
    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "devrun", "run", "dev.lua"), 0);
    assert.match(io.stdout.text(), /Ran/);
    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "devrun", "read", "restored.lua"), 0);
    assert.equal(await readFile(path.join(temp, "restored.lua"), "utf8"), "print('cli')\n");

    const appDir = path.join(temp, "sample-app");
    await mkdir(appDir);
    await writeFile(path.join(appDir, "app.info"), "name = Sample\nentry = main.lua\nversion = 1.0.0\n");
    await writeFile(path.join(appDir, "main.lua"), "print('app')\n");
    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "app", "install", "sample-app", "--id", "cli-test"), 0);
    assert.equal(await readFile(path.join(mock.rootDir, "apps", "cli-test", "main.lua"), "utf8"), "print('app')\n");

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "--json", "app", "list"), 0);
    const apps = JSON.parse(io.stdout.text()) as { apps: Array<{ id: string }> };
    assert.ok(apps.apps.some((app) => app.id === "cli-test"));

    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "app", "remove", "devrun", "--yes"), 2);
    assert.match(io.stderr.text(), /Refusing to remove devrun/);
    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "app", "remove", "cli-test"), 2);
    io = cliContext(temp, config);
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "app", "remove", "cli-test", "--yes"), 0);
    await assert.rejects(stat(path.join(mock.rootDir, "apps", "cli-test")), { code: "ENOENT" });
  } finally {
    await rm(temp, { recursive: true, force: true });
    await mock.close();
  }
});

test("CLI returns 2 for usage errors and keeps JSON stdout clean", async () => {
  const mock = await new MockDevTools().start();
  const temp = await mkdtemp(path.join(os.tmpdir(), "cubic-cli-"));
  try {
    let io = cliContext(temp, path.join(temp, "config.json"));
    assert.equal(await execute(io.context, "unknown-command"), 2);
    io = cliContext(temp, path.join(temp, "config.json"));
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "--json", "cat", "/sd/apps/devrun/main.lua"), 2);
    assert.equal(io.stdout.text(), "");
    io = cliContext(temp, path.join(temp, "config.json"));
    assert.equal(await execute(io.context, "--host", mock.baseUrl, "--quiet", "info"), 0);
    assert.equal(io.stdout.text(), "");
    assert.equal(io.stderr.text(), "");
  } finally {
    await rm(temp, { recursive: true, force: true });
    await mock.close();
  }
});
