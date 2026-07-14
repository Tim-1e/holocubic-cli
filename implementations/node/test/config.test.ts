import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore, defaultConfigPath, resolveDevice, validateDeviceName } from "../src/config.js";

test("defaultConfigPath honors CUBIC_CONFIG and platform conventions", () => {
  assert.equal(defaultConfigPath({ CUBIC_CONFIG: "./custom.json" } as NodeJS.ProcessEnv), path.resolve("custom.json"));
  assert.equal(defaultConfigPath({ APPDATA: "C:\\Users\\A\\AppData\\Roaming" } as NodeJS.ProcessEnv, "win32"), "C:\\Users\\A\\AppData\\Roaming\\cubic\\config.json");
  assert.equal(defaultConfigPath({ XDG_CONFIG_HOME: "/tmp/config" } as NodeJS.ProcessEnv, "linux"), "/tmp/config/cubic/config.json");
});

test("ConfigStore writes and reads Unicode devices atomically", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cubic-config-"));
  try {
    const file = path.join(dir, "nested", "config.json");
    const store = new ConfigStore(file);
    await store.write({ version: 1, current: "桌面", devices: { 桌面: { url: "192.0.2.42" } } });
    assert.deepEqual(await store.read(), {
      version: 1,
      current: "桌面",
      devices: { 桌面: { url: "http://192.0.2.42/devtools" } },
    });
    assert.match(await readFile(file, "utf8"), /"桌面"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveDevice follows option, environment, then selected config precedence", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cubic-config-"));
  try {
    const store = new ConfigStore(path.join(dir, "config.json"));
    await store.write({ version: 1, current: "desk", devices: { desk: { url: "http://stored/devtools" } } });
    assert.equal((await resolveDevice(store, "option-host", { CUBIC_HOST: "env-host" })).source, "option");
    assert.equal((await resolveDevice(store, undefined, { CUBIC_HOST: "env-host" })).source, "environment");
    assert.deepEqual(await resolveDevice(store, undefined, {}), {
      url: "http://stored/devtools",
      name: "desk",
      source: "config",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateDeviceName preserves Unicode and rejects reserved separators", () => {
  assert.equal(validateDeviceName(" 桌面 "), "桌面");
  for (const value of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
    assert.throws(() => validateDeviceName(value));
  }
});
