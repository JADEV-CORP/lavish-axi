// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  contentHash,
  DEFAULT_VERSION_LIMITS,
  isValidVersionKey,
  parseVersionId,
  planVersionPrune,
  resolveVersionLimits,
  VersionStore,
  versionsRoot,
} from "../src/version-store.js";

const KEY = "0123456789abcdef";
const OTHER = "fedcba9876543210";

async function withStore(limits, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-versions-"));
  try {
    await run(new VersionStore(versionsRoot(dir), limits), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const page = (text) => Buffer.from(`<!doctype html><html><body><p>${text}</p></body></html>\n`);

test("record keeps each distinct save once and numbers versions upward", async () => {
  await withStore({}, async (store) => {
    const first = await store.record(KEY, page("one"), { source: "open" });
    assert.equal(first.recorded, true);
    assert.equal(first.version.id, 1);
    assert.equal(first.version.summary.kind, "first");

    const same = await store.record(KEY, page("one"));
    assert.equal(same.recorded, false);
    assert.equal(same.reason, "unchanged");

    const second = await store.record(KEY, page("two"));
    assert.equal(second.version.id, 2);
    assert.equal(second.version.summary.kind, "text");
    assert.equal(second.version.summary.excerpt, "two");

    const list = await store.list(KEY);
    assert.deepEqual(
      list.map((version) => [version.id, version.source]),
      [
        [1, "open"],
        [2, "save"],
      ],
    );
    const read = await store.read(KEY, 1);
    assert.equal(read.bytes.toString(), page("one").toString());
    assert.equal(await store.read(KEY, 9), null);
  });
});

test("going back to earlier content adds a version but stores no new object", async () => {
  await withStore({}, async (store) => {
    await store.record(KEY, page("a"));
    await store.record(KEY, page("b"));
    const back = await store.record(KEY, page("a"));
    assert.equal(back.recorded, true);
    assert.equal(back.version.id, 3);
    const objects = (await readdir(store.dirFor(KEY))).filter((name) => name.endsWith(".html.gz"));
    assert.equal(objects.length, 2);
  });
});

test("the version cap drops the oldest entries and their unreferenced objects", async () => {
  await withStore({ maxVersions: 3 }, async (store) => {
    for (const text of ["a", "b", "c", "d", "e"]) await store.record(KEY, page(text));
    const list = await store.list(KEY);
    assert.deepEqual(
      list.map((version) => version.id),
      [3, 4, 5],
    );
    const objects = (await readdir(store.dirFor(KEY))).filter((name) => name.endsWith(".html.gz"));
    assert.deepEqual(objects.sort(), list.map((version) => `${version.hash}.html.gz`).sort());
  });
});

test("the byte cap prunes oldest first and always keeps the newest version", async () => {
  await withStore({ maxPageBytes: 1 }, async (store) => {
    await store.record(KEY, page("a"));
    await store.record(KEY, page("b"));
    const list = await store.list(KEY);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 2);
  });
});

test("planVersionPrune counts shared objects once", () => {
  const versions = [
    { id: 1, hash: "a" },
    { id: 2, hash: "b" },
    { id: 3, hash: "a" },
  ];
  const stored = new Map([
    ["a", 10],
    ["b", 10],
  ]);
  assert.deepEqual(
    planVersionPrune(versions, stored, { maxVersions: 10, maxPageBytes: 20 }).kept.map((v) => v.id),
    [1, 2, 3],
  );
  const tight = planVersionPrune(versions, stored, { maxVersions: 10, maxPageBytes: 10 });
  assert.deepEqual(
    tight.kept.map((v) => v.id),
    [3],
  );
  assert.deepEqual(tight.dropHashes, ["b"]);
});

test("a page over the size cap is not versioned", async () => {
  await withStore({ maxVersionBytes: 64 }, async (store) => {
    const result = await store.record(KEY, Buffer.alloc(200, 65));
    assert.equal(result.recorded, false);
    assert.equal(result.reason, "too-large");
    assert.deepEqual(await store.list(KEY), []);
  });
});

test("disabled recording still lists and reads what is stored", async () => {
  await withStore({}, async (store, dir) => {
    await store.record(KEY, page("kept"));
    const off = new VersionStore(versionsRoot(dir), { enabled: false });
    const result = await off.record(KEY, page("new"));
    assert.equal(result.recorded, false);
    assert.equal(result.reason, "disabled");
    assert.equal((await off.list(KEY)).length, 1);
    assert.equal((await off.read(KEY, 1)).bytes.toString(), page("kept").toString());
  });
});

test("pages never share a version directory", async () => {
  await withStore({}, async (store) => {
    await store.record(KEY, page("mine"));
    assert.deepEqual(await store.list(OTHER), []);
    assert.equal(await store.read(OTHER, 1), null);
    assert.throws(() => store.dirFor("../escape"), /invalid page key/);
  });
});

test("a damaged object is refused rather than restored", async () => {
  await withStore({}, async (store) => {
    const { version } = await store.record(KEY, page("original"));
    await writeFile(path.join(store.dirFor(KEY), `${version.hash}.html.gz`), gzipSync(Buffer.from("tampered")));
    await assert.rejects(() => store.read(KEY, version.id), /damaged/);
  });
});

test("a corrupt index starts a fresh list instead of failing", async () => {
  await withStore({}, async (store) => {
    await store.record(KEY, page("a"));
    await writeFile(path.join(store.dirFor(KEY), "index.json"), "{not json");
    const result = await store.record(KEY, page("b"));
    assert.equal(result.recorded, true);
    assert.equal(result.version.id, 1);
    assert.equal(result.version.summary.kind, "first");
  });
});

test("concurrent records for one page keep every distinct save", async () => {
  await withStore({}, async (store) => {
    await Promise.all(["a", "b", "c", "d"].map((text) => store.record(KEY, page(text))));
    const list = await store.list(KEY);
    assert.deepEqual(
      list.map((version) => version.id),
      [1, 2, 3, 4],
    );
  });
});

test("version files are owner-only", { skip: process.platform === "win32" }, async () => {
  await withStore({}, async (store) => {
    const { version } = await store.record(KEY, page("private"));
    const dirMode = (await stat(store.dirFor(KEY))).mode & 0o777;
    const fileMode = (await stat(path.join(store.dirFor(KEY), `${version.hash}.html.gz`))).mode & 0o777;
    const indexMode = (await stat(path.join(store.dirFor(KEY), "index.json"))).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(fileMode, 0o600);
    assert.equal(indexMode, 0o600);
    const index = JSON.parse(await readFile(path.join(store.dirFor(KEY), "index.json"), "utf8"));
    assert.equal(index.format, 1);
    assert.equal(index.versions[0].hash, contentHash(page("private")));
    assert.equal("file" in index, false, "the index never stores the page path");
  });
});

test("record does not recreate a state directory that is gone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-versions-gone-"));
  await rm(dir, { recursive: true, force: true });
  const store = new VersionStore(versionsRoot(dir));
  await assert.rejects(() => store.record(KEY, page("late")));
  await assert.rejects(() => stat(dir));
});

test("resolveVersionLimits reads the environment and keeps defaults on bad values", () => {
  assert.deepEqual(resolveVersionLimits({}), { enabled: true, ...DEFAULT_VERSION_LIMITS });
  assert.equal(resolveVersionLimits({ LAVISH_AXI_VERSIONS: "off" }).enabled, false);
  assert.equal(resolveVersionLimits({ LAVISH_AXI_VERSIONS: "0" }).enabled, false);
  assert.equal(resolveVersionLimits({ LAVISH_AXI_VERSIONS: "1" }).enabled, true);
  assert.equal(resolveVersionLimits({ LAVISH_AXI_VERSIONS_MAX: "7.9" }).maxVersions, 7);
  assert.equal(resolveVersionLimits({ LAVISH_AXI_VERSIONS_MAX: "0" }).maxVersions, DEFAULT_VERSION_LIMITS.maxVersions);
  assert.equal(resolveVersionLimits({ LAVISH_AXI_VERSIONS_MAX: "x" }).maxVersions, DEFAULT_VERSION_LIMITS.maxVersions);
  assert.equal(resolveVersionLimits({ LAVISH_AXI_VERSIONS_MAX_MB: "2" }).maxPageBytes, 2 * 1024 * 1024);
});

test("parseVersionId and isValidVersionKey accept only plain values", () => {
  assert.equal(parseVersionId("12"), 12);
  assert.equal(parseVersionId(" 3 "), 3);
  for (const bad of ["0", "-1", "1.5", "1e3", "abc", "", "01", "9999999999"]) {
    assert.equal(parseVersionId(bad), null, bad);
  }
  assert.equal(isValidVersionKey(KEY), true);
  assert.equal(isValidVersionKey("../x"), false);
  assert.equal(isValidVersionKey("0123456789ABCDEF"), false);
});
