import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareJadevVersions,
  createForkUpdateChecker,
  defaultForkUpdateChecker,
  readLatestForkVersion,
} from "../src/fork-update.js";

test("fork versions order by release, then by -jadev.N; anything unparseable never claims an update", () => {
  assert.equal(compareJadevVersions("0.1.83-jadev.13", "0.1.83-jadev.12"), 1);
  assert.equal(compareJadevVersions("0.1.83-jadev.9", "0.1.83-jadev.10"), -1, "numeric, not text");
  assert.equal(compareJadevVersions("0.1.84-jadev.1", "0.1.83-jadev.12"), 1);
  assert.equal(compareJadevVersions("0.1.83-jadev.1", "0.1.83"), 1, "the fork ranks above the upstream it is built on");
  assert.equal(compareJadevVersions("0.1.83-jadev.12", "0.1.83-jadev.12"), 0);
  assert.equal(compareJadevVersions("main", "0.1.83-jadev.12"), 0);
  assert.equal(compareJadevVersions("0.1.83-jadev.13", ""), 0);
});

test("the latest version comes from a blob-less fetch of main, with every credential prompt off", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "lavish-fork-update-"));
  /** @type {{ args: string[], env: NodeJS.ProcessEnv }[]} */
  const calls = [];
  const git = async (args, { env }) => {
    calls.push({ args, env });
    return args[0] === "cat-file" ? JSON.stringify({ name: "lavish-axi", version: "0.1.83-jadev.13" }) : "";
  };
  try {
    const version = await readLatestForkVersion({
      cacheDir: path.join(cacheDir, "update-check.git"),
      repository: "https://example.test/lavish-axi",
      env: {},
      git,
    });
    assert.equal(version, "0.1.83-jadev.13");
    assert.deepEqual(
      calls.map((call) => call.args[0]),
      ["init", "fetch", "cat-file"],
    );
    assert.deepEqual(calls[1].args.slice(1), [
      "--quiet",
      "--depth=1",
      "--filter=blob:none",
      "https://example.test/lavish-axi",
      "refs/heads/main",
    ]);
    assert.deepEqual(calls[2].args, ["cat-file", "-p", "FETCH_HEAD:package.json"]);

    const garbage = await readLatestForkVersion({
      cacheDir,
      env: {},
      git: async (args) => (args[0] === "cat-file" ? '{"version":"latest"}' : ""),
    });
    assert.equal(garbage, "", "a version that is not a fork version reads as nothing");
    const failing = await readLatestForkVersion({
      cacheDir,
      env: {},
      git: async () => {
        throw new Error("Authentication failed");
      },
    });
    assert.equal(failing, "", "a machine that cannot sign in skips the check");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("the real git call turns off the terminal and Git Credential Manager prompts", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/fork-update.js", import.meta.url), "utf8"),
  );
  assert.match(source, /GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never"/);
  assert.match(source, /windowsHide: true/);
});

test("the checker reports a newer version once, clears it when caught up, and stops", async () => {
  const versions = ["0.1.83-jadev.13", "0.1.83-jadev.13", "", "0.1.83-jadev.12"];
  const seen = [];
  const checker = createForkUpdateChecker({
    currentVersion: "0.1.83-jadev.12",
    read: async () => versions.shift() ?? "0.1.83-jadev.12",
    firstCheckMs: 1,
    intervalMs: 5,
  });
  checker.start((update) => seen.push(update));
  await new Promise((resolve) => setTimeout(resolve, 80));
  checker.stop();
  assert.deepEqual(seen, [{ version: "0.1.83-jadev.13", current: "0.1.83-jadev.12" }, null]);
  assert.equal(checker.current(), null);
});

test("the server's checker can be turned off, and only a fork build checks", () => {
  const stateDir = tmpdir();
  assert.equal(
    defaultForkUpdateChecker({ currentVersion: "0.1.83-jadev.12", stateDir, env: { LAVISH_AXI_UPDATE_CHECK: "0" } }),
    null,
  );
  assert.equal(defaultForkUpdateChecker({ currentVersion: "0.1.83", stateDir, env: {} }), null);
  const checker = defaultForkUpdateChecker({ currentVersion: "0.1.83-jadev.12", stateDir, env: {} });
  assert.equal(typeof checker?.start, "function");
  checker?.stop();
});
