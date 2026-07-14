import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { UsageError } from "../src/errors.js";
import {
  assertCanDeleteRemote,
  normalizeRemotePath,
  remoteJoin,
  safeLocalDestination,
} from "../src/remote-path.js";

test("normalizeRemotePath resolves safe relative and Windows-style paths", () => {
  assert.equal(normalizeRemotePath(undefined), "/sd");
  assert.equal(normalizeRemotePath("apps/demo"), "/sd/apps/demo");
  assert.equal(normalizeRemotePath("/sd//apps/./demo"), "/sd/apps/demo");
  assert.equal(normalizeRemotePath("apps\\demo"), "/sd/apps/demo");
});
test("normalizeRemotePath rejects traversal and NUL", () => {
  assert.throws(() => normalizeRemotePath("../etc"), UsageError);
  assert.throws(() => normalizeRemotePath("/flash/file"), UsageError);
  assert.throws(() => normalizeRemotePath("/sd/a\0b"), UsageError);
});

test("remoteJoin accepts names only and deletion guard protects root", () => {
  assert.equal(remoteJoin("/sd/apps", "天气 app"), "/sd/apps/天气 app");
  assert.throws(() => remoteJoin("/sd", "../x"), UsageError);
  assert.throws(() => assertCanDeleteRemote("/sd/./"), UsageError);
  assert.doesNotThrow(() => assertCanDeleteRemote("/sd/test"));
});

test("safeLocalDestination confines remote entries to the destination", () => {
  const root = path.resolve("tmp", "download");
  assert.equal(safeLocalDestination(root, "nested/file.txt"), path.join(root, "nested", "file.txt"));
  assert.throws(() => safeLocalDestination(root, "../escape.txt"), UsageError);
  assert.throws(() => safeLocalDestination(root, "/absolute.txt"), UsageError);
});
