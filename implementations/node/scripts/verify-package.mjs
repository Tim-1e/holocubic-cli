import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this check through npm run verify:package");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

function runNpm(args, options = {}) {
  return run(process.execPath, [npmCli, ...args], options);
}

const packed = runNpm(["pack", "--json", "--ignore-scripts"]);
assert.match(await readFile(path.join(root, "dist", "cli.js"), "utf8"), /^#!\/usr\/bin\/env node\r?\n/);
const records = JSON.parse(packed.stdout);
assert.equal(records.length, 1);
const record = records[0];
const tarball = path.join(root, record.filename);
const paths = record.files.map((file) => file.path);
assert.ok(paths.includes("dist/cli.js"), "dist/cli.js is missing from package");
assert.ok(paths.includes("README.md"), "README.md is missing from package");
assert.ok(paths.includes("LICENSE"), "LICENSE is missing from package");
assert.ok(paths.includes("package.json"), "package.json is missing from package");
for (const item of paths) {
  assert.ok(
    item.startsWith("dist/") || ["README.md", "LICENSE", "package.json"].includes(item),
    `unexpected package file: ${item}`,
  );
  assert.doesNotMatch(item, /auth|config\.json|\.env/i);
}

const temp = await mkdtemp(path.join(os.tmpdir(), "cubic-pack-"));
try {
  runNpm(["install", "--prefix", temp, "--ignore-scripts", tarball], { cwd: temp });
  const bin = path.join(temp, "node_modules", ".bin", process.platform === "win32" ? "cubic.cmd" : "cubic");
  await access(bin);
  const packedCommand = (args) => runNpm(["exec", "--prefix", temp, "--", "cubic", ...args], { cwd: temp });
  const version = packedCommand(["--version"]);
  assert.equal(version.stdout.trim(), "0.1.0-beta.1");
  const help = packedCommand(["--help"]);
  assert.match(help.stdout, /Manage HoloCubic DevTools/);
  console.log(`Package verified: ${record.filename} (${record.size} bytes, ${paths.length} files)`);
} finally {
  await rm(temp, { recursive: true, force: true });
  await rm(tarball, { force: true });
}
