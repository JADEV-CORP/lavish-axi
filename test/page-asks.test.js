import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { askPromptText, askStatus, boundAsks, MAX_STORED_ASKS, replyTargetAsk } from "../src/page-asks.js";
import { canonicalFile, SessionStore } from "../src/session-store.js";

const NOW = Date.parse("2026-11-26T10:00:00.000Z");
const LATER = "2026-11-26T10:05:00.000Z";
const EARLIER = "2026-11-26T09:55:00.000Z";
const askPrompt = (id) => ({ prompt: "q", tag: "ask", target: { type: "ask", ask_id: id } });

test("askPromptText appends the page's data as TOON context", () => {
  assert.equal(askPromptText("  Which plan?  "), "Which plan?");
  assert.equal(askPromptText("Which plan?", "plans[2]: A,B"), "Which plan?\n\nContext data:\nplans[2]: A,B");
});

test("askStatus derives pending and delivered from the queue, and closes on a deadline", () => {
  const record = { id: "ask-00000001", expires_at: LATER };
  assert.equal(askStatus(record, [askPrompt("ask-00000001")], NOW), "pending");
  assert.equal(askStatus(record, [], NOW), "delivered");
  assert.equal(askStatus({ ...record, expires_at: EARLIER }, [], NOW), "expired");
  assert.equal(askStatus({ ...record, status: "answered" }, [], NOW), "answered");
  assert.equal(askStatus({ ...record, status: "superseded" }, [], NOW), "superseded");
});

test("an untargeted reply answers only a question the agent has received", () => {
  const asks = [
    { id: "ask-00000001", expires_at: LATER },
    { id: "ask-00000002", expires_at: LATER },
  ];
  // ask 1 still waits in the queue: a reply written before the agent saw it must not answer it.
  const target = /** @type {any} */ (replyTargetAsk(asks, [askPrompt("ask-00000001")], { now: NOW }));
  assert.equal(target.ask.id, "ask-00000002");
  assert.equal(
    /** @type {any} */ (replyTargetAsk(asks, [askPrompt("ask-00000001"), askPrompt("ask-00000002")], { now: NOW })).ask,
    null,
  );
});

test("an explicit --ask must name an open question", () => {
  const asks = [
    { id: "ask-00000001", expires_at: LATER, status: "answered" },
    { id: "ask-00000002", expires_at: EARLIER },
    { id: "ask-00000003", expires_at: LATER, status: "superseded" },
    { id: "ask-00000004", expires_at: LATER },
  ];
  const result = (askId) => /** @type {any} */ (replyTargetAsk(asks, [askPrompt("ask-00000004")], { askId, now: NOW }));
  assert.equal(result("ask-00000009").error.code, "ASK_NOT_FOUND");
  assert.deepEqual(
    [result("ask-00000001").error.code, result("ask-00000001").error.status],
    ["ASK_CLOSED", "answered"],
  );
  assert.match(result("ask-00000002").error.message, /expired at 2026-11-26T09:55:00.000Z/);
  assert.match(result("ask-00000003").error.message, /replaced by a newer question/);
  // Naming a question explicitly may answer it even before a poll took it.
  assert.equal(result("ask-00000004").ask.id, "ask-00000004");
});

test("boundAsks keeps the newest records and never drops an open one", () => {
  const records = Array.from({ length: MAX_STORED_ASKS + 3 }, (_, index) => ({
    id: `ask-${String(index).padStart(8, "0")}`,
    expires_at: LATER,
    status: index === 0 ? undefined : "answered",
  }));
  const kept = boundAsks(records, [], NOW);
  assert.equal(kept.length, MAX_STORED_ASKS);
  assert.equal(kept[0].id, "ask-00000000");
  assert.equal(kept.at(-1).id, records.at(-1).id);
});

async function withStore(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-asks-"));
  const artifact = path.join(dir, "page.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const store = new SessionStore(path.join(dir, "state.json"));
  const session = await store.upsertSession(await canonicalFile(artifact), "http://127.0.0.1/session/x");
  try {
    await run(store, session.key);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("createAsk queues a prompt tagged ask, with its own transcript bubble", async () => {
  await withStore(async (store, key) => {
    const created = await store.createAsk(key, {
      question: "Which plan?",
      context: "plans[2]: A,B",
      timeoutMs: 60_000,
    });
    assert.match(created.ask.id, /^ask-[0-9a-f]{8}$/);
    assert.deepEqual(created.superseded, []);
    const session = await store.findByKey(key);
    assert.equal(session.status, "feedback");
    const prompt = session.prompts[0];
    assert.equal(prompt.tag, "ask");
    assert.equal(prompt.prompt, "Which plan?\n\nContext data:\nplans[2]: A,B");
    assert.deepEqual(prompt.target, {
      type: "ask",
      ask_id: created.ask.id,
      expects_reply: true,
      expires_at: created.ask.expires_at,
    });
    const bubble = session.chat.at(-1);
    assert.equal(bubble.kind, "ask");
    assert.equal(bubble.ask_id, created.ask.id);
    assert.deepEqual(bubble.anchor, { kind: "ask", label: "page question" });
  });
});

test("a newer question replaces the page's open one, and the old one never reaches the agent", async () => {
  await withStore(async (store, key) => {
    const first = await store.createAsk(key, { question: "First?", timeoutMs: 60_000 });
    const second = await store.createAsk(key, { question: "Second?", timeoutMs: 60_000 });
    assert.deepEqual(second.superseded, [first.ask.id]);
    const taken = await store.takeFeedback(key);
    assert.deepEqual(
      taken.prompts.map((prompt) => prompt.target.ask_id),
      [second.ask.id],
    );
    const session = await store.findByKey(key);
    const firstBubble = session.chat.find((entry) => entry.ask_id === first.ask.id);
    assert.equal(firstBubble.receipt, "none");
    assert.ok(session.chat.find((entry) => entry.ask_id === second.ask.id).delivered_at);
  });
});

test("the next reply after delivery answers the question; a reply before delivery does not", async () => {
  await withStore(async (store, key) => {
    const { ask } = await store.createAsk(key, { question: "Which plan?", timeoutMs: 60_000 });
    let session = await store.addAgentReply(key, "Working on your earlier note.");
    assert.equal(session.chat.at(-1).ask_id, undefined);
    await store.takeFeedback(key);
    session = await store.addAgentReply(key, "Plan B.");
    assert.equal(session.chat.at(-1).ask_id, ask.id);
    await assert.rejects(store.addAgentReply(key, "Again", { askId: ask.id }), {
      code: "ASK_CLOSED",
      ask_status: "answered",
      statusCode: 409,
    });
    await assert.rejects(store.addAgentReply(key, "Who?", { askId: "ask-ffffffff" }), {
      code: "ASK_NOT_FOUND",
      statusCode: 404,
    });
    assert.equal((await store.askReplyError(key, ask.id)).code, "ASK_CLOSED");
  });
});

test("answering a question that still waits takes it out of the queue", async () => {
  await withStore(async (store, key) => {
    const { ask } = await store.createAsk(key, { question: "Which plan?", timeoutMs: 60_000 });
    const session = await store.addAgentReply(key, "Plan B.", { askId: ask.id });
    assert.equal(session.chat.at(-1).ask_id, ask.id);
    assert.equal(session.prompts.length, 0);
    assert.equal(session.status, "open");
    assert.deepEqual(await store.takeFeedback(key), { status: "waiting" });
  });
});

test("an expired question is not handed to the agent", async () => {
  await withStore(async (store, key) => {
    const { ask } = await store.createAsk(key, { question: "Quick?", timeoutMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await store.takeFeedback(key), { status: "waiting" });
    const session = await store.findByKey(key);
    assert.equal(session.prompts.length, 0);
    assert.equal(session.status, "open");
    assert.equal(session.chat.find((entry) => entry.ask_id === ask.id).receipt, "none");
    await assert.rejects(store.addAgentReply(key, "Late", { askId: ask.id }), {
      code: "ASK_CLOSED",
      ask_status: "expired",
    });
  });
});
