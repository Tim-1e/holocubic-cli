import path from "node:path";
import { UsageError } from "./errors.js";

export const REMOTE_ROOT = "/sd";

function rejectNul(value: string): void {
  if (value.includes("\0")) throw new UsageError("Remote path contains an invalid NUL character.");
}

export function normalizeRemotePath(input: string | undefined, root = REMOTE_ROOT): string {
  const value = (input ?? "").trim();
  rejectNul(value);
  const unix = value.replace(/\\/g, "/");
  const candidate = unix.startsWith("/") ? unix : path.posix.join(root, unix || ".");
  const normalizedValue = path.posix.normalize(candidate);
  const normalized = normalizedValue.length > 1 ? normalizedValue.replace(/\/+$/, "") : normalizedValue;
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new UsageError(`Remote path must stay below ${root}: ${input ?? ""}`);
  }
  return normalized;
}

export function remoteJoin(parent: string, name: string): string {
  rejectNul(name);
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new UsageError(`Invalid remote entry name: ${name}`);
  }
  return normalizeRemotePath(path.posix.join(normalizeRemotePath(parent), name));
}

export function remoteBasename(remotePath: string): string {
  const normalized = normalizeRemotePath(remotePath);
  return normalized === REMOTE_ROOT ? "sd" : path.posix.basename(normalized);
}

export function assertCanDeleteRemote(remotePath: string): void {
  if (normalizeRemotePath(remotePath) === REMOTE_ROOT) {
    throw new UsageError(`Refusing to delete ${REMOTE_ROOT}.`);
  }
}

export function safeLocalDestination(root: string, relativePath: string): string {
  rejectNul(relativePath);
  const normalizedRelative = relativePath.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalizedRelative)) {
    throw new UsageError(`Unsafe absolute download entry: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalizedRelative.split("/"));
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    throw new UsageError(`Download entry escapes destination: ${relativePath}`);
  }
  return resolved;
}
