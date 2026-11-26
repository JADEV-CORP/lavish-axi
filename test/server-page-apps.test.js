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

// ---- Ask the agent from the page. ----

function ask(base, key, body, { origin = base } = {}) {
  return fetch(`${base}/api/${key}/asks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

/** Open the review's live stream as the chrome would, and collect its events. */
async function liveEvents(base, key) {
  const { default: WebSocket } = await import("ws");
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/events/${key}`, { origin: base });
  const received = [];
  socket.on("message", (data) => received.push(JSON.parse(String(data))));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    received,
    async next(type, accept = (/** @type {any} */ _event) => true) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const found = received.find((event) => event.type === type && accept(event));
        if (found) {
          received.splice(received.indexOf(found), 1);
          return found;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no ${type} event`);
    },
    close: () => socket.close(),
  };
}

test("a page question with no agent listening is refused at once", async () => {
  await withSession(async ({ base, key }) => {
    const response = await ask(base(), key, { question: "Which plan?" });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "NO_AGENT");
    assert.match(body.error, /lavish poll/);
  });
});

test("only this server's chrome can ask, and the question is validated", async () => {
  await withSession(async ({ base, key }) => {
    for (const origin of ["null", "https://evil.example", ""]) {
      assert.equal((await ask(base(), key, { question: "Hi?" }, { origin })).status, 403, origin || "(none)");
    }
    assert.equal((await ask(base(), key, { question: "   " })).status, 400);
    assert.equal((await ask(base(), key, { question: "x".repeat(4001) })).status, 400);
  });
});

test("a question reaches the waiting poll, and the agent's reply comes back to the page", async () => {
  await withSession(async ({ base, key, artifact }) => {
    const events = await liveEvents(base(), key);
    try {
      const poll = fetch(`${base()}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=5000`);
      // Wait until the poll is listening, as the chrome would see it.
      await events.next("agent-presence", (event) => event.data.state === "listening");
      const asked = await ask(base(), key, { question: "Which plan?", context: "plans[2]: A,B", timeout_ms: 60000 });
      assert.equal(asked.status, 200);
      const { ask: created } = await asked.json();
      assert.match(created.id, /^ask-[0-9a-f]{8}$/);

      const delivered = await (await poll).json();
      assert.equal(delivered.status, "feedback");
      assert.equal(delivered.prompts[0].tag, "ask");
      assert.equal(delivered.prompts[0].target.ask_id, created.id);
      assert.equal(delivered.prompts[0].target.expects_reply, true);

      const replied = await fetch(`${base()}/api/${key}/agent-reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Plan B.", ask_id: created.id }),
      });
      assert.deepEqual(await replied.json(), { status: "sent", ask_id: created.id });
      const reply = await events.next("agent-reply");
      assert.equal(reply.data.ask_id, created.id);
      assert.equal(reply.data.text, "Plan B.");

      // Answered: naming it again posts nothing.
      const again = await fetch(`${base()}/api/${key}/agent-reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Plan C.", ask_id: created.id }),
      });
      assert.equal(again.status, 409);
      assert.equal((await again.json()).code, "ASK_CLOSED");
    } finally {
      events.close();
    }
  });
});

test("a newer question tells the page its older one was replaced", async () => {
  await withSession(async ({ base, key, artifact }) => {
    const events = await liveEvents(base(), key);
    const poll = fetch(`${base()}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=300`);
    try {
      await events.next("agent-presence", (event) => event.data.state === "listening");
      // The first question wakes the poll; the agent is then working, which still counts as listening.
      const first = await (await ask(base(), key, { question: "First?" })).json();
      await poll;
      const second = await (await ask(base(), key, { question: "Second?" })).json();
      assert.deepEqual(second.superseded, [first.ask.id]);
      const closed = await events.next("ask-closed");
      assert.deepEqual(closed.data, { ask_id: first.ask.id, status: "superseded" });
    } finally {
      events.close();
    }
  });
});

test("a poll whose --ask names no open question posts nothing and does not listen", async () => {
  await withSession(async ({ base, key, artifact }) => {
    const response = await fetch(`${base()}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=200`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_reply: "Plan B.", ask_id: "ask-ffffffff" }),
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "ASK_NOT_FOUND");
    const health = await (await fetch(`${base()}/health`)).json();
    assert.deepEqual(health.listeners, []);
    const state = await (await fetch(`${base()}/session/${key}`)).text();
    assert.doesNotMatch(state, /Plan B\./);
  });
});
