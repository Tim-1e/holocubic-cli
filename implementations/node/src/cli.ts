#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { validateAppDirectory, validateAppId } from "./app.js";
import { CubicClient } from "./client.js";
import {
  ConfigStore,
  defaultConfigPath,
  resolveDevice,
  validateDeviceName,
  type CubicConfig,
} from "./config.js";
import { CubicError, UsageError, errorMessage } from "./errors.js";
import { assertCanDeleteRemote, normalizeRemotePath, remoteJoin } from "./remote-path.js";
import { downloadPath, ensureRemoteDirectory, uploadPath, type TransferProgress } from "./transfer.js";
import type { DeviceInfo } from "./types.js";
import { normalizeDeviceUrl } from "./url.js";

export const VERSION = "0.1.0-beta.1";

export interface CliWriter {
  write(chunk: string | Uint8Array): unknown;
  isTTY?: boolean;
}

export interface CliContext {
  stdout: CliWriter;
  stderr: CliWriter;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

interface GlobalOptions {
  host?: string;
  timeout: number;
  json: boolean;
  quiet: boolean;
  config?: string;
}

const defaultContext: CliContext = {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
};

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new InvalidArgumentError("must be a positive integer");
  return parsed;
}

function jsonSafe(value: unknown): unknown {
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function writeLine(writer: CliWriter, line = ""): void {
  writer.write(`${line}\n`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function createProgram(context: CliContext = defaultContext): Command {
  const program = new Command();
  program
    .name("cubic")
    .description("Manage HoloCubic DevTools devices and SD-card files")
    .version(VERSION)
    .option("-H, --host <url>", "use a device without changing saved configuration")
    .option("--timeout <ms>", "HTTP timeout in milliseconds", parsePositiveInteger, 60_000)
    .option("--json", "write stable JSON to stdout", false)
    .option("--quiet", "suppress progress and success messages", false)
    .option("--config <file>", "override the configuration file")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (value) => context.stdout.write(value),
      writeErr: (value) => context.stderr.write(value),
    });

  function globalOptions(): GlobalOptions {
    return program.opts<GlobalOptions>();
  }

  function store(): ConfigStore {
    const options = globalOptions();
    return new ConfigStore(options.config ? path.resolve(context.cwd, options.config) : defaultConfigPath(context.env));
  }

  async function client(): Promise<{ client: CubicClient; name: string | null; url: string }> {
    const options = globalOptions();
    const resolved = await resolveDevice(store(), options.host, context.env);
    return { client: new CubicClient(resolved.url, options.timeout), name: resolved.name, url: resolved.url };
  }

  function output(value: unknown, human: () => void): void {
    const options = globalOptions();
    if (options.json) writeLine(context.stdout, JSON.stringify(jsonSafe(value)));
    else if (!options.quiet) human();
  }

  function progress(event: TransferProgress): void {
    const options = globalOptions();
    if (options.quiet || options.json) return;
    if (event.phase === "scan") {
      writeLine(context.stderr, `Scanning ${event.path} ...`);
      return;
    }
    const total = event.totalBytes ? ` / ${formatBytes(event.totalBytes)}` : "";
    const line = `${event.phase.padEnd(8)} ${formatBytes(event.transferredBytes)}${total}  ${event.path}`;
    if (context.stderr.isTTY) context.stderr.write(`\r${line.padEnd(90)}`);
    else if (event.phase === "commit" || event.transferredBytes === event.totalBytes) writeLine(context.stderr, line);
    if (context.stderr.isTTY && event.phase === "commit") context.stderr.write("\n");
  }

  const device = program.command("device").description("manage saved devices");
  device
    .command("add <name> <host>")
    .description("verify and save a device")
    .option("--no-use", "do not select the newly added device")
    .action(async (name: string, host: string, options: { use: boolean }) => {
      const validName = validateDeviceName(name);
      const url = normalizeDeviceUrl(host);
      const info = await new CubicClient(url, globalOptions().timeout).info(true);
      const configStore = store();
      const config = await configStore.read();
      config.devices[validName] = info.version ? { url, version: info.version } : { url };
      if (options.use) config.current = validName;
      await configStore.write(config);
      output({ name: validName, url, selected: config.current === validName, version: info.version }, () => {
        writeLine(context.stdout, `Added ${validName}: ${url}`);
        if (config.current === validName) writeLine(context.stdout, `Selected device: ${validName}`);
      });
    });

  device
    .command("list")
    .description("list saved devices")
    .action(async () => {
      const config = await store().read();
      const rows = Object.entries(config.devices)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, profile]) => ({ name, url: profile.url, version: profile.version ?? null, selected: name === config.current }));
      output({ current: config.current, devices: rows }, () => {
        if (!rows.length) return writeLine(context.stdout, "No saved devices.");
        for (const row of rows) writeLine(context.stdout, `${row.selected ? "*" : " "} ${row.name.padEnd(16)} ${row.url}${row.version ? `  ${row.version}` : ""}`);
      });
    });

  device
    .command("use <name>")
    .description("select a saved device")
    .action(async (name: string) => {
      const validName = validateDeviceName(name);
      const configStore = store();
      const config = await configStore.read();
      if (!config.devices[validName]) throw new CubicError(`Unknown device: ${validName}`, { code: "NO_DEVICE" });
      config.current = validName;
      await configStore.write(config);
      output({ current: validName }, () => writeLine(context.stdout, `Selected device: ${validName}`));
    });

  device
    .command("remove <name>")
    .description("remove a saved device")
    .action(async (name: string) => {
      const validName = validateDeviceName(name);
      const configStore = store();
      const config = await configStore.read();
      if (!config.devices[validName]) throw new CubicError(`Unknown device: ${validName}`, { code: "NO_DEVICE" });
      delete config.devices[validName];
      if (config.current === validName) config.current = null;
      await configStore.write(config);
      output({ removed: validName, current: config.current }, () => writeLine(context.stdout, `Removed device: ${validName}`));
    });

  program
    .command("ping")
    .description("test the selected device")
    .action(async () => {
      const target = await client();
      const started = performance.now();
      const info = await target.client.info(true);
      const latencyMs = Math.round(performance.now() - started);
      output({ ok: true, name: target.name, url: target.url, latency_ms: latencyMs, version: info.version }, () => {
        writeLine(context.stdout, `Connected to ${target.name ?? target.url} in ${latencyMs} ms${info.version ? ` (${info.version})` : ""}.`);
      });
    });

  program
    .command("info")
    .description("show device capabilities and transfer limits")
    .action(async () => {
      const target = await client();
      const info = await target.client.info(true);
      const result = publicInfo(info, target.name, target.url);
      output(result, () => {
        writeLine(context.stdout, `Device:       ${target.name ?? "(temporary)"}`);
        writeLine(context.stdout, `URL:          ${target.url}`);
        writeLine(context.stdout, `Version:      ${info.version ?? "unknown"}`);
        writeLine(context.stdout, `API:          v${info.apiVersion}`);
        writeLine(context.stdout, `Root:         ${info.rootPath}`);
        writeLine(context.stdout, `Chunk size:   ${formatBytes(info.chunkSize)}`);
        writeLine(context.stdout, `Max file:     ${formatBytes(info.maxFileSize)}`);
        writeLine(context.stdout, `Capabilities: ${[...info.capabilities].join(", ")}`);
      });
    });

  program
    .command("ls [remote]")
    .description("list a remote directory")
    .action(async (remote?: string) => {
      const { client: currentClient } = await client();
      const result = await currentClient.list(normalizeRemotePath(remote));
      output(result, () => {
        for (const item of result.items) {
          writeLine(context.stdout, `${item.isDir ? "d" : "-"} ${item.isDir ? "".padStart(10) : String(item.size).padStart(10)}  ${item.name}${item.isDir ? "/" : ""}`);
        }
      });
    });

  program
    .command("stat <remote>")
    .description("show remote file or directory metadata")
    .action(async (remote: string) => {
      const { client: currentClient } = await client();
      const result = await currentClient.stat(remote);
      output(result, () => {
        writeLine(context.stdout, `Path: ${result.path}`);
        writeLine(context.stdout, `Type: ${result.isDir ? "directory" : "file"}`);
        writeLine(context.stdout, `Size: ${result.size} bytes`);
        writeLine(context.stdout, `MIME: ${result.mime}`);
      });
    });

  program
    .command("cat <remote>")
    .description("write a remote file to stdout")
    .action(async (remote: string) => {
      if (globalOptions().json) throw new UsageError("`cat` cannot be combined with --json.");
      const { client: currentClient } = await client();
      const remotePath = normalizeRemotePath(remote);
      const item = await currentClient.stat(remotePath);
      if (item.isDir) throw new CubicError(`Remote source is a directory: ${remotePath}`, { code: "NOT_A_FILE" });
      const info = await currentClient.info();
      let offset = 0;
      while (offset < item.size) {
        const chunk = await currentClient.read(remotePath, offset, Math.min(info.chunkSize, item.size - offset));
        if (chunk.nextOffset !== offset + chunk.bytes.length || chunk.bytes.length === 0) {
          throw new CubicError(`Device returned an invalid read offset for ${remotePath}.`, { code: "INVALID_RESPONSE" });
        }
        context.stdout.write(chunk.bytes);
        offset = chunk.nextOffset;
      }
    });

  program
    .command("mkdir <remote>")
    .description("create a remote directory and missing parents")
    .action(async (remote: string) => {
      const { client: currentClient } = await client();
      const target = normalizeRemotePath(remote);
      await ensureRemoteDirectory(currentClient, target);
      output({ path: target }, () => writeLine(context.stdout, `Created ${target}`));
    });

  program
    .command("mv <source> <target>")
    .description("rename or move a remote path")
    .action(async (source: string, target: string) => {
      const { client: currentClient } = await client();
      const sourcePath = normalizeRemotePath(source);
      const targetPath = normalizeRemotePath(target);
      await currentClient.rename(sourcePath, targetPath);
      output({ source: sourcePath, target: targetPath }, () => writeLine(context.stdout, `Moved ${sourcePath} -> ${targetPath}`));
    });

  program
    .command("rm <remote>")
    .description("remove a remote file or directory")
    .option("-r, --recursive", "remove a directory recursively", false)
    .option("-y, --yes", "confirm recursive deletion", false)
    .action(async (remote: string, options: { recursive: boolean; yes: boolean }) => {
      const { client: currentClient } = await client();
      const target = normalizeRemotePath(remote);
      assertCanDeleteRemote(target);
      const item = await currentClient.stat(target);
      if (item.isDir) {
        if (!options.recursive) throw new UsageError(`Remote path is a directory; use --recursive: ${target}`);
        if (!options.yes) throw new UsageError("Recursive deletion requires --yes.");
        await currentClient.rmdir(target, true);
      } else {
        await currentClient.remove(target);
      }
      output({ removed: target, recursive: item.isDir }, () => writeLine(context.stdout, `Removed ${target}`));
    });

  function transferOptions(command: Command): Command {
    return command
      .option("-f, --force", "replace an existing target", false)
      .option("--retries <count>", "retry transient chunk failures", parsePositiveInteger, 2)
      .option("--max-depth <count>", "recursive depth limit", parsePositiveInteger, 32)
      .option("--max-entries <count>", "recursive entry limit", parsePositiveInteger, 4096);
  }

  transferOptions(program.command("push <local> [remote]").alias("upload").description("upload a file or directory recursively")).action(
    async (local: string, remote: string | undefined, options: { force: boolean; retries: number; maxDepth: number; maxEntries: number }) => {
      const { client: currentClient } = await client();
      const result = await uploadPath(currentClient, path.resolve(context.cwd, local), remote, {
        force: options.force,
        retries: options.retries,
        limits: { maxDepth: options.maxDepth, maxEntries: options.maxEntries },
        onProgress: progress,
      });
      output(result, () => writeLine(context.stdout, `Uploaded ${result.files} file(s), ${formatBytes(result.bytes)} -> ${result.destination}`));
    },
  );

  transferOptions(program.command("pull <remote> [local]").alias("download").description("download a file or directory recursively"))
    .option("--max-bytes <count>", "aggregate directory download limit", parsePositiveInteger, 128 * 1024 * 1024)
    .action(async (remote: string, local: string | undefined, options: { force: boolean; retries: number; maxDepth: number; maxEntries: number; maxBytes: number }) => {
      const { client: currentClient } = await client();
      const result = await downloadPath(currentClient, remote, local ? path.resolve(context.cwd, local) : undefined, {
        force: options.force,
        retries: options.retries,
        limits: { maxDepth: options.maxDepth, maxEntries: options.maxEntries, maxDownloadBytes: options.maxBytes },
        onProgress: progress,
      });
      output(result, () => writeLine(context.stdout, `Downloaded ${result.files} file(s), ${formatBytes(result.bytes)} -> ${result.destination}`));
    });

  const devrun = program.command("devrun").description("read, save, or run DevRun source");
  devrun
    .command("read [output]")
    .description("read DevRun source")
    .option("-f, --force", "replace an existing local output", false)
    .action(async (destination: string | undefined, options: { force: boolean }) => {
      const { client: currentClient } = await client();
      const source = await currentClient.readDevRun();
      if (!destination) {
        if (globalOptions().json) output({ source }, () => undefined);
        else context.stdout.write(source);
        return;
      }
      const outputPath = path.resolve(context.cwd, destination);
      await writeFile(outputPath, source, { encoding: "utf8", flag: options.force ? "w" : "wx" });
      output({ path: outputPath, bytes: Buffer.byteLength(source) }, () => writeLine(context.stdout, `Saved DevRun source to ${outputPath}`));
    });

  for (const run of [false, true]) {
    devrun
      .command(`${run ? "run" : "save"} <file>`)
      .description(`${run ? "save and run" : "save"} DevRun source`)
      .action(async (file: string) => {
        const source = await readFile(path.resolve(context.cwd, file), "utf8");
        const { client: currentClient } = await client();
        const result = await currentClient.saveDevRun(source, run);
        output(result, () => writeLine(context.stdout, `${run ? "Ran" : "Saved"} ${result.entry} (${result.bytes} bytes)`));
      });
  }

  const app = program.command("app").description("list and install SD-card apps");
  app
    .command("list")
    .description("list installed apps")
    .action(async () => {
      const { client: currentClient } = await client();
      const result = await currentClient.apps();
      output(result, () => {
        for (const item of result.apps) writeLine(context.stdout, `${item.id}${item.id === result.currentAppId ? " *" : ""}`);
      });
    });

  app
    .command("install <directory>")
    .description("validate and upload an app directory")
    .option("--id <id>", "override the destination app id")
    .option("-f, --force", "replace an existing app", false)
    .action(async (directory: string, options: { id?: string; force: boolean }) => {
      const validated = await validateAppDirectory(path.resolve(context.cwd, directory), options.id);
      const { client: currentClient } = await client();
      const apps = await currentClient.apps();
      if (validated.id === apps.runAppId) {
        throw new UsageError(`Refusing to replace ${apps.runAppId}; use the dedicated devrun commands.`);
      }
      if (validated.id === apps.currentAppId) {
        throw new UsageError(`Refusing to replace the currently running app ${validated.id}; switch apps first.`);
      }
      const transfer = await uploadPath(currentClient, validated.source, validated.destination, {
        force: options.force,
        onProgress: progress,
      });
      const result = { ...validated, transfer, rescanRequired: true };
      output(result, () => {
        writeLine(context.stdout, `Installed ${validated.id} -> ${validated.destination}`);
        writeLine(context.stdout, "Rescan apps on the device before first launch.");
      });
    });

  app
    .command("remove <id>")
    .description("remove an installed app directory")
    .requiredOption("-y, --yes", "confirm app removal")
    .action(async (id: string) => {
      const validId = validateAppId(id);
      const target = remoteJoin("/sd/apps", validId);
      const { client: currentClient } = await client();
      const apps = await currentClient.apps();
      if (validId === apps.runAppId) {
        throw new UsageError(`Refusing to remove ${apps.runAppId}; it is managed by the dedicated devrun commands.`);
      }
      if (validId === apps.currentAppId) {
        throw new UsageError(`Refusing to remove the currently running app ${validId}; switch apps first.`);
      }
      await currentClient.rmdir(target, true);
      output({ removed: validId, path: target }, () => writeLine(context.stdout, `Removed app ${validId}`));
    });

  return program;
}

function publicInfo(info: DeviceInfo, name: string | null, url: string): Record<string, unknown> {
  return {
    name,
    url,
    version: info.version,
    api_version: info.apiVersion,
    route_base: info.routeBase,
    root_path: info.rootPath,
    chunk_size: info.chunkSize,
    max_file_size: info.maxFileSize,
    max_code_bytes: info.maxCodeBytes,
    run_app_id: info.runAppId,
    run_app_main: info.runAppMain,
    capabilities: [...info.capabilities],
  };
}

export async function runCli(argv = process.argv, context: CliContext = defaultContext): Promise<number> {
  try {
    await createProgram(context).parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      return 2;
    }
    const exitCode = error instanceof CubicError ? error.exitCode : 1;
    writeLine(context.stderr, `cubic: ${errorMessage(error)}`);
    return exitCode;
  }
}

function realPathOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return realpathSync(value);
  } catch {
    return null;
  }
}

const invokedPath = realPathOrNull(process.argv[1]);
const modulePath = realPathOrNull(fileURLToPath(import.meta.url));
if (invokedPath && modulePath && invokedPath === modulePath) {
  process.exitCode = await runCli();
}
