import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CubicClient } from "../src/client.js";
import { CubicError, HttpError } from "../src/errors.js";
import { LEGACY_V1_CAPABILITIES } from "../src/types.js";
import { MockDevTools } from "./helpers/mock-devtools.js";

test("client handshakes with the deployed legacy API and derives v1 capabilities", async () => {
  const mock = await new MockDevTools().start();
  try {
    const client = new CubicClient(mock.baseUrl);
    const info = await client.info();
    assert.equal(info.apiVersion, 1);
    assert.equal(info.chunkSize, 4);
    assert.deepEqual([...info.capabilities], [...LEGACY_V1_CAPABILITIES]);
  } finally {
    await mock.close();
  }
});

test("client prefers explicit capabilities and blocks unsupported mutation locally", async () => {
  const mock = await new MockDevTools({ explicitCapabilities: ["fs.list"] }).start();
  try {
    const client = new CubicClient(mock.baseUrl);
    assert.deepEqual([...(await client.info()).capabilities], ["fs.list"]);
    await assert.rejects(client.mkdir("/sd/nope"), /does not support capability fs\.mkdir/);
    assert.equal(mock.requests.some((request) => request.path === "mkdir"), false);
  } finally {
    await mock.close();
  }
});

test("client covers list, stat, binary read/upload, rename, remove, and rmdir", async () => {
  const mock = await new MockDevTools({ chunkSize: 3 }).start();
  try {
    await mkdir(path.join(mock.rootDir, "folder"));
    await mkdir(path.join(mock.rootDir, "empty"));
    await writeFile(path.join(mock.rootDir, "folder", "空 格.bin"), Buffer.from([0, 1, 2, 255]));
    const client = new CubicClient(mock.baseUrl);
    assert.deepEqual((await client.list("/sd/empty")).items, []);
    const listed = await client.list("/sd/folder");
    assert.equal(listed.items[0]?.name, "空 格.bin");
    assert.equal((await client.stat("/sd/folder/空 格.bin")).size, 4);
    const first = await client.read("/sd/folder/空 格.bin", 0, 3);
    assert.deepEqual([...first.bytes], [0, 1, 2]);
    assert.equal(first.eof, false);
    const second = await client.read("/sd/folder/空 格.bin", first.nextOffset, 3);
    assert.deepEqual([...second.bytes], [255]);
    assert.equal(second.eof, true);

    await client.mkdir("/sd/new");
    await client.upload("/sd/new/file.bin", Uint8Array.from([9, 8]), 0, 4);
    const upload = await client.upload("/sd/new/file.bin", Uint8Array.from([7, 6]), 2, 4);
    assert.equal(upload.done, true);
    assert.deepEqual([...await readFile(path.join(mock.rootDir, "new", "file.bin"))], [9, 8, 7, 6]);
    await client.rename("/sd/new/file.bin", "/sd/new/moved.bin");
    await client.remove("/sd/new/moved.bin");
    await client.rmdir("/sd/new");
    assert.equal(await client.statOrNull("/sd/new"), null);
  } finally {
    await mock.close();
  }
});

test("client surfaces device JSON errors with status and validates malformed info", async () => {
  const mock = await new MockDevTools({ malformedInfo: true }).start();
  try {
    const client = new CubicClient(mock.baseUrl);
    await assert.rejects(client.info(), CubicError);
  } finally {
    await mock.close();
  }

  const malformedJson = await new MockDevTools({ malformedJsonInfo: true }).start();
  try {
    await assert.rejects(new CubicClient(malformedJson.baseUrl).info(), /malformed JSON/);
  } finally {
    await malformedJson.close();
  }

  const good = await new MockDevTools().start();
  try {
    const client = new CubicClient(good.baseUrl);
    await assert.rejects(
      client.stat("/sd/missing"),
      (error: unknown) => error instanceof HttpError && error.status === 404 && /path not found/.test(error.message),
    );
  } finally {
    await good.close();
  }
});

test("client covers app listing and DevRun read/save/run", async () => {
  const mock = await new MockDevTools().start();
  try {
    const client = new CubicClient(mock.baseUrl);
    assert.equal((await client.apps()).apps[0]?.id, "devrun");
    assert.match(await client.readDevRun(), /ready/);
    assert.equal((await client.saveDevRun("print('saved')\n")).launched, false);
    assert.match(await client.readDevRun(), /saved/);
    assert.equal((await client.saveDevRun("print('run')\n", true)).launched, true);
  } finally {
    await mock.close();
  }
});

test("client reports connection failures and request timeouts as stable Cubic errors", async () => {
  await assert.rejects(
    new CubicClient("http://127.0.0.1:1/devtools", 100).info(),
    (error: unknown) => error instanceof CubicError && error.code === "CONNECTION_ERROR",
  );

  const slow = await new MockDevTools({ infoDelayMs: 100 }).start();
  try {
    await assert.rejects(
      new CubicClient(slow.baseUrl, 20).info(),
      (error: unknown) => error instanceof CubicError && error.code === "TIMEOUT",
    );
  } finally {
    await slow.close();
  }
});
