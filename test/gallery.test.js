// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGalleryEntries,
  createGalleryHtml,
  createPageHeadReader,
  GalleryPins,
  galleryStatus,
  isValidGalleryKey,
  projectLabel,
  shortPath,
  sortGalleryEntries,
} from "../src/gallery.js";
import { extractArtifactHead } from "../src/server.js";

test("shortPath writes the home folder as ~ and leaves other paths alone", () => {
  assert.equal(shortPath("/Users/sam/dev/app/.lavish/plan.html", "/Users/sam"), "~/dev/app/.lavish/plan.html");
  assert.equal(shortPath("/Users/sam", "/Users/sam"), "~");
  assert.equal(shortPath("/Users/samuel/plan.html", "/Users/sam"), "/Users/samuel/plan.html");
  assert.equal(shortPath("C:\\Users\\sam\\plan.html", "C:\\Users\\sam"), "~/plan.html");
});

test("projectLabel names the folder, skipping a hidden working folder", () => {
  assert.equal(projectLabel("/Users/sam/dev/app/.lavish/plan.html"), "app");
  assert.equal(projectLabel("/Users/sam/dev/app/docs/plan.html"), "docs");
  assert.equal(projectLabel("/plan.html"), "");
});

test("galleryStatus says whose turn it is", () => {
  assert.equal(galleryStatus({ status: "ended", chat: [{ role: "user" }] }), "ended");
  assert.equal(galleryStatus({ status: "feedback", prompts: [{}] }), "answered");
  assert.equal(galleryStatus({ status: "open", prompts: [{ prompt: "x" }] }), "answered");
  assert.equal(galleryStatus({ status: "open", chat: [{ role: "agent" }, { role: "user" }] }), "answered");
  assert.equal(galleryStatus({ status: "open", chat: [{ role: "user" }, { role: "agent" }] }), "waiting");
  assert.equal(galleryStatus({ status: "open" }), "waiting");
});

test("sortGalleryEntries puts pins first in pin order, then the newest change", () => {
  const entries = [
    { key: "a", changed_at: "2026-11-01T00:00:00.000Z", path: "a" },
    { key: "b", changed_at: "2026-11-03T00:00:00.000Z", path: "b" },
    { key: "c", changed_at: "2026-11-02T00:00:00.000Z", path: "c" },
    { key: "d", changed_at: "2026-10-01T00:00:00.000Z", path: "d" },
  ];
  assert.deepEqual(
    sortGalleryEntries(entries, ["d", "a"]).map((entry) => entry.key),
    ["d", "a", "b", "c"],
  );
});

test("buildGalleryEntries carries titles, status and short paths, never the full home path", async () => {
  const sessions = [
    {
      key: "1111111111111111",
      file: "/Users/sam/dev/app/.lavish/plan.html",
      status: "open",
      chat: [{ role: "agent" }],
      updated_at: "2026-11-01T00:00:00.000Z",
    },
    {
      key: "2222222222222222",
      file: "/Users/sam/gone.html",
      status: "ended",
      ended_by: "user",
      updated_at: "2026-11-02T00:00:00.000Z",
    },
    { key: "not-a-key", file: "/x.html" },
  ];
  const heads = {
    "/Users/sam/dev/app/.lavish/plan.html": { missing: false, title: "Launch plan", mtimeMs: Date.UTC(2026, 10, 5) },
    "/Users/sam/gone.html": { missing: true, title: "", mtimeMs: 0 },
  };
  const entries = await buildGalleryEntries(sessions, {
    pins: ["2222222222222222"],
    listening: new Set(["1111111111111111"]),
    readHead: async (file) => heads[file],
    home: "/Users/sam",
  });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    key: "2222222222222222",
    title: "gone.html",
    file_name: "gone.html",
    folder: "sam",
    path: "~/gone.html",
    changed_at: "2026-11-02T00:00:00.000Z",
    status: "ended",
    ended_by: "user",
    listening: false,
    pinned: true,
    missing: true,
  });
  assert.equal(entries[1].title, "Launch plan");
  assert.equal(entries[1].folder, "app");
  assert.equal(entries[1].path, "~/dev/app/.lavish/plan.html");
  assert.equal(entries[1].status, "waiting");
  assert.equal(entries[1].listening, true);
  assert.equal(entries[1].changed_at, "2026-11-05T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(entries), /\/Users\/sam/);
});

test("createPageHeadReader reads the title once per change and reports a missing file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-gallery-"));
  try {
    const file = path.join(dir, "page.html");
    await writeFile(file, "<!doctype html><title>First</title><p>x</p>");
    let parses = 0;
    const read = createPageHeadReader((html) => {
      parses += 1;
      return extractArtifactHead(html);
    });
    assert.equal((await read(file)).title, "First");
    assert.equal((await read(file)).title, "First");
    assert.equal(parses, 1, "an unchanged file is not read again");
    await writeFile(file, "<!doctype html><title>Second title</title>");
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    assert.equal((await read(file)).title, "Second title");
    assert.equal(parses, 2);
    assert.deepEqual(await read(path.join(dir, "missing.html")), { missing: true, title: "", mtimeMs: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GalleryPins keeps valid keys, newest pin first, in the state directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-pins-"));
  try {
    const pins = new GalleryPins(dir);
    assert.deepEqual(await pins.read(), []);
    await pins.set("1111111111111111", true);
    await pins.set("2222222222222222", true);
    assert.deepEqual(await pins.read(), ["2222222222222222", "1111111111111111"]);
    await pins.set("2222222222222222", false);
    assert.deepEqual(await pins.read(), ["1111111111111111"]);
    await assert.rejects(() => pins.set("../etc", true), /invalid page key/);
    const stored = JSON.parse(await readFile(path.join(dir, "gallery-pins.json"), "utf8"));
    assert.deepEqual(stored, { format: 1, pins: ["1111111111111111"] });
    await writeFile(path.join(dir, "gallery-pins.json"), '{"pins":["bad","3333333333333333",3]}');
    assert.deepEqual(await pins.read(), ["3333333333333333"]);
    assert.equal(isValidGalleryKey("3333333333333333"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createGalleryHtml embeds the rows as inert JSON", () => {
  const html = createGalleryHtml({
    entries: [{ key: "1111111111111111", title: "</script><script>alert(1)</script>", path: "~/a.html" }],
    themeBootstrapJs: "",
    faviconTag: "",
    logoSvg: "",
  });
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /\\u003c\/script\\u003e/);
  assert.match(html, /<script src="\/lavish-assets\/gallery-client\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/lavish-assets\/gallery\.css">/);
});
