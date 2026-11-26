// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { serve, withArtifactBase } from "../src/server.js";

async function startServer(dir) {
  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    hosts: ["127.0.0.1"],
    stateFile: path.join(dir, "state.json"),
    idleTimeoutMs: null,
  });
  return { server, base: `http://127.0.0.1:${server.port}` };
}

async function openSession(base, file) {
  const response = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  return response.json();
}

async function listVersions(base, key) {
  const response = await fetch(`${base}/api/${key}/versions`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitFor(check, { timeoutMs = 6000, intervalMs = 60 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>\n`;

test("every saved change becomes a version, viewable read-only and comparable", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-versions-http-")));
  const { server, base } = await startServer(dir);
  try {
    const file = path.join(dir, "plan.html");
    await writeFile(file, page("Plan", '<h1>Plan</h1><p>Price is 10 EUR</p><img src="chart.png">'));
    const { key } = await openSession(base, file);
    // The chrome page starts the watcher, like a reviewer opening the review.
    assert.equal((await fetch(`${base}/session/${key}`)).status, 200);

    const first = await waitFor(async () => {
      const data = await listVersions(base, key);
      return data.versions.length === 1 ? data : null;
    });
    assert.equal(first.enabled, true);
    assert.equal(first.versions[0].id, 1);
    assert.equal(first.versions[0].current, true);
    assert.equal(first.versions[0].summary, 'First version: "Plan"');

    await writeFile(file, page("Plan", '<h1>Plan</h1><p>Price is 12 EUR</p><img src="chart.png">'));
    const second = await waitFor(async () => {
      const data = await listVersions(base, key);
      return data.versions.length === 2 ? data : null;
    });
    assert.deepEqual(
      second.versions.map((version) => [version.id, version.current]),
      [
        [2, true],
        [1, false],
      ],
    );
    assert.equal(second.versions[0].summary, '1 line changed: "Price is 12 EUR"');
    assert.equal(second.versions[0].change, "same size");
    assert.equal("hash" in second.versions[0], false);

    const view = await fetch(`${base}/api/${key}/versions/1/view`);
    assert.equal(view.status, 200);
    assert.match(view.headers.get("content-security-policy"), /^sandbox allow-scripts; frame-ancestors 'self'$/);
    assert.equal(view.headers.get("x-content-type-options"), "nosniff");
    const viewHtml = await view.text();
    assert.match(viewHtml, new RegExp(`<head><base href="/artifact/${key}/"><title>Plan</title>`));
    assert.match(viewHtml, /Price is 10 EUR/);
    assert.doesNotMatch(viewHtml, /sdk\.js/, "a version view carries no annotation SDK");

    const diff = await (await fetch(`${base}/api/${key}/versions/diff?from=1&to=2`)).json();
    assert.equal(diff.mode, "text");
    assert.deepEqual(diff.stats, { added: 0, removed: 0, changed: 1 });
    const mod = diff.rows.find((row) => row.t === "mod");
    assert.deepEqual(mod.parts, [
      ["=", "Price is "],
      ["-", "10"],
      ["+", "12"],
      ["=", " EUR"],
    ]);
    const htmlDiff = await (await fetch(`${base}/api/${key}/versions/diff?from=1&to=2&mode=html`)).json();
    assert.equal(htmlDiff.mode, "html");
    assert.equal(htmlDiff.stats.changed, 1);

    assert.equal((await fetch(`${base}/api/${key}/versions/9/view`)).status, 404);
    assert.equal((await fetch(`${base}/api/${key}/versions/abc/view`)).status, 404);
    assert.equal((await fetch(`${base}/api/${key}/versions/diff?from=1&to=9`)).status, 404);
    assert.equal((await fetch(`${base}/api/0000000000000000/versions`)).status, 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("one page's versions are never served under another page's key", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-versions-iso-")));
  const { server, base } = await startServer(dir);
  try {
    const a = path.join(dir, "a.html");
    const b = path.join(dir, "b.html");
    await writeFile(a, page("A", "<p>secret a</p>"));
    await writeFile(b, page("B", "<p>b</p>"));
    const { key: keyA } = await openSession(base, a);
    const { key: keyB } = await openSession(base, b);
    await waitFor(async () => (await listVersions(base, keyA)).versions.length === 1);
    await writeFile(a, page("A", "<p>secret a, second</p>"));
    await waitFor(async () => (await listVersions(base, keyA)).versions.length >= 1);
    const viaB = await fetch(`${base}/api/${keyB}/versions/1/view`);
    const text = await viaB.text();
    assert.doesNotMatch(text, /secret a/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore needs the chrome's origin, writes the version back and keeps the newer state", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-versions-restore-")));
  const { server, base } = await startServer(dir);
  try {
    const file = path.join(dir, "plan.html");
    const v1 = page("Plan", "<p>one</p>");
    await writeFile(file, v1);
    const { key } = await openSession(base, file);
    await waitFor(async () => (await listVersions(base, key)).versions.length === 1);
    const v2 = page("Plan", "<p>two</p>");
    await writeFile(file, v2);
    await waitFor(async () => (await listVersions(base, key)).versions.length === 2);

    const restoreUrl = `${base}/api/${key}/versions/1/restore`;
    for (const headers of [{}, { origin: "https://evil.example" }, { origin: "null" }]) {
      const refused = await fetch(restoreUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
      assert.equal(refused.status, 403);
    }
    assert.equal(await readFile(file, "utf8"), v2, "a refused restore leaves the file alone");

    const restored = await fetch(restoreUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: "{}",
    });
    assert.equal(restored.status, 200);
    const body = await restored.json();
    assert.equal(body.status, "restored");
    assert.equal(body.restored_from, 1);
    assert.equal(body.version.id, 3);
    assert.equal(body.version.summary, "Restored version 1");
    assert.equal(await readFile(file, "utf8"), v1);

    // The save the watcher reports next is the same content, so it adds nothing.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = await listVersions(base, key);
    assert.deepEqual(
      after.versions.map((version) => [version.id, version.current]),
      [
        [3, true],
        [2, false],
        [1, false],
      ],
      "only the newest copy of the current content is current",
    );
    assert.equal(after.versions[0].source, "restore");
    assert.equal(after.versions[0].restored_from, 1);

    const missing = await fetch(`${base}/api/${key}/versions/42/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: "{}",
    });
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a reviewer's restore does not mark delivered notes Working, an agent's save still does", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-versions-working-")));
  const { server, base } = await startServer(dir);
  try {
    const file = path.join(dir, "plan.html");
    await writeFile(file, page("Plan", "<p>one</p>"));
    const { key } = await openSession(base, file);
    await waitFor(async () => (await listVersions(base, key)).versions.length === 1);
    await writeFile(file, page("Plan", "<p>two</p>"));
    await waitFor(async () => (await listVersions(base, key)).versions.length === 2);

    const queued = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ prompts: [{ prompt: "Go back to one", tag: "message", selector: "body", text: "" }] }),
    });
    assert.equal(queued.status, 200);
    const delivered = await (await fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=0`)).json();
    assert.equal(delivered.status, "feedback");
    const chatEntry = async () =>
      JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).sessions[key].chat[0];
    assert.ok((await chatEntry()).delivered_at);

    const restored = await fetch(`${base}/api/${key}/versions/1/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: "{}",
    });
    assert.equal(restored.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal("working_at" in (await chatEntry()), false, "the reviewer's own restore is not the agent working");

    await writeFile(file, page("Plan", "<p>three</p>"));
    const working = await waitFor(async () => (await chatEntry()).working_at);
    assert.ok(working, "a later agent save still stamps Working");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore refuses an ended review and a page swapped for a symlink", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-versions-guard-")));
  const { server, base } = await startServer(dir);
  try {
    const file = path.join(dir, "plan.html");
    await writeFile(file, page("Plan", "<p>one</p>"));
    const { key } = await openSession(base, file);
    await waitFor(async () => (await listVersions(base, key)).versions.length === 1);
    await writeFile(file, page("Plan", "<p>two</p>"));
    await waitFor(async () => (await listVersions(base, key)).versions.length === 2);

    const outside = path.join(dir, "outside.html");
    await writeFile(outside, "<p>outside</p>");
    await unlink(file);
    await symlink(outside, file);
    const swapped = await fetch(`${base}/api/${key}/versions/1/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: "{}",
    });
    assert.equal(swapped.status, 409);
    assert.equal(await readFile(outside, "utf8"), "<p>outside</p>", "nothing is written through the link");

    await fetch(`${base}/api/${key}/end`, { method: "POST", headers: { origin: base } });
    const ended = await fetch(`${base}/api/${key}/versions/1/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: "{}",
    });
    assert.equal(ended.status, 409);
    assert.equal((await ended.json()).status, "ended");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the chrome page offers Versions and loads its script and styles from the asset allowlist", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-versions-chrome-")));
  const { server, base } = await startServer(dir);
  try {
    const file = path.join(dir, "plan.html");
    await writeFile(file, page("Plan", "<p>one</p>"));
    const { key } = await openSession(base, file);
    const chrome = await (await fetch(`${base}/session/${key}`)).text();
    assert.match(chrome, /id="openVersions"/);
    assert.match(chrome, /id="versionsDialog"/);
    assert.match(chrome, /<script src="\/lavish-assets\/versions-client\.js"><\/script>/);
    assert.match(chrome, /<link rel="stylesheet" href="\/lavish-assets\/versions\.css">/);
    assert.match(
      chrome,
      /<iframe class="versions-frame" id="versionsFrame" title="Saved version, read-only" sandbox="allow-scripts">/,
    );
    for (const asset of ["versions-client.js", "versions.css", "gallery-client.js", "gallery.css"]) {
      const response = await fetch(`${base}/lavish-assets/${asset}`);
      assert.equal(response.status, 200, asset);
    }
    for (const asset of ["server.js", "..%2Fpackage.json", "chrome-client.js"]) {
      assert.equal((await fetch(`${base}/lavish-assets/${asset}`)).status, 404, asset);
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the gallery lists every page with its status and keeps pins", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-gallery-http-")));
  const { server, base } = await startServer(dir);
  try {
    const plan = path.join(dir, "plan.html");
    const notes = path.join(dir, "notes.html");
    await writeFile(plan, page("Launch plan", "<p>plan</p>"));
    await writeFile(notes, page("Meeting notes", "<p>notes</p>"));
    const { key: planKey } = await openSession(base, plan);
    const { key: notesKey } = await openSession(base, notes);
    await fetch(`${base}/api/${notesKey}/end`, { method: "POST", headers: { origin: base } });

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("x-frame-options"), "DENY");
    const html = await home.text();
    assert.match(html, /<title>Pages · Lavish<\/title>/);
    assert.match(html, /"title":"Launch plan"/);
    assert.equal((await fetch(`${base}/gallery`)).status, 200);

    const { entries } = await (await fetch(`${base}/api/gallery`)).json();
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    assert.equal(byKey.get(planKey).status, "waiting");
    assert.equal(byKey.get(planKey).title, "Launch plan");
    assert.equal(byKey.get(notesKey).status, "ended");
    assert.equal(byKey.get(notesKey).ended_by, "user");

    const pinUrl = `${base}/api/gallery/pins`;
    const refused = await fetch(pinUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ key: notesKey, pinned: true }),
    });
    assert.equal(refused.status, 403);
    const pinned = await fetch(pinUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ key: notesKey, pinned: true }),
    });
    assert.deepEqual(await pinned.json(), { pins: [notesKey] });
    const unknown = await fetch(pinUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ key: "0000000000000000", pinned: true }),
    });
    assert.equal(unknown.status, 404);
    const sorted = (await (await fetch(`${base}/api/gallery`)).json()).entries;
    assert.equal(sorted[0].key, notesKey);
    assert.equal(sorted[0].pinned, true);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("one click in the gallery reopens an ended review", async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-gallery-open-")));
  const { server, base } = await startServer(dir);
  try {
    const file = path.join(dir, "plan.html");
    await writeFile(file, page("Plan", "<p>plan</p>"));
    const { key } = await openSession(base, file);
    // A second open review keeps the server up: ending the last one stops it.
    const other = path.join(dir, "other.html");
    await writeFile(other, page("Other", "<p>other</p>"));
    await openSession(base, other);
    await fetch(`${base}/api/${key}/end`, { method: "POST", headers: { origin: base } });

    const refused = await fetch(`${base}/api/gallery/${key}/open`, { method: "POST" });
    assert.equal(refused.status, 403, "a header-less caller cannot reopen a user-ended review");

    const reopened = await fetch(`${base}/api/gallery/${key}/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: "{}",
    });
    assert.equal(reopened.status, 200);
    assert.deepEqual(await reopened.json(), { status: "opened", url: `/session/${key}` });
    const { entries } = await (await fetch(`${base}/api/gallery`)).json();
    assert.equal(entries.find((entry) => entry.key === key).status, "waiting");

    await unlink(file);
    const gone = await fetch(`${base}/api/gallery/${key}/open`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: "{}",
    });
    assert.equal(gone.status, 404);
    const missing = (await (await fetch(`${base}/api/gallery`)).json()).entries.find((entry) => entry.key === key);
    assert.equal(missing.missing, true);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("withArtifactBase points relative links at the page folder unless the page has a base", () => {
  const key = "0123456789abcdef";
  assert.equal(
    withArtifactBase("<!doctype html><html><head><title>x</title></head></html>", key),
    `<!doctype html><html><head><base href="/artifact/${key}/"><title>x</title></head></html>`,
  );
  assert.equal(withArtifactBase("<p>bare</p>", key), `<base href="/artifact/${key}/"><p>bare</p>`);
  assert.equal(withArtifactBase('<html lang="en"><body></body></html>', key).indexOf("<base"), 16);
  const own = '<head><base href="https://cdn.example/"></head>';
  assert.equal(withArtifactBase(own, key), own);
  assert.match(withArtifactBase("<header><head></head></header>", key), /^<header><head><base/);
});
