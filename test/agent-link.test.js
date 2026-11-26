// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
// Automatic agent links (#3834): a session created inside T3 Code links to the thread of the
// conversation that created it, ending a session removes its link, and nothing else is reused.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import {
  agentOwnerId,
  autoLinkSession,
  createAgentNudger,
  linkT3Thread,
  readAgentBinding,
  runT3Cli,
} from "../src/agent-nudge.js";
import { createOpenOutput, linkOpenedSession } from "../src/cli.js";
import { serve } from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

const THREAD = "e155a1ac-6174-45dd-af6c-7859c475fd4b";
const CHILD_THREAD =
  "thread:delegated-task:command%3Amcp%3A44ad5a59-f40b-4952-812a-60d4b4296cbd%3Adelegate-task%3Areview-1";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-agent-link-"));
  const cli = path.join(dir, process.platform === "win32" ? "t3.cmd" : "t3");
  await writeFile(cli, "");
  const files = [];
  for (const name of ["one.html", "two.html", "three.html"]) {
    const file = path.join(dir, name);
    await writeFile(file, `<!doctype html><html><body>${name}</body></html>`);
    files.push(await canonicalFile(file));
  }
  return { dir, cli, files };
}

/** A fake T3 CLI: knows the given threads, records every call. */
function fakeT3({ threads = [THREAD], archived = [], sendCode = 0 } = {}) {
  const calls = [];
  /** @type {typeof runT3Cli} */
  const run = async (cli, args, options = {}) => {
    calls.push({ cli, args, input: options.input ?? "" });
    if (args[0] === "thread" && args[1] === "show") {
      if (!threads.includes(args[2])) return { code: 1, stdout: "" };
      return {
        code: 0,
        stdout: JSON.stringify({ thread: { threadId: args[2], archived: archived.includes(args[2]) } }),
      };
    }
    if (args[0] === "thread" && args[1] === "send") return { code: sendCode, stdout: "" };
    return { code: 2, stdout: "" };
  };
  return { run, calls };
}

/** The thread a session is linked to, or null. */
async function linkedThread(dir, key) {
  const binding = await readAgentBinding(dir, key);
  return binding?.transport === "t3-thread" ? binding.thread : null;
}

const t3Env = (cli, conversation = "conversation-a") => ({
  T3CODE_CLI_PATH: cli,
  CLAUDE_CODE_SESSION_ID: conversation,
});

test("a linked conversation links its later sessions to the same thread, and no one else's", async () => {
  const { dir, cli, files } = await fixture();
  const t3 = fakeT3();
  try {
    const first = await linkOpenedSession(files[0], THREAD, t3Env(cli), { stateDir: dir, run: t3.run });
    assert.deepEqual(first, { status: "linked" });
    assert.deepEqual(t3.calls[0].args, ["thread", "show", THREAD, "--json", "--messages", "0"]);

    const second = await linkOpenedSession(files[1], null, t3Env(cli), { stateDir: dir, run: t3.run });
    assert.deepEqual(second, { status: "linked" });
    assert.equal(await linkedThread(dir, sessionKey(files[1])), THREAD);
    assert.equal(t3.calls.length, 1, "reuse does not start the T3 CLI again");

    const stranger = await linkOpenedSession(files[2], null, t3Env(cli, "conversation-b"), { stateDir: dir });
    assert.deepEqual(stranger, { status: "not linked" });
    assert.equal(await readAgentBinding(dir, sessionKey(files[2])), null);

    assert.equal(await linkOpenedSession(files[2], null, { CLAUDE_CODE_SESSION_ID: "conversation-a" }), undefined);
    assert.equal(agentOwnerId({ CLAUDE_CODE_SESSION_ID: "conversation-a" }), null, "outside T3 Code there is no owner");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse never replaces a session another conversation linked", async () => {
  const { dir, cli, files } = await fixture();
  const t3 = fakeT3({ threads: [THREAD, CHILD_THREAD] });
  try {
    await linkOpenedSession(files[0], THREAD, t3Env(cli, "conversation-a"), { stateDir: dir, run: t3.run });
    await linkOpenedSession(files[1], CHILD_THREAD, t3Env(cli, "conversation-b"), { stateDir: dir, run: t3.run });
    // Conversation A reopens B's review without a thread: it is still linked, to B's thread.
    assert.deepEqual(await linkOpenedSession(files[1], null, t3Env(cli, "conversation-a"), { stateDir: dir }), {
      status: "linked",
    });
    assert.equal(await linkedThread(dir, sessionKey(files[1])), CHILD_THREAD);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent opens of one review settle on a single link", async () => {
  const { dir, cli, files } = await fixture();
  const t3 = fakeT3();
  try {
    await linkOpenedSession(files[0], THREAD, t3Env(cli), { stateDir: dir, run: t3.run });
    const owner = agentOwnerId(t3Env(cli));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => autoLinkSession(dir, sessionKey(files[1]), owner)),
    );
    assert.ok(results.every((result) => result?.status === "linked"));
    assert.equal(results.filter((result) => result?.source === "owner").length, 1);
    const left = await readdir(path.join(dir, "agent-bindings"));
    assert.deepEqual(left.sort(), [`${sessionKey(files[0])}.json`, `${sessionKey(files[1])}.json`].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a link is refused when T3 Code cannot vouch for the thread", async () => {
  const { dir, cli, files } = await fixture();
  const key = sessionKey(files[0]);
  try {
    const missing = await linkT3Thread(dir, key, { thread: CHILD_THREAD, cli, owner: null, run: fakeT3().run });
    assert.deepEqual(missing, { status: "failed", reason: "T3 Code could not show that thread" });
    const archived = fakeT3({ archived: [THREAD] });
    assert.equal(
      (await linkT3Thread(dir, key, { thread: THREAD, cli, owner: null, run: archived.run })).status,
      "failed",
    );
    const silent = await linkT3Thread(dir, key, {
      thread: THREAD,
      cli,
      owner: null,
      run: async () => ({ code: null, stdout: "" }),
    });
    assert.deepEqual(silent, { status: "failed", reason: "T3 Code did not answer" });

    const neverRun = fakeT3();
    for (const thread of ['x" & calc', "a&b", "../x", "", "%ZZ"]) {
      assert.equal((await linkT3Thread(dir, key, { thread, cli, owner: null, run: neverRun.run })).status, "failed");
    }
    for (const badCli of [path.join(dir, "evil.cmd"), "t3.cmd", path.join(dir, "missing", "t3.cmd")]) {
      assert.equal(
        (await linkT3Thread(dir, key, { thread: THREAD, cli: badCli, owner: null, run: neverRun.run })).status,
        "failed",
      );
    }
    assert.equal(neverRun.calls.length, 0);
    assert.equal(await readAgentBinding(dir, key), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Nudge agent sends one message naming the review through t3 thread send", async () => {
  const { dir, cli, files } = await fixture();
  const t3 = fakeT3({ threads: [CHILD_THREAD] });
  const session = { key: sessionKey(files[0]), file: files[0] };
  try {
    await linkT3Thread(dir, session.key, { thread: CHILD_THREAD, cli, owner: null, run: t3.run });
    const nudger = createAgentNudger(dir, { run: t3.run });
    const results = await Promise.all([nudger.send(session), nudger.send(session)]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["sent", "sent"],
    );
    const sends = t3.calls.filter((call) => call.args[1] === "send");
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].args, ["thread", "send", CHILD_THREAD, "-"]);
    assert.match(sends[0].input, /lavish poll/);
    assert.ok(sends[0].input.includes(files[0]));
    assert.equal((await nudger.send(session)).status, "recently-sent");

    const failing = fakeT3({ threads: [CHILD_THREAD], sendCode: 1 });
    const failingNudger = createAgentNudger(dir, { run: failing.run });
    assert.equal((await failingNudger.send(session)).status, "failed");
    assert.equal((await failingNudger.send(session)).status, "recently-sent", "a failed attempt still cools down");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("open output names the link state only inside T3 Code", () => {
  const base = { file: "/r/review.html", url: "http://127.0.0.1/session/k", status: "opened" };
  assert.equal(createOpenOutput(base).agent_link, undefined);
  assert.deepEqual(createOpenOutput({ ...base, agentLink: { status: "linked" } }).agent_link, { status: "linked" });
  const unlinked = createOpenOutput({ ...base, agentLink: { status: "not linked" } }).agent_link;
  assert.equal(unlinked.status, "not linked");
  assert.match(unlinked.next_step, /bind-agent \/r\/review\.html --t3-thread <id>/);
  assert.match(unlinked.next_step, /parentThreadId/);
  const failed = createOpenOutput({ ...base, agentLink: { status: "failed", reason: "T3 Code has no such thread" } });
  assert.equal(failed.agent_link.reason, "T3 Code has no such thread");
});

async function openSession(base, file) {
  const response = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  return (await response.json()).key;
}

test("ending a review removes its link on every end path, repeatedly, and keeps the conversation's", async () => {
  const { dir, cli, files } = await fixture();
  const t3 = fakeT3();
  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    hosts: ["127.0.0.1"],
    stateFile: path.join(dir, "state.json"),
    agentNudger: createAgentNudger(dir, { run: t3.run }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const [agentEnded, userEnded] = [await openSession(base, files[0]), await openSession(base, files[1])];
    await linkOpenedSession(files[0], THREAD, t3Env(cli), { stateDir: dir, run: t3.run });
    await linkOpenedSession(files[1], null, t3Env(cli), { stateDir: dir });

    const check = async (key) => (await fetch(`${base}/api/${key}/nudge`, { headers: { origin: base } })).json();
    assert.equal((await fetch(`${base}/api/${agentEnded}/nudge`)).status, 403, "the check needs the chrome's origin");
    assert.deepEqual(await check(agentEnded), { available: true });

    const end = () =>
      fetch(`${base}/api/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: files[0] }),
      }).then((response) => response.json());
    assert.deepEqual(await end(), { status: "ended", agent_link_released: "t3-thread" });
    assert.deepEqual(await end(), { status: "ended" }, "a repeated end has nothing left to release");
    assert.deepEqual(await check(agentEnded), { available: false });

    await fetch(`${base}/api/${userEnded}/end`, { method: "POST", headers: { origin: base } });
    for (let i = 0; i < 50 && existsSync(path.join(dir, "agent-bindings", `${userEnded}.json`)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await readAgentBinding(dir, userEnded), null);
    assert.equal(t3.calls.filter((call) => call.args[1] === "send").length, 0, "ending never nudges");

    // The conversation still links its next review without asking again.
    assert.deepEqual(await linkOpenedSession(files[2], null, t3Env(cli), { stateDir: dir }), { status: "linked" });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a restarted server releases links of reviews that ended while it was down", async () => {
  const { dir, cli, files } = await fixture();
  const t3 = fakeT3();
  const stateFile = path.join(dir, "state.json");
  const options = { port: 0, host: "127.0.0.1", hosts: ["127.0.0.1"], stateFile };
  let server = await serve({ ...options, agentNudger: createAgentNudger(dir, { run: t3.run }) });
  let base = `http://127.0.0.1:${server.port}`;
  try {
    const ended = await openSession(base, files[0]);
    const live = await openSession(base, files[1]);
    await linkOpenedSession(files[0], THREAD, t3Env(cli), { stateDir: dir, run: t3.run });
    await linkOpenedSession(files[1], THREAD, t3Env(cli), { stateDir: dir, run: t3.run });
    await server.close();

    // Simulates a crash between endSession and the release: the session is ended on disk, its link remains.
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    for (const session of Object.values(state.sessions)) if (session.key === ended) session.status = "ended";
    await writeFile(stateFile, JSON.stringify(state));
    // An orphaned link whose session is gone, and a conversation record nobody used for 31 days.
    await writeFile(path.join(dir, "agent-bindings", "orphan.json"), JSON.stringify({ transport: "t3-thread" }));
    const ownerFile = path.join(dir, "agent-owners", `${agentOwnerId(t3Env(cli))}.json`);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    await utimes(ownerFile, old, old);

    server = await serve({ ...options, agentNudger: createAgentNudger(dir, { run: t3.run }) });
    base = `http://127.0.0.1:${server.port}`;
    await server.agentLinksSwept;
    assert.equal(await readAgentBinding(dir, ended), null);
    assert.equal(existsSync(path.join(dir, "agent-bindings", "orphan.json")), false);
    assert.equal(await linkedThread(dir, live), THREAD);
    assert.equal(existsSync(ownerFile), false);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "the T3 CLI runner passes thread ids and the message through intact",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lavish-t3-runner-"));
    try {
      const cli = path.join(dir, "t3.cmd");
      // Echoes its arguments, then copies stdin, the same way T3's launcher hands them to its CLI.
      await writeFile(cli, '@echo off\r\necho %*> "%~dp0args.txt"\r\nmore > "%~dp0stdin.txt"\r\nexit /b 0\r\n');
      const result = await runT3Cli(cli, ["thread", "send", CHILD_THREAD, "-"], { input: "poll C:\\r\\a b.html" });
      assert.equal(result.code, 0);
      assert.equal(
        (await readFile(path.join(dir, "args.txt"), "utf8")).trim(),
        `"thread" "send" "${CHILD_THREAD}" "-"`,
      );
      assert.match(await readFile(path.join(dir, "stdin.txt"), "utf8"), /poll C:\\r\\a b\.html/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
