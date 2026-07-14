import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat as localStat,
} from "node:fs/promises";
import path from "node:path";
import { CubicClient } from "./client.js";
import { CubicError, HttpError, errorMessage } from "./errors.js";
import {
  normalizeRemotePath,
  remoteBasename,
  remoteJoin,
  safeLocalDestination,
} from "./remote-path.js";
import {
  DEFAULT_TRANSFER_LIMITS,
  type RemoteStat,
  type TransferLimits,
} from "./types.js";

export interface TransferProgress {
  phase: "scan" | "upload" | "download" | "commit";
  path: string;
  transferredBytes: number;
  totalBytes: number;
  completedEntries: number;
  totalEntries: number;
}

export interface TransferOptions {
  force?: boolean | undefined;
  retries?: number | undefined;
  limits?: Partial<TransferLimits> | undefined;
  onProgress?: ((progress: TransferProgress) => void) | undefined;
}

export interface TransferSummary {
  source: string;
  destination: string;
  files: number;
  directories: number;
  bytes: number;
}

interface LocalFile {
  absolute: string;
  relative: string;
  size: number;
}

interface LocalTree {
  directories: string[];
  files: LocalFile[];
  totalBytes: number;
}

interface RemoteFile {
  remote: string;
  relative: string;
  size: number;
}

interface RemoteTree {
  directories: string[];
  files: RemoteFile[];
  totalBytes: number;
}

function limits(options: TransferOptions): TransferLimits {
  return { ...DEFAULT_TRANSFER_LIMITS, ...options.limits };
}

function uniqueSuffix(): string {
  return `${process.pid}-${randomBytes(5).toString("hex")}`;
}

async function existingLocal(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function transient(error: unknown): boolean {
  return (
    (error instanceof HttpError && error.status >= 500) ||
    (error instanceof CubicError && (error.code === "TIMEOUT" || error.code === "CONNECTION_ERROR"))
  );
}

async function withRetry<T>(operation: () => Promise<T>, retries: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!transient(error) || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
  throw lastError;
}

export async function ensureRemoteDirectory(client: CubicClient, remoteDirectory: string): Promise<void> {
  const normalized = normalizeRemotePath(remoteDirectory);
  if (normalized === "/sd") return;
  const segments = normalized.slice(4).split("/");
  let current = "/sd";
  for (const segment of segments) {
    current = remoteJoin(current, segment);
    const currentStat = await client.statOrNull(current);
    if (!currentStat) {
      await client.mkdir(current);
    } else if (!currentStat.isDir) {
      throw new CubicError(`Remote parent is a file: ${current}`, { code: "PATH_CONFLICT" });
    }
  }
}

async function removeRemotePath(client: CubicClient, remotePath: string): Promise<void> {
  const target = await client.statOrNull(remotePath);
  if (!target) return;
  if (target.isDir) await client.rmdir(remotePath, true);
  else await client.remove(remotePath);
}

async function commitRemote(
  client: CubicClient,
  temporary: string,
  target: string,
  currentTarget: RemoteStat | null,
  force: boolean,
): Promise<void> {
  if (currentTarget && !force) {
    throw new CubicError(`Remote target already exists: ${target}. Use --force to replace it.`, {
      code: "TARGET_EXISTS",
    });
  }
  const backup = `${target}.cubic-backup-${uniqueSuffix()}`;
  let backedUp = false;
  if (currentTarget) {
    await client.rename(target, backup);
    backedUp = true;
  }
  try {
    await client.rename(temporary, target);
  } catch (error) {
    if (backedUp) {
      await client.rename(backup, target).catch(() => undefined);
    }
    throw new CubicError(`Unable to commit remote target ${target}: ${errorMessage(error)}`, {
      code: "COMMIT_FAILED",
      cause: error,
    });
  }
  if (backedUp) await removeRemotePath(client, backup);
}

async function scanLocalTree(root: string, transferLimits: TransferLimits): Promise<LocalTree> {
  const directories: string[] = [];
  const files: LocalFile[] = [];
  let entries = 0;
  let totalBytes = 0;

  async function visit(absolute: string, relative: string, depth: number): Promise<void> {
    if (depth > transferLimits.maxDepth) {
      throw new CubicError(`Local directory exceeds maximum depth ${transferLimits.maxDepth}: ${absolute}`, {
        code: "TREE_LIMIT",
      });
    }
    const children = await readdir(absolute, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      entries += 1;
      if (entries > transferLimits.maxEntries) {
        throw new CubicError(`Local directory exceeds maximum entries ${transferLimits.maxEntries}.`, {
          code: "TREE_LIMIT",
        });
      }
      const childAbsolute = path.join(absolute, child.name);
      const childRelative = relative ? path.posix.join(relative, child.name) : child.name;
      const childStat = await lstat(childAbsolute);
      if (childStat.isSymbolicLink()) {
        throw new CubicError(`Symbolic links are not followed: ${childAbsolute}`, { code: "SYMLINK_REJECTED" });
      }
      if (childStat.isDirectory()) {
        directories.push(childRelative);
        await visit(childAbsolute, childRelative, depth + 1);
      } else if (childStat.isFile()) {
        files.push({ absolute: childAbsolute, relative: childRelative, size: childStat.size });
        totalBytes += childStat.size;
      } else {
        throw new CubicError(`Unsupported local filesystem entry: ${childAbsolute}`, { code: "UNSUPPORTED_ENTRY" });
      }
    }
  }

  await visit(root, "", 0);
  return { directories, files, totalBytes };
}

async function scanRemoteTree(client: CubicClient, root: string, transferLimits: TransferLimits): Promise<RemoteTree> {
  const directories: string[] = [];
  const files: RemoteFile[] = [];
  const seen = new Set<string>();
  let entryCount = 0;
  let totalBytes = 0;

  async function visit(current: string, relative: string, depth: number): Promise<void> {
    if (depth > transferLimits.maxDepth) {
      throw new CubicError(`Remote directory exceeds maximum depth ${transferLimits.maxDepth}: ${current}`, {
        code: "TREE_LIMIT",
      });
    }
    const result = await client.list(current);
    for (const item of result.items) {
      entryCount += 1;
      if (entryCount > transferLimits.maxEntries) {
        throw new CubicError(`Remote directory exceeds maximum entries ${transferLimits.maxEntries}.`, {
          code: "TREE_LIMIT",
        });
      }
      const expected = remoteJoin(current, item.name);
      if (item.path !== expected) {
        throw new CubicError(`Unsafe directory entry path returned by device: ${item.path}`, {
          code: "UNSAFE_REMOTE_ENTRY",
        });
      }
      const itemRelative = relative ? path.posix.join(relative, item.name) : item.name;
      if (seen.has(itemRelative)) {
        throw new CubicError(`Duplicate remote directory entry: ${itemRelative}`, { code: "INVALID_RESPONSE" });
      }
      seen.add(itemRelative);
      if (item.isDir) {
        directories.push(itemRelative);
        await visit(item.path, itemRelative, depth + 1);
      } else {
        files.push({ remote: item.path, relative: itemRelative, size: item.size });
        totalBytes += item.size;
        if (totalBytes > transferLimits.maxDownloadBytes) {
          throw new CubicError(
            `Remote directory exceeds download limit ${transferLimits.maxDownloadBytes} bytes.`,
            { code: "TREE_LIMIT" },
          );
        }
      }
    }
  }

  await visit(root, "", 0);
  return { directories, files, totalBytes };
}

export async function uploadFile(
  client: CubicClient,
  localFile: string,
  remoteFile: string,
  options: TransferOptions = {},
): Promise<TransferSummary> {
  const source = path.resolve(localFile);
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    throw new CubicError(`Symbolic links are not followed: ${source}`, { code: "SYMLINK_REJECTED" });
  }
  if (!sourceStat.isFile()) throw new CubicError(`Local source is not a file: ${source}`, { code: "NOT_A_FILE" });
  const target = normalizeRemotePath(remoteFile);
  const info = await client.info();
  if (sourceStat.size > info.maxFileSize) {
    throw new CubicError(`Local file is ${sourceStat.size} bytes; device limit is ${info.maxFileSize} bytes.`, {
      code: "FILE_TOO_LARGE",
    });
  }
  const currentTarget = await client.statOrNull(target);
  if (currentTarget?.isDir) throw new CubicError(`Remote target is a directory: ${target}`, { code: "PATH_CONFLICT" });
  if (currentTarget && !options.force) {
    throw new CubicError(`Remote target already exists: ${target}. Use --force to replace it.`, {
      code: "TARGET_EXISTS",
    });
  }
  await ensureRemoteDirectory(client, path.posix.dirname(target));
  const temporary = `${target}.cubic-upload-${uniqueSuffix()}`;
  const retries = Math.max(0, options.retries ?? 2);
  let offset = 0;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    if (sourceStat.size === 0) {
      const result = await withRetry(() => client.upload(temporary, new Uint8Array(), 0, 0), retries);
      if (!result.done || result.nextOffset !== 0) throw new CubicError("Device did not complete the empty upload.", { code: "INVALID_RESPONSE" });
    } else {
      handle = await open(source, "r");
      while (offset < sourceStat.size) {
        const length = Math.min(info.chunkSize, sourceStat.size - offset);
        const buffer = Buffer.allocUnsafe(length);
        const readResult = await handle.read(buffer, 0, length, offset);
        if (readResult.bytesRead !== length) throw new CubicError(`Unexpected end of local file: ${source}`, { code: "LOCAL_READ_ERROR" });
        const result = await withRetry(() => client.upload(temporary, buffer, offset, sourceStat.size), retries);
        if (result.nextOffset !== offset + length || result.total !== sourceStat.size) {
          throw new CubicError(`Device returned an invalid upload offset for ${target}.`, { code: "INVALID_RESPONSE" });
        }
        offset = result.nextOffset;
        options.onProgress?.({
          phase: "upload",
          path: target,
          transferredBytes: offset,
          totalBytes: sourceStat.size,
          completedEntries: offset === sourceStat.size ? 1 : 0,
          totalEntries: 1,
        });
      }
    }
    await handle?.close();
    handle = null;
    const uploaded = await client.stat(temporary);
    if (uploaded.isDir || uploaded.size !== sourceStat.size) {
      throw new CubicError(`Remote upload verification failed for ${target}.`, { code: "VERIFY_FAILED" });
    }
    options.onProgress?.({ phase: "commit", path: target, transferredBytes: sourceStat.size, totalBytes: sourceStat.size, completedEntries: 1, totalEntries: 1 });
    await commitRemote(client, temporary, target, currentTarget, Boolean(options.force));
    return { source, destination: target, files: 1, directories: 0, bytes: sourceStat.size };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await removeRemotePath(client, temporary).catch(() => undefined);
    throw error;
  }
}

export async function uploadPath(
  client: CubicClient,
  localSource: string,
  remoteDestination?: string,
  options: TransferOptions = {},
): Promise<TransferSummary> {
  const source = path.resolve(localSource);
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) {
    throw new CubicError(`Symbolic links are not followed: ${source}`, { code: "SYMLINK_REJECTED" });
  }
  const basename = path.basename(source);
  const target = normalizeRemotePath(remoteDestination ?? remoteJoin("/sd", basename));
  if (sourceStat.isFile()) return uploadFile(client, source, target, options);
  if (!sourceStat.isDirectory()) throw new CubicError(`Unsupported local source: ${source}`, { code: "UNSUPPORTED_ENTRY" });

  const transferLimits = limits(options);
  options.onProgress?.({ phase: "scan", path: source, transferredBytes: 0, totalBytes: 0, completedEntries: 0, totalEntries: 0 });
  const tree = await scanLocalTree(source, transferLimits);
  const info = await client.info();
  const oversized = tree.files.find((file) => file.size > info.maxFileSize);
  if (oversized) {
    throw new CubicError(`Local file is ${oversized.size} bytes; device limit is ${info.maxFileSize}: ${oversized.absolute}`, {
      code: "FILE_TOO_LARGE",
    });
  }
  const currentTarget = await client.statOrNull(target);
  if (currentTarget && !options.force) {
    throw new CubicError(`Remote target already exists: ${target}. Use --force to replace it.`, { code: "TARGET_EXISTS" });
  }
  await ensureRemoteDirectory(client, path.posix.dirname(target));
  const temporary = `${target}.cubic-upload-${uniqueSuffix()}`;
  let transferred = 0;
  let completed = 0;
  try {
    await client.mkdir(temporary);
    for (const directory of tree.directories) {
      await ensureRemoteDirectory(client, path.posix.join(temporary, directory));
      completed += 1;
    }
    for (const file of tree.files) {
      const before = transferred;
      await uploadFile(client, file.absolute, path.posix.join(temporary, file.relative), {
        retries: options.retries,
        onProgress: (progress) => {
          options.onProgress?.({
            phase: progress.phase,
            path: file.relative,
            transferredBytes: before + progress.transferredBytes,
            totalBytes: tree.totalBytes,
            completedEntries: completed,
            totalEntries: tree.directories.length + tree.files.length,
          });
        },
      });
      transferred += file.size;
      completed += 1;
    }
    options.onProgress?.({ phase: "commit", path: target, transferredBytes: tree.totalBytes, totalBytes: tree.totalBytes, completedEntries: completed, totalEntries: tree.directories.length + tree.files.length });
    await commitRemote(client, temporary, target, currentTarget, Boolean(options.force));
    return {
      source,
      destination: target,
      files: tree.files.length,
      directories: tree.directories.length + 1,
      bytes: tree.totalBytes,
    };
  } catch (error) {
    await removeRemotePath(client, temporary).catch(() => undefined);
    throw error;
  }
}

async function commitLocal(temporary: string, target: string, currentTarget: Awaited<ReturnType<typeof lstat>> | null, force: boolean): Promise<void> {
  if (currentTarget && !force) {
    throw new CubicError(`Local target already exists: ${target}. Use --force to replace it.`, { code: "TARGET_EXISTS" });
  }
  const backup = `${target}.cubic-backup-${uniqueSuffix()}`;
  let backedUp = false;
  if (currentTarget) {
    await rename(target, backup);
    backedUp = true;
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    if (backedUp) await rename(backup, target).catch(() => undefined);
    throw new CubicError(`Unable to commit local target ${target}: ${errorMessage(error)}`, {
      code: "COMMIT_FAILED",
      cause: error,
    });
  }
  if (backedUp) await rm(backup, { recursive: true, force: true });
}

export async function downloadFile(
  client: CubicClient,
  remoteFile: string,
  localFile: string,
  options: TransferOptions = {},
): Promise<TransferSummary> {
  const source = normalizeRemotePath(remoteFile);
  const sourceStat = await client.stat(source);
  if (sourceStat.isDir) throw new CubicError(`Remote source is a directory: ${source}`, { code: "NOT_A_FILE" });
  const transferLimits = limits(options);
  if (sourceStat.size > transferLimits.maxDownloadBytes) {
    throw new CubicError(`Remote file exceeds download limit ${transferLimits.maxDownloadBytes} bytes: ${source}`, {
      code: "TREE_LIMIT",
    });
  }
  const target = path.resolve(localFile);
  const currentTarget = await existingLocal(target);
  if (currentTarget?.isDirectory()) throw new CubicError(`Local target is a directory: ${target}`, { code: "PATH_CONFLICT" });
  if (currentTarget && !options.force) {
    throw new CubicError(`Local target already exists: ${target}. Use --force to replace it.`, { code: "TARGET_EXISTS" });
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.cubic-download-${uniqueSuffix()}`;
  const info = await client.info();
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let offset = 0;
  try {
    handle = await open(temporary, "wx");
    while (offset < sourceStat.size) {
      const chunk = await withRetry(
        () => client.read(source, offset, Math.min(info.chunkSize, sourceStat.size - offset)),
        Math.max(0, options.retries ?? 2),
      );
      if (chunk.size !== sourceStat.size || chunk.nextOffset !== offset + chunk.bytes.length || chunk.bytes.length === 0) {
        throw new CubicError(`Device returned an invalid read offset for ${source}.`, { code: "INVALID_RESPONSE" });
      }
      await handle.write(chunk.bytes, 0, chunk.bytes.length, offset);
      offset = chunk.nextOffset;
      if (chunk.eof && offset !== sourceStat.size) {
        throw new CubicError(`Device ended the download early for ${source}.`, { code: "INVALID_RESPONSE" });
      }
      options.onProgress?.({ phase: "download", path: source, transferredBytes: offset, totalBytes: sourceStat.size, completedEntries: offset === sourceStat.size ? 1 : 0, totalEntries: 1 });
    }
    await handle.close();
    handle = null;
    if ((await localStat(temporary)).size !== sourceStat.size) {
      throw new CubicError(`Local download verification failed for ${source}.`, { code: "VERIFY_FAILED" });
    }
    options.onProgress?.({ phase: "commit", path: target, transferredBytes: sourceStat.size, totalBytes: sourceStat.size, completedEntries: 1, totalEntries: 1 });
    await commitLocal(temporary, target, currentTarget, Boolean(options.force));
    return { source, destination: target, files: 1, directories: 0, bytes: sourceStat.size };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function downloadPath(
  client: CubicClient,
  remoteSource: string,
  localDestination?: string,
  options: TransferOptions = {},
): Promise<TransferSummary> {
  const source = normalizeRemotePath(remoteSource);
  const sourceStat = await client.stat(source);
  const target = path.resolve(localDestination ?? remoteBasename(source));
  if (!sourceStat.isDir) return downloadFile(client, source, target, options);

  const transferLimits = limits(options);
  options.onProgress?.({ phase: "scan", path: source, transferredBytes: 0, totalBytes: 0, completedEntries: 0, totalEntries: 0 });
  const tree = await scanRemoteTree(client, source, transferLimits);
  const currentTarget = await existingLocal(target);
  if (currentTarget && !options.force) {
    throw new CubicError(`Local target already exists: ${target}. Use --force to replace it.`, { code: "TARGET_EXISTS" });
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.cubic-download-${uniqueSuffix()}`;
  let transferred = 0;
  let completed = 0;
  try {
    await mkdir(temporary);
    for (const directory of tree.directories) {
      await mkdir(safeLocalDestination(temporary, directory), { recursive: true });
      completed += 1;
    }
    for (const file of tree.files) {
      const destination = safeLocalDestination(temporary, file.relative);
      const before = transferred;
      await downloadFile(client, file.remote, destination, {
        retries: options.retries,
        limits: { ...transferLimits, maxDownloadBytes: file.size },
        onProgress: (progress) => {
          options.onProgress?.({
            phase: progress.phase,
            path: file.relative,
            transferredBytes: before + progress.transferredBytes,
            totalBytes: tree.totalBytes,
            completedEntries: completed,
            totalEntries: tree.directories.length + tree.files.length,
          });
        },
      });
      transferred += file.size;
      completed += 1;
    }
    options.onProgress?.({ phase: "commit", path: target, transferredBytes: tree.totalBytes, totalBytes: tree.totalBytes, completedEntries: completed, totalEntries: tree.directories.length + tree.files.length });
    await commitLocal(temporary, target, currentTarget, Boolean(options.force));
    return {
      source,
      destination: target,
      files: tree.files.length,
      directories: tree.directories.length + 1,
      bytes: tree.totalBytes,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
