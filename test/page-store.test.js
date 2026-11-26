import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { pageAppLimits } from "../src/page-apps.js";
import { createPageStore, pageDataFile } from "../src/page-store.js";

const KEY = "0123456789abcdef";
const FILE = "/tmp/page.html";

async function withStore(run, limits = pageAppLimits()) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-page-store-"));
  try {
    await run(createPageStore(dir, { limits }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a page's values round-trip and survive a new store on the same folder", async () => {
  await withStore(async (store, dir) => {
    assert.deepEqual(await store.get(KEY, "notes"), { found: false });
    await store.set(KEY, FILE, "notes", { items: ["a", "é"], done: false });
    await store.set(KEY, FILE, "count", 3);
    assert.deepEqual(await store.get(KEY, "notes"), { found: true, value: { items: ["a", "é"], done: false } });

    const reopened = createPageStore(dir);
    assert.deepEqual(await reopened.get(KEY, "count"), { found: true, value: 3 });
    const all = await reopened.read(KEY);
    assert.equal(all.file, FILE);
    assert.equal(all.keys, 2);
    assert.deepEqual(Object.keys(all.entries), ["count", "notes"]);
    assert.ok(all.updated_at);
  });
});

test("null is a stored value, distinct from a missing key", async () => {
  await withStore(async (store) => {
    await store.set(KEY, FILE, "empty", null);
    assert.deepEqual(await store.get(KEY, "empty"), { found: true, value: null });
  });
});

test("keys like __proto__ are plain keys", async () => {
  await withStore(async (store, dir) => {
    await store.set(KEY, FILE, "__proto__", { polluted: true });
    await store.set(KEY, FILE, "constructor", 1);
    assert.deepEqual(await store.get(KEY, "__proto__"), { found: true, value: { polluted: true } });
    assert.deepEqual((await createPageStore(dir).list(KEY)).keys, ["__proto__", "constructor"]);
    assert.equal(/** @type {any} */ ({}).polluted, undefined);
  });
});

test("delete and list by prefix", async () => {
  await withStore(async (store) => {
    await store.set(KEY, FILE, "todo:2", "b");
    await store.set(KEY, FILE, "todo:1", "a");
    await store.set(KEY, FILE, "theme", "dark");
    assert.deepEqual((await store.list(KEY, "todo:")).keys, ["todo:1", "todo:2"]);
    assert.deepEqual((await store.list(KEY)).keys, ["theme", "todo:1", "todo:2"]);
    assert.deepEqual(await store.delete(KEY, FILE, "todo:1"), { deleted: true });
    assert.deepEqual(await store.delete(KEY, FILE, "todo:1"), { deleted: false });
    assert.deepEqual((await store.list(KEY, "todo:")).keys, ["todo:2"]);
  });
});

test("deleting the last key removes the page's file", async () => {
  await withStore(async (store, dir) => {
    await store.set(KEY, FILE, "only", 1);
    await store.delete(KEY, FILE, "only");
    await assert.rejects(stat(pageDataFile(dir, KEY)), { code: "ENOENT" });
  });
});

test("limits: value size, page total and key count refuse with a code", async () => {
  const limits = pageAppLimits({ storeValueMaxBytes: 20, storePageMaxBytes: 30, storeMaxKeys: 2 });
  await withStore(async (store) => {
    await assert.rejects(store.set(KEY, FILE, "big", "x".repeat(30)), { code: "VALUE_TOO_LARGE", statusCode: 413 });
    await store.set(KEY, FILE, "a", "x".repeat(10));
    await store.set(KEY, FILE, "b", "y".repeat(10));
    await assert.rejects(store.set(KEY, FILE, "c", 1), { code: "STORE_FULL", statusCode: 507 });
    // Replacing a key counts its old size out first.
    await store.set(KEY, FILE, "a", "z".repeat(12));
    await assert.rejects(store.set(KEY, FILE, "a", "z".repeat(18)), { code: "STORE_FULL" });
    assert.deepEqual(await store.get(KEY, "a"), { found: true, value: "z".repeat(12) });
  }, limits);
});

test("a bad key or page key is refused before any file is touched", async () => {
  await withStore(async (store, dir) => {
    await assert.rejects(store.set(KEY, FILE, "", 1), { code: "KEY_INVALID" });
    await assert.rejects(store.get("../etc", "k"), { code: "SESSION_INVALID" });
    await assert.rejects(store.read("../../x"), { code: "SESSION_INVALID" });
    await assert.rejects(readdir(path.join(dir, "page-data")), { code: "ENOENT" });
  });
});

test("clear deletes everything and reports what went", async () => {
  await withStore(async (store) => {
    await store.set(KEY, FILE, "a", 1);
    await store.set(KEY, FILE, "b", [1, 2]);
    const cleared = await store.clear(KEY);
    assert.equal(cleared.keys, 2);
    assert.ok(cleared.bytes > 0);
    assert.equal((await store.read(KEY)).keys, 0);
  });
});

test("files and folder are owner-only", { skip: process.platform === "win32" }, async () => {
  await withStore(async (store, dir) => {
    await store.set(KEY, FILE, "secret", "value");
    assert.equal((await stat(pageDataFile(dir, KEY))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(dir, "page-data"))).mode & 0o777, 0o700);
  });
});

test("an unreadable file is set aside and the page starts over", async () => {
  await withStore(async (store, dir) => {
    await mkdir(path.join(dir, "page-data"), { recursive: true });
    await writeFile(pageDataFile(dir, KEY), "{not json");
    assert.deepEqual(await store.get(KEY, "a"), { found: false });
    assert.equal(await readFile(`${pageDataFile(dir, KEY)}.corrupt`, "utf8"), "{not json");
    await store.set(KEY, FILE, "a", 1);
    assert.deepEqual(await store.get(KEY, "a"), { found: true, value: 1 });
  });
});

test("concurrent writes from one page all land", async () => {
  await withStore(async (store) => {
    await Promise.all(Array.from({ length: 25 }, (_, index) => store.set(KEY, FILE, `k${index}`, index)));
    assert.equal((await store.read(KEY)).keys, 25);
  });
});
