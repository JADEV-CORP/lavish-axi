import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { createChromeHtml, createSdkJs, serve } from "../src/server.js";

/**
 * A server with one open session. `restart` closes it and serves the same state folder again,
 * the way an upgrade or `lavish stop` would.
 * @param {(ctx: { base: () => string, key: string, artifact: string, dir: string, restart: () => Promise<void> }) => Promise<void>} run
 */
async function withSession(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-page-apps-srv-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const start = () => serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  let server = await start();
  const base = () => `http://127.0.0.1:${server.port}`;
  try {
    const open = await fetch(`${base()}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();
    await run({
      base,
      key,
      artifact,
      dir,
      restart: async () => {
        await server.close();
        server = await start();
      },
    });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function pageStore(base, key, body, { origin = base, raw = false } = {}) {
  return fetch(`${base}/api/${key}/page-store`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: raw ? body : JSON.stringify(body),
  });
}

test("page storage round-trips through the chrome route and survives a server restart", async () => {
  await withSession(async ({ base, key, artifact, restart }) => {
    const set = await pageStore(base(), key, { op: "set", key: "plan", value: { step: 2, notes: ["é"] } });
    assert.equal(set.status, 200);
    assert.equal((await set.json()).keys, 1);

    await restart();
    const got = await pageStore(base(), key, { op: "get", key: "plan" });
    assert.deepEqual(await got.json(), { found: true, value: { step: 2, notes: ["é"] } });

    // The CLI read is header-less and sees the same data, with the page's path.
    const data = await (await fetch(`${base()}/api/${key}/page-data`)).json();
    assert.equal(data.keys, 1);
    assert.equal(path.basename(data.file), path.basename(artifact));
    assert.deepEqual(data.entries, { plan: { step: 2, notes: ["é"] } });
  });
});

test("page storage answers list and delete", async () => {
  await withSession(async ({ base, key }) => {
    await pageStore(base(), key, { op: "set", key: "todo:1", value: "a" });
    await pageStore(base(), key, { op: "set", key: "todo:2", value: "b" });
    await pageStore(base(), key, { op: "set", key: "theme", value: "dark" });
    const listed = await (await pageStore(base(), key, { op: "list", prefix: "todo:" })).json();
    assert.deepEqual(listed, { keys: ["todo:1", "todo:2"] });
    const removed = await (await pageStore(base(), key, { op: "delete", key: "todo:1" })).json();
    assert.deepEqual(removed, { deleted: true });
    const missing = await (await pageStore(base(), key, { op: "get", key: "todo:1" })).json();
    assert.deepEqual(missing, { found: false });
  });
});

test("page storage is refused to anything but this server's own pages", async () => {
  await withSession(async ({ base, key }) => {
    // The artifact frame's opaque origin, a foreign site, and a header-less caller are all refused:
    // only the chrome may store for a page.
    for (const origin of ["null", "https://evil.example", ""]) {
      const response = await pageStore(base(), key, { op: "set", key: "k", value: 1 }, { origin });
      assert.equal(response.status, 403, `origin ${origin || "(none)"}`);
    }
    const data = await (await fetch(`${base()}/api/${key}/page-data`)).json();
    assert.equal(data.keys, 0);
  });
});

test("page storage validates on the server too", async () => {
  await withSession(async ({ base, key }) => {
    const badKey = await pageStore(base(), key, { op: "set", key: "", value: 1 });
    assert.equal(badKey.status, 400);
    assert.equal((await badKey.json()).code, "KEY_INVALID");

    const noValue = await pageStore(base(), key, { op: "set", key: "k" });
    assert.equal(noValue.status, 400);
    assert.equal((await noValue.json()).code, "VALUE_INVALID");

    const tooLarge = await pageStore(base(), key, { op: "set", key: "k", value: "x".repeat(1024 * 1024) });
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).code, "VALUE_TOO_LARGE");

    const unknown = await pageStore(base(), key, { op: "drop" });
    assert.equal(unknown.status, 400);

    const missingSession = await pageStore(base(), "fedcba9876543210", { op: "get", key: "k" });
    assert.equal(missingSession.status, 404);
  });
});

test("the CLI data routes refuse a foreign origin and clear on request", async () => {
  await withSession(async ({ base, key }) => {
    await pageStore(base(), key, { op: "set", key: "a", value: [1, 2, 3] });

    const foreignRead = await fetch(`${base()}/api/${key}/page-data`, { headers: { origin: "https://evil.example" } });
    assert.equal(foreignRead.status, 403);
    const foreignClear = await fetch(`${base()}/api/${key}/page-data/clear`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(foreignClear.status, 403);

    const cleared = await (
      await fetch(`${base()}/api/${key}/page-data/clear`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).json();
    assert.equal(cleared.status, "cleared");
    assert.equal(cleared.keys, 1);
    assert.equal((await (await fetch(`${base()}/api/${key}/page-data`)).json()).keys, 0);
  });
});

test("the SDK bundle and the chrome page carry the page-app limits", () => {
  const sdk = createSdkJs("abc", 1, "token", { pageAppLimits: { storeValueMaxBytes: 2048 } });
  assert.match(sdk, /const createPageApps=/);
  assert.match(sdk, /"storeValueMaxBytes":2048/);
  const html = createChromeHtml({ key: "abc", file: "/tmp/a.html" });
  assert.match(html, /"pageAppLimits":\{"storeKeyMaxChars":256/);
});
