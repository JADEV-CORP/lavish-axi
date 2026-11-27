// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { AxiError } from "axi-sdk-js";

import { shareCommand } from "../src/cli.js";
import { policyFile, writePolicy } from "../src/policy.js";
import { serve } from "../src/server.js";
import { defaultUpdateChecker } from "../src/update-check.js";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const PAGE = "<!doctype html><html><head><title>Plan</title></head><body><h1>Plan</h1></body></html>\n";

async function lavish(args, stateDir, env = {}, { fails = false, code = 1 } = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        LAVISH_AXI_STATE_DIR: stateDir,
        LAVISH_AXI_NO_OPEN: "1",
        LAVISH_AXI_UPDATE_CHECK: "0",
        ...env,
      },
    });
    assert.equal(fails, false, `expected ${args.join(" ")} to fail`);
    return stdout;
  } catch (error) {
    if (!fails || typeof error?.stdout !== "string") throw error;
    assert.equal(error.code, code, `expected exit code ${code}`);
    return error.stdout;
  }
}

async function workspace(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-cli-policy-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  const file = path.join(dir, "plan.html");
  await writeFile(file, PAGE);
  return { dir, stateDir, file };
}

// A stand-in for ht-ml.app that only counts what reaches it.
async function startCountingHost(t) {
  const hits = { count: 0 };
  const host = createServer((req, res) => {
    hits.count += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: "https://x.ht-ml.app/", site_id: "x", update_key: "k", status: "active" }));
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => new Promise((resolve) => host.close(() => resolve(undefined))));
  return { hits, url: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (host.address()).port}` };
}

// Runs the body with the process pointed at a temp state dir and fake host, then puts both back.
async function withEnv(values, body) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("lavish policy --share off --update-check off writes both switches and prints them", async (t) => {
  const { stateDir } = await workspace(t);
  const out = await lavish(["policy", "--share", "off", "--update-check", "off"], stateDir);
  assert.match(out, /share: off/);
  assert.match(out, /update_check: off/);
  assert.deepEqual(JSON.parse(await readFile(policyFile(stateDir), "utf8")), { share: false, updateCheck: false });

  const shown = JSON.parse(await lavish(["policy", "--json"], stateDir));
  assert.equal(shown.share, "off");
  assert.equal(shown.update_check, "off");
  assert.equal(shown.source, "file");

  await lavish(["policy", "--share", "on"], stateDir);
  assert.match(await lavish(["policy"], stateDir), /share: on\nupdate_check: off/);
});

test("lavish policy rejects a value that is not on or off", async (t) => {
  const { stateDir } = await workspace(t);
  const out = await lavish(["policy", "--share", "maybe"], stateDir, {}, { fails: true, code: 2 });
  assert.match(out, /--share takes on or off/);
});

test("with sharing off, lavish share exits 1 with SHARE_DISABLED and sends nothing", async (t) => {
  const { stateDir, file } = await workspace(t);
  const host = await startCountingHost(t);
  await lavish(["policy", "--share", "off"], stateDir);

  const out = await lavish(["share", file], stateDir, { LAVISH_AXI_HTML_APP_API_URL: host.url }, { fails: true });
  assert.match(out, /SHARE_DISABLED/);
  assert.match(out, /Sharing is turned off for this user \(lavish policy\)\./);
  assert.equal(host.hits.count, 0, "nothing may reach the host");
});

test("shareCommand refuses before it builds or uploads, and works again once sharing is on", async (t) => {
  const { stateDir, file } = await workspace(t);
  const host = await startCountingHost(t);
  await withEnv({ LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_HTML_APP_API_URL: host.url }, async () => {
    await writePolicy(stateDir, { share: false });
    for (const args of [
      [file],
      [file, "--site", "abc123", "--update-key", "k"],
      ["--unpublish", "--site", "abc123", "--update-key", "k"],
    ]) {
      await assert.rejects(
        () => shareCommand(args),
        (error) => error instanceof AxiError && error.code === "SHARE_DISABLED",
      );
    }
    assert.equal(host.hits.count, 0);

    await writePolicy(stateDir, { share: true });
    await shareCommand([file]);
    assert.equal(host.hits.count, 1, "the positive control proves the counter works");
  });
});

test("an unreadable policy file refuses sharing too", async (t) => {
  const { stateDir, file } = await workspace(t);
  const host = await startCountingHost(t);
  await writePolicy(stateDir, { share: true });
  await writeFile(policyFile(stateDir), "{share:");
  const out = await lavish(["share", file], stateDir, { LAVISH_AXI_HTML_APP_API_URL: host.url }, { fails: true });
  assert.match(out, /SHARE_DISABLED/);
  assert.equal(host.hits.count, 0);
});

test("the update checker is null when the policy turns it off, with no environment variable set", async (t) => {
  const { stateDir } = await workspace(t);
  const checker = defaultUpdateChecker({ currentVersion: "1.0.0", env: {}, stateDir });
  assert.equal(typeof checker?.start, "function");
  checker.stop();

  await writePolicy(stateDir, { updateCheck: false });
  assert.equal(defaultUpdateChecker({ currentVersion: "1.0.0", env: {}, stateDir }), null);

  // Sharing off alone leaves the update check on.
  await writePolicy(stateDir, { updateCheck: true, share: false });
  const stillOn = defaultUpdateChecker({ currentVersion: "1.0.0", env: {}, stateDir });
  assert.equal(typeof stillOn?.start, "function");
  stillOn.stop();
});

test("an unreadable policy is reported without handing out a way to switch it on", async (t) => {
  const { stateDir } = await workspace(t);
  await mkdir(stateDir, { recursive: true });
  await writeFile(policyFile(stateDir), "{share:");
  const out = await lavish(["policy"], stateDir);
  assert.match(out, /source: invalid/);
  assert.match(out, /could not be read, so both switches are treated as off\. Ask the user to fix or reset it/);
  assert.doesNotMatch(out, /--share on/);
});

test("lavish policy rejects positional arguments", async (t) => {
  const { stateDir } = await workspace(t);
  const out = await lavish(["policy", "share", "off"], stateDir, {}, { fails: true, code: 2 });
  assert.match(out, /Unexpected argument: share/);
  assert.match(out, /lavish policy \[--share on\|off\]/);
});

test("a policy file with a UTF-8 BOM is read through lavish policy", async (t) => {
  const { stateDir } = await workspace(t);
  await mkdir(stateDir, { recursive: true });
  await writeFile(policyFile(stateDir), '\uFEFF{"share": false, "updateCheck": true}');
  assert.match(await lavish(["policy"], stateDir), /share: off\nupdate_check: on\nsource: file/);
});

test("the review window cannot share when sharing is off, and the chrome drops the entry", async (t) => {
  const { stateDir, file } = await workspace(t);
  const host = await startCountingHost(t);
  await mkdir(stateDir, { recursive: true });
  const server = await withEnv({ LAVISH_AXI_HTML_APP_API_URL: host.url }, () =>
    serve({
      port: 0,
      host: "127.0.0.1",
      hosts: ["127.0.0.1"],
      stateFile: path.join(stateDir, "state.json"),
      idleTimeoutMs: null,
    }),
  );
  t.after(() => server.close?.());
  const base = `http://127.0.0.1:${server.port}`;
  const opened = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  const { key } = await opened.json();
  assert.ok(key, "the page opens a session");
  const share = () =>
    withEnv({ LAVISH_AXI_HTML_APP_API_URL: host.url }, () =>
      fetch(`${base}/api/${key}/share`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: "{}",
      }),
    );
  const chrome = async () => (await fetch(`${base}/session/${key}`)).text();

  // Allowed: the menu item is there. The policy is read per request, so no restart is needed below.
  assert.match(await chrome(), /id="shareArtifact"/);

  await writePolicy(stateDir, { share: false });
  const refused = await share();
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, "SHARE_DISABLED");
  assert.equal(host.hits.count, 0, "nothing may reach the host");
  const html = await chrome();
  assert.doesNotMatch(html, /id="shareArtifact"/);
  assert.doesNotMatch(html, /Publish link/);

  await writePolicy(stateDir, { share: true });
  assert.match(await chrome(), /id="shareArtifact"/);
  // Positive control: with sharing on the same request reaches the host, so the counter works.
  assert.equal((await share()).status, 200);
  assert.equal(host.hits.count, 1);
});

test("the chrome script tolerates a missing publish item and leaves it out of the palette", async () => {
  const source = await readFile(new URL("../src/chrome-client.js", import.meta.url), "utf8");
  assert.match(source, /if \(shareArtifactButton\) shareArtifactButton\.onclick/);
  assert.match(source, /label: "Publish link", control: shareArtifactButton, when: Boolean\(shareArtifactButton\)/);
});
