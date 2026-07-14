import assert from "node:assert/strict";
import test from "node:test";
import { UsageError } from "../src/errors.js";
import { apiUrl, normalizeDeviceUrl } from "../src/url.js";

test("normalizeDeviceUrl accepts bare hosts and canonical DevTools URLs", () => {
  assert.equal(normalizeDeviceUrl("192.0.2.42"), "http://192.0.2.42/devtools");
  assert.equal(normalizeDeviceUrl("holo.local:8080/"), "http://holo.local:8080/devtools");
  assert.equal(normalizeDeviceUrl("https://holo.local/devtools/api/"), "https://holo.local/devtools");
});
test("normalizeDeviceUrl rejects unsafe or unsupported URL forms", () => {
  for (const value of ["", "ftp://host", "http://user:pass@host", "http://host/devtools?q=1", "http://host/other"]) {
    assert.throws(() => normalizeDeviceUrl(value), UsageError);
  }
});

test("apiUrl encodes remote paths and Unicode query values", () => {
  const url = apiUrl("http://host/devtools", "list", { path: "/sd/空 格/#x%" });
  assert.equal(url.pathname, "/devtools/api/list");
  assert.equal(url.searchParams.get("path"), "/sd/空 格/#x%");
});
