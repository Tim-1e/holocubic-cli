import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateAppDirectory, validateAppId } from "../src/app.js";

test("validateAppDirectory accepts a standard app and derives its id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cubic-app-"));
  const app = path.join(root, "sample-app");
  try {
    await mkdir(app);
    await writeFile(path.join(app, "app.info"), "name = Sample\nentry = main.lua\n");
    await writeFile(path.join(app, "main.lua"), "print('ok')\n");
    assert.deepEqual(await validateAppDirectory(app), {
      source: app,
      id: "sample-app",
      destination: "/sd/apps/sample-app",
      entry: "main.lua",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateAppDirectory rejects missing metadata, missing entry, and unsafe ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cubic-app-"));
  try {
    await writeFile(path.join(root, "main.lua"), "print('ok')\n");
    await assert.rejects(validateAppDirectory(root), /metadata is missing/);
    await writeFile(path.join(root, "app.info"), "entry = nested.lua\n");
    await assert.rejects(validateAppDirectory(root), /entry is missing/);
    assert.throws(() => validateAppId("../bad"));
    assert.throws(() => validateAppId(".cubic-upload-x"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
