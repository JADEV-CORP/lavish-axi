// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { policyFile, readPolicy, writePolicy } from "../src/policy.js";

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("no file means both allowed", async (t) => {
  assert.deepEqual(readPolicy(await tempDir(t)), { share: true, updateCheck: true, source: "default" });
});

test('off, false, "off", "false" and 0 all turn a switch off', async (t) => {
  const dir = await tempDir(t);
  for (const raw of ["false", '"off"', '"false"', "0", '"OFF"']) {
    await writeFile(policyFile(dir), `{"share": ${raw}, "updateCheck": ${raw}}`);
    assert.deepEqual(readPolicy(dir), { share: false, updateCheck: false, source: "file" }, raw);
  }
});

test("a switch missing from the file stays allowed", async (t) => {
  const dir = await tempDir(t);
  await writeFile(policyFile(dir), '{"share": false}');
  assert.deepEqual(readPolicy(dir), { share: false, updateCheck: true, source: "file" });
});

test("broken JSON fails closed", async (t) => {
  const dir = await tempDir(t);
  await writeFile(policyFile(dir), "{share:");
  assert.deepEqual(readPolicy(dir), { share: false, updateCheck: false, source: "invalid" });
});

test("a value that is not a switch fails closed", async (t) => {
  const dir = await tempDir(t);
  for (const body of ['{"share": "maybe"}', "[]", "null", '{"updateCheck": {}}']) {
    await writeFile(policyFile(dir), body);
    assert.deepEqual(readPolicy(dir), { share: false, updateCheck: false, source: "invalid" }, body);
  }
});

test("an unreadable policy path fails closed", async (t) => {
  const dir = await tempDir(t);
  // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
  await writePolicy(dir, { share: true });
  await rm(policyFile(dir));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(policyFile(dir));
  assert.equal(readPolicy(dir).source, "invalid");
});

test("writePolicy merges and writes mode 0600 atomically", async (t) => {
  const dir = await tempDir(t);
  await writePolicy(dir, { share: false });
  await writePolicy(dir, { updateCheck: false });
  assert.deepEqual(readPolicy(dir), { share: false, updateCheck: false, source: "file" });
  if (process.platform !== "win32") {
    assert.equal((await stat(policyFile(dir))).mode & 0o777, 0o600);
  }
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(dir), ["policy.json"]);
});
