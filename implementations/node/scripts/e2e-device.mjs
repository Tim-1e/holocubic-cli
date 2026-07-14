import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CubicClient, downloadPath, uploadPath } from "../dist/index.js";

const host = process.env.CUBIC_E2E_HOST;
if (!host) {
  throw new Error("Set CUBIC_E2E_HOST to the HoloCubic host or DevTools URL.");
}

const id = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const remoteRoot = `/sd/cubic-cli-e2e-${id}`;
const localRoot = await mkdtemp(path.join(os.tmpdir(), "cubic-e2e-"));
const source = path.join(localRoot, "source");
const downloaded = path.join(localRoot, "downloaded");
const client = new CubicClient(host, 120_000);
let originalDevRun = null;

async function manifest(root) {
  const result = [];
  async function visit(current, relative) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        result.push({ path: `${entryRelative}/`, type: "directory" });
        await visit(absolute, entryRelative);
      } else {
        const bytes = await readFile(absolute);
        result.push({
          path: entryRelative,
          type: "file",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await visit(root, "");
  return result;
}

try {
  const cliProbe = spawnSync(
    process.execPath,
    [path.resolve(import.meta.dirname, "..", "dist", "cli.js"), "--host", host, "--json", "info"],
    { encoding: "utf8" },
  );
  assert.equal(cliProbe.status, 0, cliProbe.stderr);
  assert.equal(JSON.parse(cliProbe.stdout).api_version, 1);
  console.log("Built CLI handshake: OK");

  const info = await client.info(true);
  console.log(`Connected: ${info.version ?? "unknown"}, chunk=${info.chunkSize}, max=${info.maxFileSize}`);

  await mkdir(path.join(source, "empty"), { recursive: true });
  await mkdir(path.join(source, "nested", "深"), { recursive: true });
  await writeFile(path.join(source, "hello 空格.txt"), "HoloCubic CLI E2E\n", "utf8");
  await writeFile(path.join(source, "nested", "深", "data.bin"), randomBytes(1024 * 1024 + 17));

  const uploaded = await uploadPath(client, source, remoteRoot);
  assert.equal(uploaded.files, 2);
  assert.equal((await client.stat(`${remoteRoot}/nested/深/data.bin`)).size, 1024 * 1024 + 17);

  await downloadPath(client, remoteRoot, downloaded);
  assert.deepEqual(await manifest(downloaded), await manifest(source));
  console.log("Recursive upload/download manifest: OK");

  await client.rename(`${remoteRoot}/nested/深/data.bin`, `${remoteRoot}/nested/深/moved.bin`);
  assert.equal((await client.stat(`${remoteRoot}/nested/深/moved.bin`)).size, 1024 * 1024 + 17);
  await client.remove(`${remoteRoot}/nested/深/moved.bin`);
  assert.equal(await client.statOrNull(`${remoteRoot}/nested/深/moved.bin`), null);
  console.log("Rename/remove: OK");

  originalDevRun = await client.readDevRun();
  const probe = `print("cubic-cli-e2e-${id}")\n`;
  await client.saveDevRun(probe, false);
  assert.equal(await client.readDevRun(), probe);
  await client.saveDevRun(originalDevRun, false);
  assert.equal(await client.readDevRun(), originalDevRun);
  originalDevRun = null;
  console.log("DevRun save/restore: OK");
} finally {
  if (originalDevRun !== null) {
    await client.saveDevRun(originalDevRun, false).catch((error) => console.error("DevRun restore failed:", error));
  }
  const remote = await client.statOrNull(remoteRoot).catch(() => null);
  if (remote) await client.rmdir(remoteRoot, true);
  await rm(localRoot, { recursive: true, force: true });
}

assert.equal(await client.statOrNull(remoteRoot), null);
console.log(`Cleanup: OK (${remoteRoot})`);
