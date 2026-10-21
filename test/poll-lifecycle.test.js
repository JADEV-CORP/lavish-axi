// Copyright (c) 2026 JADEV-CORP. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.
// "Some sessions keep disconnecting the poll after sending the agent message" (#3834). Each case
// pins what happens to the listener after an agent reply: poll --agent-reply must keep listening
// through review-tab churn, and only a real absence past the grace may return browser_disconnected.
import assert from "node:assert/strict";
import { on, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { serve } from "../src/server.js";

const GRACE_MS = 150;

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-poll-life-"));
  const artifact = path.join(dir, "review.html");
  await writeFile(artifact, "<!doctype html><html><body>Review</body></html>");
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    browserDisconnectGraceMs: GRACE_MS,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const { key } = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: artifact }),
  }).then((response) => response.json());
  return {
    base,
    key,
    artifact,
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A review tab's live-event socket, collecting presence states and agent replies. */
async function openTab(base, key) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/events/${key}`, { origin: base });
  const seen = [];
  const messages = on(socket, "message");
  await once(socket, "open");
  (async () => {
    try {
      for await (const [data] of messages) {
        const message = JSON.parse(String(data));
        if (message.type === "agent-presence") seen.push(message.data.state);
        if (message.type === "agent-reply") seen.push("reply");
      }
    } catch {
      // Closed.
    }
  })();
  return {
    seen,
    async close() {
      socket.close();
      await once(socket, "close");
    },
  };
}

/** The agent's streaming poll, as the CLI sends it without --timeout-ms. */
function startPoll(base, artifact, agentReply = null) {
  const controller = new AbortController();
  let settled = null;
  const result = fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}`, {
    method: agentReply ? "POST" : "GET",
    signal: controller.signal,
    ...(agentReply
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_reply: agentReply }) }
      : {}),
  })
    .then((response) => response.text())
    .then((text) => {
      settled = JSON.parse(text.trim());
      return settled;
    })
    .catch(() => {
      settled = { status: "aborted" };
      return settled;
    });
  return { result, pending: () => settled === null, stop: () => controller.abort() };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await wait(10);
  }
}

async function sendFeedback(base, key, text) {
  await fetch(`${base}/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ prompts: [{ prompt: text, tag: "message" }] }),
  });
}

test("poll --agent-reply keeps listening well past the grace while the review stays open", async () => {
  const env = await setup();
  const tab = await openTab(env.base, env.key);
  try {
    const poll = startPoll(env.base, env.artifact, "Applied your feedback.");
    await until(() => tab.seen.includes("reply") && tab.seen.at(-1) === "listening");
    await wait(GRACE_MS * 4);
    assert.equal(poll.pending(), true, "the reply does not end the poll");
    assert.equal(tab.seen.at(-1), "listening");
    await sendFeedback(env.base, env.key, "Next change");
    assert.equal((await poll.result).status, "feedback", "the next feedback still reaches it");
  } finally {
    await tab.close();
    await env.close();
  }
});

test("a review tab that reconnects after the reply, inside the grace, keeps the poll", async () => {
  const env = await setup();
  let tab = await openTab(env.base, env.key);
  try {
    const poll = startPoll(env.base, env.artifact, "Done.");
    await until(() => tab.seen.at(-1) === "listening");
    await tab.close();
    await wait(GRACE_MS / 3);
    tab = await openTab(env.base, env.key);
    await wait(GRACE_MS * 3);
    assert.equal(poll.pending(), true);
    poll.stop();
    await poll.result;
  } finally {
    await tab.close();
    await env.close();
  }
});

test("closing one of two review tabs after the reply keeps the poll", async () => {
  const env = await setup();
  const first = await openTab(env.base, env.key);
  const second = await openTab(env.base, env.key);
  try {
    const poll = startPoll(env.base, env.artifact, "Done.");
    await until(() => first.seen.at(-1) === "listening");
    await first.close();
    await wait(GRACE_MS * 3);
    assert.equal(poll.pending(), true, "another tab is still reviewing");
    poll.stop();
    await poll.result;
  } finally {
    await second.close();
    await env.close();
  }
});

test("only a review gone past the grace returns browser_disconnected, and a later poll waits normally", async () => {
  const env = await setup();
  const tab = await openTab(env.base, env.key);
  const poll = startPoll(env.base, env.artifact, "Done.");
  try {
    await until(() => tab.seen.at(-1) === "listening");
    await tab.close();
    assert.deepEqual(await poll.result, { status: "browser_disconnected" });
    // The session stays open and resumable: the next poll is not cut short by the same absence.
    const next = startPoll(env.base, env.artifact);
    await wait(GRACE_MS * 3);
    assert.equal(next.pending(), true);
    next.stop();
    await next.result;
  } finally {
    await env.close();
  }
});

test("reply hands back without a listener, by design, and poll --agent-reply does not", async () => {
  const env = await setup();
  const tab = await openTab(env.base, env.key);
  try {
    const receipt = await fetch(`${env.base}/api/${env.key}/agent-reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Handing back." }),
    });
    assert.equal(receipt.ok, true);
    const presence = () => tab.seen.filter((state) => state !== "reply").at(-1);
    await until(() => tab.seen.includes("reply"));
    assert.equal(presence(), "waiting", "nobody listens after reply: the notice offers a nudge");

    const poll = startPoll(env.base, env.artifact, "Listening again.");
    await until(() => presence() === "listening");
    assert.equal(tab.seen.filter((state) => state === "reply").length, 2);
    poll.stop();
    await poll.result;
  } finally {
    await tab.close();
    await env.close();
  }
});

test("a poll re-attaches only to a healthy server that holds no listener for its review", async () => {
  const { pollReattachTarget } = await import("../src/cli.js");
  const target = (health, ensure = async () => "http://127.0.0.1:1") =>
    pollReattachTarget("review", { ensure, probe: async () => health, settleMs: 0 });

  assert.equal(await target({ ok: true, listeners: [] }), "http://127.0.0.1:1");
  assert.equal(await target({ ok: true, listeners: [{ key: "other" }] }), "http://127.0.0.1:1");
  assert.equal(await target({ ok: true, listeners: [{ key: "review" }] }), null, "a live claim would collide");
  assert.equal(await target({ ok: false }), null);
  assert.equal(await target(null), null);
  assert.equal(
    await target({ ok: true, listeners: [] }, async () => {
      throw new Error("no server");
    }),
    null,
  );
});
