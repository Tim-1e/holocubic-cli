import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CubicError, UsageError } from "./errors.js";
import { normalizeDeviceUrl } from "./url.js";

export interface DeviceProfile {
  url: string;
  version?: string;
}

export interface CubicConfig {
  version: 1;
  current: string | null;
  devices: Record<string, DeviceProfile>;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.CUBIC_CONFIG) return path.resolve(env.CUBIC_CONFIG);
  if (platform === "win32") {
    const base = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.win32.join(base, "cubic", "config.json");
  }
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(os.homedir(), ".config"), "cubic", "config.json");
}

export function validateDeviceName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || /[\x00-\x1f/\\]/.test(trimmed)) {
    throw new UsageError(`Invalid device name: ${name}`);
  }
  return trimmed;
}

export class ConfigStore {
  readonly filePath: string;

  constructor(filePath = defaultConfigPath()) {
    this.filePath = filePath;
  }

  async read(): Promise<CubicConfig> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, current: null, devices: {} };
      throw new CubicError(`Unable to read config ${this.filePath}.`, { code: "CONFIG_ERROR", cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CubicError(`Config ${this.filePath} is not a JSON object.`, { code: "CONFIG_ERROR" });
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !record.devices || typeof record.devices !== "object" || Array.isArray(record.devices)) {
      throw new CubicError(`Config ${this.filePath} has an unsupported format.`, { code: "CONFIG_ERROR" });
    }
    const devices: Record<string, DeviceProfile> = {};
    for (const [name, value] of Object.entries(record.devices as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const profile = value as Record<string, unknown>;
      if (typeof profile.url !== "string") continue;
      const version = typeof profile.version === "string" ? profile.version : undefined;
      devices[name] = version === undefined ? { url: normalizeDeviceUrl(profile.url) } : { url: normalizeDeviceUrl(profile.url), version };
    }
    const current = typeof record.current === "string" && devices[record.current] ? record.current : null;
    return { version: 1, current, devices };
  }

  async write(config: CubicConfig): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.filePath);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new CubicError(`Unable to write config ${this.filePath}.`, { code: "CONFIG_ERROR", cause: error });
    }
  }
}

export interface ResolvedDevice {
  url: string;
  name: string | null;
  source: "option" | "environment" | "config";
}

export async function resolveDevice(
  store: ConfigStore,
  optionHost?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedDevice> {
  if (optionHost) return { url: normalizeDeviceUrl(optionHost), name: null, source: "option" };
  if (env.CUBIC_HOST) return { url: normalizeDeviceUrl(env.CUBIC_HOST), name: null, source: "environment" };
  const config = await store.read();
  const current = config.current;
  const profile = current ? config.devices[current] : undefined;
  if (!current || !profile) {
    throw new CubicError("No device selected. Run `cubic device add <name> <host>` or pass --host.", {
      code: "NO_DEVICE",
    });
  }
  return { url: profile.url, name: current, source: "config" };
}
