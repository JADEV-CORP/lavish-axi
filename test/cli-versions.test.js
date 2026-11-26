// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createHomeOutput,
  createVersionsOutput,
  getCommandHelp,
  normalizeArgv,
  shouldOpenGalleryFromHome,
} from "../src/cli.js";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

// Errors exit non-zero with their message on stdout, like every AXI command.
async function lavish(args, stateDir, { fails = false } = {}) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [BIN, ...args], {
      env: { ...process.env, LAVISH_AXI_STATE_DIR: stateDir, LAVISH_AXI_NO_OPEN: "1", LAVISH_AXI_UPDATE_CHECK: "0" },
    });
    assert.equal(fails, false, `expected ${args.join(" ")} to fail`);
    return stdout;
  } catch (error) {
    if (!fails || typeof error?.stdout !== "string") throw error;
    return error.stdout;
  }
}

test("lavish versions lists, shows and restores without a running server", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-cli-versions-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  const file = path.join(dir, "plan.html");
  const v1 = "<!doctype html><title>Plan</title><p>Price is 10 EUR</p>\n";
  const v2 = "<!doctype html><title>Plan</title><p>Price is 12 EUR</p>\n";

  await writeFile(file, v1);
  const first = await lavish(["versions", file], stateDir);
  assert.match(first, /versions\[1\]/);
  assert.match(first, /First version/);

  await writeFile(file, v2);
  const second = await lavish(["versions", file], stateDir);
  assert.match(second, /versions\[2\]/);
  assert.match(second, /1 line changed/);
  assert.match(second, /--restore <n>/);

  assert.equal(await lavish(["versions", file, "--show", "1"], stateDir), v1, "--show prints the exact bytes");
  const out = path.join(dir, "v1.html");
  await lavish(["versions", file, "--show", "1", "--out", out], stateDir);
  assert.equal(await readFile(out, "utf8"), v1);

  const restored = await lavish(["versions", file, "--restore", "1"], stateDir);
  assert.match(restored, /restored:/);
  assert.match(restored, /from: 1/);
  assert.equal(await readFile(file, "utf8"), v1);
  const after = await lavish(["versions", file], stateDir);
  assert.match(after, /versions\[3\]/);
  assert.match(after, /Restored version 1/);

  const missing = await lavish(["versions", file, "--show", "9"], stateDir, { fails: true });
  assert.match(missing, /no version 9/);
  const both = await lavish(["versions", file, "--show", "1", "--restore", "1"], stateDir, { fails: true });
  assert.match(both, /not both/);
});

test("createVersionsOutput marks only the newest copy of the current content", () => {
  const versions = [
    { id: 1, hash: "a", at: "2026-11-26T10:00:00.000Z", bytes: 100, summary: { kind: "first", delta: 100 } },
    { id: 2, hash: "b", at: "2026-11-26T11:00:00.000Z", bytes: 120, summary: { kind: "text", delta: 20, added: 1 } },
    { id: 3, hash: "a", at: "2026-11-26T12:00:00.000Z", bytes: 100, source: "restore", restored_from: 1, summary: {} },
  ];
  const output = createVersionsOutput({ file: "/tmp/plan.html", versions, currentHash: "a" });
  assert.deepEqual(
    output.versions.map((row) => [row.n, row.current]),
    [
      [3, true],
      [2, false],
      [1, false],
    ],
  );
  assert.equal(output.versions[0].summary, "Restored version 1");
  assert.equal(output.versions[1].change, "+20 B");
  assert.equal("note" in output, false);
  assert.match(createVersionsOutput({ file: "x.html", versions: [], enabled: false }).note, /LAVISH_AXI_VERSIONS=0/);
});

test("the gallery opens for a person at a terminal, never for an agent", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };
  assert.equal(shouldOpenGalleryFromHome({ env: {}, stdout: tty, stdin: tty }), true);
  assert.equal(shouldOpenGalleryFromHome({ env: {}, stdout: pipe, stdin: tty }), false);
  assert.equal(shouldOpenGalleryFromHome({ env: {}, stdout: tty, stdin: pipe }), false);
  assert.equal(shouldOpenGalleryFromHome({ env: { CLAUDECODE: "1" }, stdout: tty, stdin: tty }), false);
  assert.equal(shouldOpenGalleryFromHome({ env: { CODEX_THREAD_ID: "x" }, stdout: tty, stdin: tty }), false);
  assert.equal(shouldOpenGalleryFromHome({ env: { T3CODE_THREAD_ID: "x" }, stdout: tty, stdin: tty }), false);
  assert.equal(shouldOpenGalleryFromHome({ env: { CI: "1" }, stdout: tty, stdin: tty }), false);
  assert.equal(shouldOpenGalleryFromHome({ env: { LAVISH_AXI_NO_OPEN: "1" }, stdout: tty, stdin: tty }), false);
});

test("versions and gallery are commands, not page names", () => {
  assert.deepEqual(normalizeArgv(["versions", "plan.html"]), ["versions", "plan.html"]);
  assert.deepEqual(normalizeArgv(["gallery"]), ["gallery"]);
  assert.match(getCommandHelp("versions"), /--restore <n>/);
  assert.match(getCommandHelp("versions"), /beside it are not/);
  assert.match(getCommandHelp("gallery"), /every page this machine opened/);
});

test("home output tells agents about versions and keeps the gallery for the user", () => {
  const home = createHomeOutput({ bin: "lavish", sessions: [] });
  assert.ok(home.help.some((line) => line.includes("`lavish versions <html-file>`")));
  assert.ok(home.help.some((line) => line.includes("`lavish gallery`") && line.includes("unless they ask")));
  assert.equal("gallery" in home, false);
});
