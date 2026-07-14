export const LEGACY_V1_CAPABILITIES = [
  "fs.list",
  "fs.stat",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.rename",
  "fs.remove",
  "fs.rmdir",
  "apps.list",
  "devrun.read",
  "devrun.save",
  "devrun.run",
] as const;

export type Capability = (typeof LEGACY_V1_CAPABILITIES)[number] | string;

export interface DeviceInfo {
  ok: true;
  apiVersion: number;
  version: string | null;
  routeBase: string;
  rootPath: string;
  chunkSize: number;
  maxFileSize: number;
  maxCodeBytes: number;
  runAppId: string;
  runAppMain: string;
  capabilities: ReadonlySet<Capability>;
  raw: Record<string, unknown>;
}

export interface RemoteEntry {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  ext: string;
  mime: string;
  category: string;
}

export interface ListResult {
  path: string;
  parent: string;
  dirCount: number;
  fileCount: number;
  totalBytes: number;
  items: RemoteEntry[];
}

export interface RemoteStat {
  path: string;
  name: string;
  parent: string;
  size: number;
  isDir: boolean;
  ext: string;
  mime: string;
  category: string;
}

export interface ReadChunk {
  bytes: Uint8Array;
  size: number;
  nextOffset: number;
  eof: boolean;
  name: string;
  mime: string;
}

export interface UploadResult {
  path: string;
  nextOffset: number;
  total: number;
  done: boolean;
  size: number;
}

export interface AppRecord {
  id: string;
  name?: string;
  path?: string;
  [key: string]: unknown;
}

export interface AppsResult {
  apps: AppRecord[];
  currentAppId: string | null;
  runAppId: string;
  runAppMain: string;
}

export interface DevRunResult {
  id: string;
  entry: string;
  bytes: number;
  launched: boolean;
  rescanRequested: boolean;
}

export interface TransferLimits {
  maxDepth: number;
  maxEntries: number;
  maxDownloadBytes: number;
}

export const DEFAULT_TRANSFER_LIMITS: TransferLimits = {
  maxDepth: 32,
  maxEntries: 4096,
  maxDownloadBytes: 128 * 1024 * 1024,
};
