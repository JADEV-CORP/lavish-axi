// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { AxiError } from "axi-sdk-js";
import { serve } from "../src/server.js";
import WebSocket from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { fetchJson, shutdownServerOnPort, shouldRestartServer, VERSION } from "../src/cli.js";

async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-l39-"));
  const file = path.join(dir, "review.html");
  await writeFile(file, "<!doctype html><title>Review</title>");
  const server = await serve({
    port: 0,
    hosts: ["127.0.0.1"],
    env: {},
    stateFile: path.join(dir, "state.json"),
    idleTimeoutMs: null,
    log: () => {},
    ...options,
  });
  const base = `http://127.0.0.1:${server.port}`;
  await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  return {
    server,
    dir,
    base,
    file,
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("bounded polls send headers and heartbeat bytes before their round ends", async () => {
  const f = await fixture({ pollHeartbeatMs: 10 });
  try {
    const res = await fetch(`${f.base}/api/poll?file=${encodeURIComponent(f.file)}&timeoutMs=2000`);
    assert.equal(res.headers.get("lavish-poll-state"), "listening");
    const reader = res.body.getReader();
    let text = "";
    while (text.length < 2) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /^\s+$/);
    await reader.cancel();
  } finally {
    await f.close();
  }
});

for (const phase of ["headers", "body"])
  test(`${phase} timeouts are reported as timeouts without restart recovery`, async () => {
    const previous = getGlobalDispatcher();
    const dispatcher = new Agent({ headersTimeout: 20, bodyTimeout: 20 });
    setGlobalDispatcher(dispatcher);
    const server = createServer((_req, res) => {
      if (phase === "body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write(" ");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no TCP port");
      await assert.rejects(fetchJson(`http://127.0.0.1:${address.port}/api/poll`), (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "POLL_TIMEOUT");
        assert.match(error.message, /timed out/i);
        assert.equal("serverLost" in error, false);
        return true;
      });
    } finally {
      setGlobalDispatcher(previous);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await dispatcher.close();
    }
  });

test("new poll clients wait for old servers that send no headers until the round ends", async () => {
  const previous = getGlobalDispatcher();
  const dispatcher = new Agent({ headersTimeout: 20, bodyTimeout: 20 });
  setGlobalDispatcher(dispatcher);
  const server = createServer((_req, res) => {
    setTimeout(() => res.end(JSON.stringify({ status: "waiting" })), 1200);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no TCP port");
    assert.deepEqual(await fetchJson(`http://127.0.0.1:${address.port}/api/poll`, { longPoll: true }), {
      status: "waiting",
    });
  } finally {
    setGlobalDispatcher(previous);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await dispatcher.close();
  }
});

test("old JSON clients accept heartbeat whitespace and the final bounded poll result", async () => {
  const f = await fixture({ pollHeartbeatMs: 10 });
  try {
    const response = await fetch(`${f.base}/api/poll?file=${encodeURIComponent(f.file)}&timeoutMs=60`);
    assert.deepEqual(await response.json(), { status: "waiting" });
  } finally {
    await f.close();
  }
});
test("a failed Tailscale check cannot mark a working address stale", async () => {
  let calls = 0;
  const logs = [];
  const f = await fixture({
    hosts: undefined,
    detectTailscale: async () => (++calls === 1 ? { ipv4: "127.0.0.1", magicDnsName: "review.test" } : null),
    log: (line) => logs.push(line),
  });
  try {
    const health = await fetch(`${f.base}/health?reconcile_network=1`).then((res) => res.json());
    assert.equal(health.network_stale, undefined);
    assert.ok(logs.some((line) => /Tailscale.*(unavailable|failed)/i.test(line)));
  } finally {
    await f.close();
  }
});

test("startup retries unknown Tailscale detection and adopts the first successful address", async () => {
  let calls = 0;
  const f = await fixture({
    hosts: undefined,
    tailscaleRecoveryDelayMs: 10,
    detectTailscale: async () => (++calls < 3 ? null : { ipv4: "127.0.0.1", magicDnsName: "review.test" }),
  });
  try {
    const deadline = Date.now() + 1000;
    while (calls < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(calls >= 3, "startup detection must retry without a CLI health request");
    const health = await fetch(`${f.base}/health?reconcile_network=1`).then((res) => res.json());
    assert.equal(health.network_stale, undefined);
    assert.ok(health.requested_hosts.includes("127.0.0.1"));
  } finally {
    await f.close();
  }
});

test("a successful changed Tailscale address reports and logs the actual mismatch", async () => {
  let calls = 0;
  const logs = [];
  const f = await fixture({
    hosts: undefined,
    detectTailscale: async () => ({ ipv4: "127.0.0.1", magicDnsName: ++calls === 1 ? "old.test" : "new.test" }),
    log: (line) => logs.push(line),
  });
  try {
    const health = await fetch(`${f.base}/health?reconcile_network=1`).then((res) => res.json());
    assert.equal(health.network_stale, true);
    assert.match(health.network_stale_reason, /old.test.*new.test/);
    assert.ok(logs.some((line) => /network stale.*old.test.*new.test/.test(line)));
  } finally {
    await f.close();
  }
});

for (const reason of ["stop", "upgrade", "local-build", ""]) {
  test(`an active poll refuses ${reason || "anonymous replacement"} unless forced`, async () => {
    const logs = [];
    const f = await fixture({ log: (line) => logs.push(line) });
    let response;
    try {
      response = await fetch(`${f.base}/api/poll?file=${encodeURIComponent(f.file)}`);
      const denied = await fetch(`${f.base}/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      assert.equal(denied.status, 409);
      assert.equal((await denied.json()).code, "SERVER_BUSY");
      assert.ok(logs.some((line) => /shutdown refused.*active/i.test(line)));
      assert.equal((await fetch(`${f.base}/health`)).status, 200);
      const forced = await fetch(`${f.base}/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason, force: true }),
      });
      assert.equal(forced.status, 200);
      const result = await response.json();
      assert.equal(result.code, "SERVER_RESTARTED");
      await f.server.done;
      assert.ok(logs.some((line) => /shutting down:.*force=true/.test(line)));
    } finally {
      await response?.body?.cancel().catch(() => {});
      await f.close();
    }
  });
}

test("a review listener without a poll also protects the shared server", async () => {
  const f = await fixture();
  const { sessionKey } = await import("../src/session-store.js");
  const socket = new WebSocket(`${f.base.replace(/^http/, "ws")}/events/${sessionKey(f.file)}`, { origin: f.base });
  await once(socket, "open");
  try {
    const health = await fetch(`${f.base}/health`).then((res) => res.json());
    assert.equal(health.active_connections.reviewers, 1);
    await assert.rejects(shutdownServerOnPort(f.server.port, { baseUrl: f.base }), (error) => {
      assert.ok(error instanceof AxiError);
      assert.equal(error.code, "SERVER_BUSY");
      assert.match(error.message, /--force/);
      return true;
    });
  } finally {
    socket.terminate();
    await f.close();
  }
});

test("legacy stale flags without a successful-change reason cannot trigger replacement", () => {
  assert.equal(shouldRestartServer(VERSION, { app: "lavish-axi", version: VERSION, network_stale: true }), false);
});

test("built CLI refuses an upgrade with an active poll, then honors explicit forced stop", async () => {
  const f = await fixture({ version: "0.0.1" });
  const response = await fetch(`${f.base}/api/poll?file=${encodeURIComponent(f.file)}`);
  const run = promisify(execFile);
  const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  const env = {
    ...process.env,
    LAVISH_AXI_PORT: String(f.server.port),
    LAVISH_AXI_STATE_DIR: f.dir,
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_NO_OPEN: "1",
  };
  try {
    await assert.rejects(run(process.execPath, [cli, f.file, "--no-open"], { env, windowsHide: true }), (error) => {
      assert.ok(error instanceof Error);
      assert.ok("stderr" in error);
      assert.match(String(error.stderr) + ("stdout" in error ? String(error.stdout) : ""), /SERVER_BUSY|active polls/);
      return true;
    });
    assert.equal((await fetch(`${f.base}/health`)).status, 200);
    await run(process.execPath, [cli, "stop", "--port", String(f.server.port), "--force"], { env, windowsHide: true });
    assert.equal((await response.json()).code, "SERVER_RESTARTED");
    await f.server.done;
  } finally {
    await response.body?.cancel().catch(() => {});
    await f.close();
  }
});

test("a shutdown refusal never falls through to process termination", async () => {
  let kills = 0;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") res.end(JSON.stringify({ app: "lavish-axi", version: "0.0.1", listeners: [] }));
    else {
      res.statusCode = 409;
      res.end(JSON.stringify({ code: "SERVER_BUSY", error: "A listener attached. Wait or use --force." }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port");
  try {
    await assert.rejects(
      shutdownServerOnPort(address.port, {
        baseUrl: `http://127.0.0.1:${address.port}`,
        killServerProcess: () => {
          kills++;
          return true;
        },
      }),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, "SERVER_BUSY");
        return true;
      },
    );
    assert.equal(kills, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

// The move to @jadev-corp/lavish 1.0.0: machines still run a 0.1.98-jadev.N server. The first npm
// CLI must count as newer and replace it, but only the way any upgrade does: never under an open
// review (whose unsent draft would be lost) or an active poll, unless forced.
test("the built CLI replaces an idle 0.1.98-jadev.N server, never one with an open review or a poll", async () => {
  const logs = [];
  const f = await fixture({ version: "0.1.98-jadev.2", log: (line) => logs.push(line) });
  const { sessionKey } = await import("../src/session-store.js");
  const run = promisify(execFile);
  const cli = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  const port = String(f.server.port);
  const env = {
    ...process.env,
    LAVISH_AXI_PORT: port,
    LAVISH_AXI_STATE_DIR: f.dir,
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_UPDATE_CHECK: "0",
  };
  const health = () => fetch(`${f.base}/health`).then((res) => res.json());
  const refused = (/** @type {any} */ error) => {
    assert.match(String(error?.stdout) + String(error?.stderr), /SERVER_BUSY/);
    return true;
  };
  let poll;
  try {
    const review = new WebSocket(`${f.base.replace(/^http/, "ws")}/events/${sessionKey(f.file)}`, { origin: f.base });
    await once(review, "open");
    await assert.rejects(run(process.execPath, [cli, f.file, "--no-open"], { env, windowsHide: true }), refused);
    assert.equal((await health()).version, "0.1.98-jadev.2", "an open review keeps the old server");
    review.terminate();

    poll = await fetch(`${f.base}/api/poll?file=${encodeURIComponent(f.file)}`);
    await assert.rejects(run(process.execPath, [cli, f.file, "--no-open"], { env, windowsHide: true }), refused);
    assert.equal((await health()).version, "0.1.98-jadev.2", "an active poll keeps the old server");
    await poll.body?.cancel().catch(() => {});
    const deadline = Date.now() + 5000;
    for (;;) {
      const { active_connections: active } = await health();
      if (active.polls === 0 && active.reviewers === 0) break;
      assert.ok(Date.now() < deadline, "the poll and the review released the server");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await run(process.execPath, [cli, f.file, "--no-open"], { env, windowsHide: true });
    await f.server.done;
    // From a source checkout the cause reads "local build replacement"; either way the open tabs are
    // told it is an upgrade, which is what decides between a reload and the unsent-draft banner.
    assert.ok(
      logs.some((line) =>
        /shutting down: .*running=0\.1\.98-jadev\.2; cli=\d+\.\d+\.\d+.*\(reason=upgrade\)/.test(line),
      ),
      logs.join("\n"),
    );
    assert.equal((await health()).version, VERSION, "the replacement runs this CLI's version");
  } finally {
    await poll?.body?.cancel().catch(() => {});
    await run(process.execPath, [cli, "stop", "--port", port, "--force"], { env, windowsHide: true }).catch(() => {});
    await f.close();
  }
});
