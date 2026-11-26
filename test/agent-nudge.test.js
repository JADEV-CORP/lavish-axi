// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bindAgentNudge, createAgentNudger } from "../src/agent-nudge.js";

const webhook = "https://relay.t3.codes/v1/hooks/test/session/private-token";
const session = { key: "abc", file: "/work/review.html" };

test("a session-bound nudge sends only its file and key, and concurrent clicks send once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-nudge-"));
  const calls = [];
  try {
    await bindAgentNudge(dir, session.key, webhook);
    const nudger = createAgentNudger(dir, {
      request: async (url, options) => {
        calls.push({ url, options });
        return new Response(null, { status: 202 });
      },
    });
    assert.equal(await nudger.available(session.key), true);
    const results = await Promise.all([nudger.send(session), nudger.send(session)]);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].options.body), { file: session.file, key: session.key });
    assert.equal(calls[0].options.redirect, "error");
    assert.equal(results[0].status, "sent");
    assert.equal(results[1].status, "sent");
    assert.equal((await nudger.send(session)).status, "recently-sent");
    assert.equal((await nudger.send({ ...session, key: "unbound" })).status, "unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed nudge delivery never reports success or leaks the private webhook", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-nudge-"));
  try {
    await bindAgentNudge(dir, session.key, webhook);
    const nudger = createAgentNudger(dir, {
      request: async () => {
        throw new Error(webhook);
      },
    });
    const result = await nudger.send(session);
    assert.equal(result.status, "failed");
    assert.doesNotMatch(JSON.stringify(result), /private-token|relay\.t3/);
    assert.equal((await nudger.send(session)).status, "recently-sent");
    await bindAgentNudge(dir, session.key, null);
    assert.equal(await nudger.available(session.key), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nudge bindings refuse arbitrary URLs and unsafe session keys", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-nudge-"));
  try {
    for (const url of [
      "http://127.0.0.1/admin",
      "https://example.com",
      "https://relay.t3.codes.evil/v1/hooks/x",
      "https://user:pass@relay.t3.codes/v1/hooks/x",
    ]) {
      await assert.rejects(bindAgentNudge(dir, session.key, url), /T3 Connect/);
    }
    await assert.rejects(bindAgentNudge(dir, "../other", webhook), /session key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
