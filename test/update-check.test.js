import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PACKAGE_NAME,
  compareReleaseVersions,
  createUpdateChecker,
  defaultUpdateChecker,
  readLatestPublishedVersion,
} from "../src/update-check.js";

test("the checker and `lavish update` look up the same npm package", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(PACKAGE_NAME, packageJson.name);
  assert.equal(PACKAGE_NAME, "@jadev-corp/lavish");
});

test("versions order by semver precedence; anything that is not plain semver compares as unknown", () => {
  assert.equal(compareReleaseVersions("1.0.0", "0.1.98-jadev.2"), 1, "the npm package outranks the old fork line");
  assert.equal(compareReleaseVersions("1.0.0", "0.1.98-jadev.99"), 1);
  assert.equal(compareReleaseVersions("1.0.1", "1.0.0"), 1);
  assert.equal(compareReleaseVersions("1.0.10", "1.0.9"), 1, "numeric, not text");
  assert.equal(compareReleaseVersions("1.1.0-beta.1", "1.1.0"), -1, "a prerelease ranks below its release");
  assert.equal(compareReleaseVersions("0.1.90-jadev.9", "0.1.90-jadev.10"), -1);
  assert.equal(compareReleaseVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareReleaseVersions("v1.0.1", "1.0.0"), null);
  assert.equal(compareReleaseVersions("1.0.1+build.5", "1.0.0"), null);
  assert.equal(compareReleaseVersions("latest", "1.0.0"), null);
  assert.equal(compareReleaseVersions("1.0.0", ""), null);
});

test("the latest version comes from the npm registry for the scoped package, never from git or npm", async () => {
  /** @type {string[]} */
  const urls = [];
  const fetchImpl = async (/** @type {string} */ url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ name: PACKAGE_NAME, version: "1.0.1" }) };
  };
  assert.equal(await readLatestPublishedVersion({ fetchImpl }), "1.0.1");
  assert.deepEqual(urls, ["https://registry.npmjs.org/@jadev-corp%2flavish/latest"]);

  const notPublished = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.equal(await readLatestPublishedVersion({ fetchImpl: notPublished }), "", "not on npm yet reads as nothing");
  const offline = async () => {
    throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
  };
  assert.equal(await readLatestPublishedVersion({ fetchImpl: offline }), "", "offline skips the check");
  const garbage = async () => ({ ok: true, status: 200, json: async () => ({ version: "next" }) });
  assert.equal(await readLatestPublishedVersion({ fetchImpl: garbage }), "", "a non-semver answer reads as nothing");
});

test("the server's check never spawns npm or git", async () => {
  const source = await readFile(new URL("../src/update-check.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /child_process|execFile|spawn/);
  assert.match(source, /npmView: async \(\) => null/);
});

test("the checker reports a newer version once, clears it when caught up, and stops", async () => {
  const versions = ["1.0.1", "1.0.1", "", "1.0.0"];
  const seen = [];
  const checker = createUpdateChecker({
    currentVersion: "1.0.0",
    read: async () => versions.shift() ?? "1.0.0",
    firstCheckMs: 1,
    intervalMs: 5,
  });
  checker.start((update) => seen.push(update));
  // Wait for both reports rather than a fixed sleep: a loaded test run can delay the 5ms ticks.
  const deadline = Date.now() + 2000;
  while (seen.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  // A few more ticks, so a repeated report would show up before stopping.
  await new Promise((resolve) => setTimeout(resolve, 30));
  checker.stop();
  assert.deepEqual(seen, [{ version: "1.0.1", current: "1.0.0" }, null]);
  assert.equal(checker.current(), null);
});

test("an older or equal published version never claims an update", async () => {
  const seen = [];
  const checker = createUpdateChecker({
    currentVersion: "1.0.1",
    read: async () => "1.0.0",
    firstCheckMs: 1,
    intervalMs: 5,
  });
  checker.start((update) => seen.push(update));
  await new Promise((resolve) => setTimeout(resolve, 40));
  checker.stop();
  assert.deepEqual(seen, [], "nothing to report");
  assert.equal(checker.current(), null);
});

test("turning the check off on a running checker stops the next fetch", async () => {
  let on = true;
  let fetches = 0;
  let asked = 0;
  const seen = [];
  // Waits for a condition instead of a fixed time, so a slow runner only makes the test longer.
  const until = async (done) => {
    const deadline = Date.now() + 10_000;
    while (!done()) {
      assert.ok(Date.now() < deadline, "timed out waiting for the checker");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const checker = createUpdateChecker({
    currentVersion: "1.0.0",
    read: async () => {
      fetches += 1;
      return "1.1.0";
    },
    enabled: () => {
      asked += 1;
      return on;
    },
    firstCheckMs: 1,
    intervalMs: 5,
  });
  checker.start((update) => seen.push(update));
  await until(() => checker.current()?.version === "1.1.0");

  on = false;
  await until(() => seen.at(-1) === null);
  // Let three more checks run while it is off: each asks the policy first and must not fetch.
  const fetchesWhenOff = fetches;
  const askedWhenOff = asked;
  await until(() => asked >= askedWhenOff + 3);
  checker.stop();
  assert.equal(fetches, fetchesWhenOff, "no fetch once the policy is off");
  assert.equal(checker.current(), null, "a pending notice is dropped");
});

test("the server's checker can be turned off, and needs a semver version to compare", async (t) => {
  // An empty state directory, so a policy file on the machine running the tests cannot change the result.
  const stateDir = await mkdtemp(path.join(tmpdir(), "lavish-update-check-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const check = (currentVersion, env) => defaultUpdateChecker({ currentVersion, env, stateDir });
  assert.equal(check("1.0.0", { LAVISH_AXI_UPDATE_CHECK: "0" }), null);
  assert.equal(check("1.0.0", { LAVISH_AXI_UPDATE_CHECK: "off" }), null);
  assert.equal(check("nightly", {}), null);
  const checker = check("1.0.0", {});
  assert.equal(typeof checker?.start, "function");
  checker?.stop();
});
