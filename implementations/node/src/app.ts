import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { CubicError, UsageError } from "./errors.js";
import { remoteJoin } from "./remote-path.js";

export interface ValidatedApp {
  source: string;
  id: string;
  destination: string;
  entry: string;
}
async function requireFile(filePath: string, label: string): Promise<void> {
  try {
    const fileStat = await lstat(filePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("not a regular file");
  } catch (error) {
    throw new CubicError(`App ${label} is missing or is not a regular file: ${filePath}`, {
      code: "INVALID_APP",
      cause: error,
    });
  }
}

export function validateAppId(value: string): string {
  const id = value.trim();
  if (!id || id === "." || id === ".." || /[\x00-\x1f/\\]/.test(id) || id.startsWith(".cubic-")) {
    throw new UsageError(`Invalid app id: ${value}`);
  }
  remoteJoin("/sd/apps", id);
  return id;
}

export async function validateAppDirectory(directory: string, requestedId?: string): Promise<ValidatedApp> {
  const source = path.resolve(directory);
  let sourceStat;
  try {
    sourceStat = await lstat(source);
  } catch (error) {
    throw new CubicError(`App directory does not exist: ${source}`, { code: "INVALID_APP", cause: error });
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new CubicError(`App source is not a regular directory: ${source}`, { code: "INVALID_APP" });
  }
  const infoPath = path.join(source, "app.info");
  await requireFile(infoPath, "metadata");
  const info = await readFile(infoPath, "utf8");
  const entryMatch = info.match(/^\s*entry\s*=\s*(.+?)\s*$/m);
  const entry = entryMatch?.[1]?.trim() || "main.lua";
  if (!entry || path.isAbsolute(entry) || entry.includes("..") || /[\\]/.test(entry)) {
    throw new CubicError(`app.info declares an unsafe entry: ${entry}`, { code: "INVALID_APP" });
  }
  await requireFile(path.join(source, ...entry.split("/")), "entry");
  await requireFile(path.join(source, "main.lua"), "main.lua");
  const id = validateAppId(requestedId ?? path.basename(source));
  return { source, id, destination: remoteJoin("/sd/apps", id), entry };
}
