import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CubicClient } from "../src/client.js";
import { CubicError } from "../src/errors.js";
import { downloadPath, uploadFile, uploadPath } from "../src/transfer.js";
import { MockDevTools } from "./helpers/mock-devtools.js";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("uploadFile chunks, retries, verifies, commits, and replaces only with force", async () => {
  const mock = await new MockDevTools({ chunkSize: 3, uploadFailures: 1 }).start();
  const localDir = await mkdtemp(path.join(os.tmpdir(), "cubic-upload-"));
  try {
    const local = path.join(localDir, "数据.bin");
    await writeFile(local, Buffer.from([0, 1, 2, 3, 4, 5, 255]));
    await mkdir(path.join(mock.rootDir, "target"));
    const client = new CubicClient(mock.baseUrl);
    const progress: number[] = [];
    const result = await uploadFile(client, local, "/sd/target/数据.bin", {
      onProgress: (event) => progress.push(event.transferredBytes),
    });
    assert.equal(result.bytes, 7);
    assert.deepEqual([...await readFile(path.join(mock.rootDir, "target", "数据.bin"))], [0, 1, 2, 3, 4, 5, 255]);
    assert.ok(progress.includes(7));
    assert.ok(mock.requests.filter((request) => request.path === "upload").length >= 4);

    await assert.rejects(uploadFile(client, local, "/sd/target/数据.bin"), /Use --force/);
    await writeFile(local, Buffer.from([9, 8]));
    await uploadFile(client, local, "/sd/target/数据.bin", { force: true });
    assert.deepEqual([...await readFile(path.join(mock.rootDir, "target", "数据.bin"))], [9, 8]);
    assert.deepEqual(
      (await readdir(path.join(mock.rootDir, "target"))).filter((name) => name.includes(".cubic-")),
      [],
    );
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await mock.close();
  }
});

test("uploadFile supports empty files and rejects the device file-size limit before writing", async () => {
  const mock = await new MockDevTools({ maxFileSize: 3 }).start();
  const localDir = await mkdtemp(path.join(os.tmpdir(), "cubic-upload-"));
  try {
    const client = new CubicClient(mock.baseUrl);
    const empty = path.join(localDir, "empty.txt");
    await writeFile(empty, "");
    await uploadFile(client, empty, "/sd/empty.txt");
    assert.equal((await readFile(path.join(mock.rootDir, "empty.txt"))).length, 0);

    const large = path.join(localDir, "large.bin");
    await writeFile(large, Buffer.alloc(4));
    const before = mock.requests.length;
    await assert.rejects(uploadFile(client, large, "/sd/large.bin"), /device limit is 3/);
    assert.equal(mock.requests.slice(before).some((request) => request.path === "upload"), false);
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await mock.close();
  }
});

test("uploadPath transfers a nested tree including empty directories as one committed target", async () => {
  const mock = await new MockDevTools({ chunkSize: 5 }).start();
  const localDir = await mkdtemp(path.join(os.tmpdir(), "cubic-tree-"));
  try {
    await mkdir(path.join(localDir, "empty"));
    await mkdir(path.join(localDir, "nested", "深"), { recursive: true });
    await writeFile(path.join(localDir, "hello.txt"), "hello\n");
    await writeFile(path.join(localDir, "nested", "深", "data.bin"), Buffer.from([0, 255, 1, 2]));
    const client = new CubicClient(mock.baseUrl);
    const result = await uploadPath(client, localDir, "/sd/uploaded");
    assert.equal(result.files, 2);
    assert.equal(result.directories, 4);
    assert.equal(await readFile(path.join(mock.rootDir, "uploaded", "hello.txt"), "utf8"), "hello\n");
    assert.deepEqual([...await readFile(path.join(mock.rootDir, "uploaded", "nested", "深", "data.bin"))], [0, 255, 1, 2]);
    assert.deepEqual(await readdir(path.join(mock.rootDir, "uploaded", "empty")), []);
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await mock.close();
  }
});

test("uploadPath scans limits before remote writes and rejects symbolic links when supported", async (context) => {
  const mock = await new MockDevTools().start();
  const localDir = await mkdtemp(path.join(os.tmpdir(), "cubic-tree-"));
  try {
    await mkdir(path.join(localDir, "a", "b"), { recursive: true });
    await writeFile(path.join(localDir, "a", "b", "x"), "x");
    const client = new CubicClient(mock.baseUrl);
    const before = mock.requests.length;
    await assert.rejects(uploadPath(client, localDir, "/sd/too-deep", { limits: { maxDepth: 1 } }), /maximum depth 1/);
    assert.equal(mock.requests.slice(before).some((request) => ["mkdir", "upload"].includes(request.path)), false);

    const beforeEntries = mock.requests.length;
    await assert.rejects(uploadPath(client, localDir, "/sd/too-many", { limits: { maxEntries: 1 } }), /maximum entries 1/);
    assert.equal(mock.requests.slice(beforeEntries).some((request) => ["mkdir", "upload"].includes(request.path)), false);

    const link = path.join(localDir, "link");
    try {
      await symlink(path.join(localDir, "a"), link, "junction");
      await assert.rejects(uploadPath(client, localDir, "/sd/with-link"), /Symbolic links are not followed/);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip("symbolic-link creation is not permitted on this Windows host");
      else throw error;
    }
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await mock.close();
  }
});

test("downloadPath downloads a nested tree byte-for-byte and preserves empty directories", async () => {
  const mock = await new MockDevTools({ chunkSize: 3 }).start();
  const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "cubic-download-"));
  try {
    await mkdir(path.join(mock.rootDir, "source", "empty"), { recursive: true });
    await mkdir(path.join(mock.rootDir, "source", "nested"), { recursive: true });
    const binary = Buffer.from([0, 1, 2, 3, 254, 255]);
    await writeFile(path.join(mock.rootDir, "source", "空 格.bin"), binary);
    await writeFile(path.join(mock.rootDir, "source", "nested", "hello.txt"), "hello\n");
    const client = new CubicClient(mock.baseUrl);
    const target = path.join(destinationRoot, "copy");
    const result = await downloadPath(client, "/sd/source", target);
    assert.equal(result.files, 2);
    assert.equal(hash(await readFile(path.join(target, "空 格.bin"))), hash(binary));
    assert.equal(await readFile(path.join(target, "nested", "hello.txt"), "utf8"), "hello\n");
    assert.deepEqual(await readdir(path.join(target, "empty")), []);
    assert.deepEqual((await readdir(destinationRoot)).filter((name) => name.includes(".cubic-")), []);
  } finally {
    await rm(destinationRoot, { recursive: true, force: true });
    await mock.close();
  }
});

test("downloadPath refuses overwrite, supports force, and enforces aggregate limit before local writes", async () => {
  const mock = await new MockDevTools({ chunkSize: 4 }).start();
  const destinationRoot = await mkdtemp(path.join(os.tmpdir(), "cubic-download-"));
  try {
    await mkdir(path.join(mock.rootDir, "source"));
    await writeFile(path.join(mock.rootDir, "source", "data.bin"), Buffer.from([1, 2, 3, 4]));
    const target = path.join(destinationRoot, "copy");
    await mkdir(target);
    await writeFile(path.join(target, "old.txt"), "old");
    const client = new CubicClient(mock.baseUrl);
    await assert.rejects(downloadPath(client, "/sd/source", target), /Use --force/);
    await downloadPath(client, "/sd/source", target, { force: true });
    assert.deepEqual([...await readFile(path.join(target, "data.bin"))], [1, 2, 3, 4]);
    await assert.rejects(
      downloadPath(client, "/sd/source", path.join(destinationRoot, "limited"), { limits: { maxDownloadBytes: 3 } }),
      /download limit 3/,
    );
    await assert.rejects(readFile(path.join(destinationRoot, "limited")), { code: "ENOENT" });
  } finally {
    await rm(destinationRoot, { recursive: true, force: true });
    await mock.close();
  }
});

test("terminal upload failure cleans remote temporary files", async () => {
  const mock = await new MockDevTools({ uploadFailures: 5 }).start();
  const localDir = await mkdtemp(path.join(os.tmpdir(), "cubic-upload-"));
  try {
    const local = path.join(localDir, "data.bin");
    await writeFile(local, Buffer.from([1, 2, 3]));
    const client = new CubicClient(mock.baseUrl);
    await assert.rejects(uploadFile(client, local, "/sd/data.bin", { retries: 1 }), CubicError);
    assert.deepEqual((await readdir(mock.rootDir)).filter((name) => name.includes(".cubic-upload-")), []);
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await mock.close();
  }
});

test("terminal download failure removes local temporary files", async () => {
  const mock = await new MockDevTools({ readFailures: 5 }).start();
  const localDir = await mkdtemp(path.join(os.tmpdir(), "cubic-download-"));
  try {
    await writeFile(path.join(mock.rootDir, "data.bin"), Buffer.from([1, 2, 3]));
    const client = new CubicClient(mock.baseUrl);
    const target = path.join(localDir, "data.bin");
    await assert.rejects(downloadPath(client, "/sd/data.bin", target, { retries: 1 }), CubicError);
    assert.deepEqual((await readdir(localDir)).filter((name) => name.includes(".cubic-download-")), []);
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await mock.close();
  }
});

test("recursive download rejects device entries that do not match their listed directory", async () => {
  const mock = await new MockDevTools({ maliciousListEntry: true }).start();
  const localDir = await mkdtemp(path.join(os.tmpdir(), "cubic-download-"));
  try {
    await mkdir(path.join(mock.rootDir, "source"));
    await writeFile(path.join(mock.rootDir, "source", "safe.txt"), "safe");
    const target = path.join(localDir, "copy");
    await assert.rejects(downloadPath(new CubicClient(mock.baseUrl), "/sd/source", target), /Unsafe directory entry path/);
    await assert.rejects(readFile(target), { code: "ENOENT" });
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await mock.close();
  }
});
