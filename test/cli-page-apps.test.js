import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { createDataOutput, VERSION } from "../src/cli.js";
import { serve } from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
function runCli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

/**
 * A served session the CLI adopts (same version), and a same-origin helper for the chrome routes.
 * @param {(ctx: { base: string, key: string, absolute: string, env: NodeJS.ProcessEnv, chromePost: (route: string, body: unknown) => Promise<Response> }) => Promise<void>} fn
 */
async function withPage(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-cli-page-apps-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const artifact = path.join(dir, "page.html");
  await writeFile(artifact, "<!doctype html><html><body>ok</body></html>");
  const absolute = await canonicalFile(artifact);
  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    stateFile: path.join(stateDir, "state.json"),
    version: VERSION,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(server.port),
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
    LAVISH_AXI_NO_OPEN: "1",
  };
  try {
    const opened = await runCli([artifact, "--no-open"], env);
    assert.equal(opened.status, 0, opened.stdout + opened.stderr);
    const key = sessionKey(absolute);
    const chromePost = (route, body) =>
      fetch(`${base}/api/${key}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify(body),
      });
    await fn({ base, key, absolute, env, chromePost });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("createDataOutput summarizes, lists entries, and prints JSON on request", () => {
  const stored = { keys: 1, bytes: 14, updated_at: "2026-11-26T10:00:00.000Z", entries: { plan: { step: 2 } } };
  assert.deepEqual(createDataOutput({ file: "/p.html", stored }), {
    data: { file: "/p.html", keys: 1, bytes: 14, updated_at: "2026-11-26T10:00:00.000Z" },
    entries: { plan: { step: 2 } },
  });
  assert.deepEqual(JSON.parse(/** @type {string} */ (createDataOutput({ file: "/p.html", stored, json: true }))), {
    file: "/p.html",
    keys: 1,
    bytes: 14,
    updated_at: "2026-11-26T10:00:00.000Z",
    entries: { plan: { step: 2 } },
  });
  const empty = /** @type {any} */ (createDataOutput({ file: "/p.html", stored: { keys: 0, bytes: 0, entries: {} } }));
  assert.match(empty.next_step, /stored nothing/);
});

test("lavish data prints what the page stored, and --clear needs --yes", async () => {
  await withPage(async ({ absolute, env, chromePost }) => {
    assert.equal((await chromePost("page-store", { op: "set", key: "plan", value: { step: 2 } })).status, 200);

    const shown = await runCli(["data", absolute], env);
    assert.equal(shown.status, 0, shown.stdout);
    assert.match(shown.stdout, /keys: 1/);
    assert.match(shown.stdout, /plan:/);
    assert.match(shown.stdout, /step: 2/);

    const json = await runCli(["data", absolute, "--json"], env);
    assert.equal(json.status, 0, json.stdout);
    assert.deepEqual(JSON.parse(json.stdout).entries, { plan: { step: 2 } });

    const unconfirmed = await runCli(["data", absolute, "--clear"], env);
    assert.notEqual(unconfirmed.status, 0);
    assert.match(unconfirmed.stdout, /CONFIRMATION_REQUIRED/);
    assert.match(unconfirmed.stdout, /Nothing was deleted/);
    assert.match(unconfirmed.stdout, /--clear --yes/);
    assert.equal(JSON.parse((await runCli(["data", absolute, "--json"], env)).stdout).keys, 1);

    const cleared = await runCli(["data", absolute, "--clear", "--yes"], env);
    assert.equal(cleared.status, 0, cleared.stdout);
    assert.match(cleared.stdout, /status: cleared/);
    assert.equal(JSON.parse((await runCli(["data", absolute, "--json"], env)).stdout).keys, 0);
  });
});

test("lavish data refuses an unknown flag and a missing file argument", async () => {
  await withPage(async ({ absolute, env }) => {
    const unknown = await runCli(["data", absolute, "--wipe"], env);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stdout, /Unknown option: --wipe/);
    const missing = await runCli(["data"], env);
    assert.equal(missing.status, 2);
  });
});
