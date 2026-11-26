import assert from "node:assert/strict";
import test from "node:test";

import {
  createPageApps,
  downloadMimeType,
  normalizeAcceptTokens,
  pageAppError,
  pageAppLimits,
  pageStoreKeyError,
  pageStoreValueJson,
  sanitizeDownloadName,
  utf8ByteLength,
} from "../src/page-apps.js";
import { encodeToon } from "../src/toon-encode.js";

const limits = pageAppLimits();
// The result unions are read field by field below.
const valueJson = (value) => /** @type {any} */ (pageStoreValueJson(value, limits));
const downloadName = (name) => /** @type {any} */ (sanitizeDownloadName(name, limits));

test("pageAppLimits keeps defaults and takes only positive overrides", () => {
  assert.equal(limits.storeValueMaxBytes, 1024 * 1024);
  assert.equal(limits.storePageMaxBytes, 5 * 1024 * 1024);
  const tuned = pageAppLimits({ pickMaxFiles: 7, storeKeyMaxChars: 0, askMaxTimeoutMs: Number.NaN, bogus: 3 });
  assert.equal(tuned.pickMaxFiles, 7);
  assert.equal(tuned.storeKeyMaxChars, 256);
  assert.equal(tuned.askMaxTimeoutMs, 30 * 60 * 1000);
  assert.equal("bogus" in tuned, false);
});

test("utf8ByteLength counts like Buffer.byteLength, surrogate pairs included", () => {
  for (const text of ["", "abc", "é", "€", "😀", "a😀b€é", "\ud800 lone", "end\ud800"]) {
    assert.equal(utf8ByteLength(text), Buffer.byteLength(text, "utf8"), JSON.stringify(text));
  }
});

test("pageStoreKeyError refuses empty, long, control, and non-string keys", () => {
  assert.equal(pageStoreKeyError("notes", limits), "");
  assert.equal(pageStoreKeyError("__proto__", limits), "");
  assert.match(pageStoreKeyError("", limits), /non-empty/);
  assert.match(pageStoreKeyError(3, limits), /non-empty string/);
  assert.match(pageStoreKeyError("x".repeat(257), limits), /256 characters/);
  assert.match(pageStoreKeyError("a\nb", limits), /control characters/);
});

test("pageStoreValueJson stores JSON and explains what it cannot store", () => {
  assert.deepEqual(valueJson({ a: [1, "é"] }), { json: '{"a":[1,"é"]}', bytes: 14 });
  assert.equal(valueJson(null).json, "null");
  assert.equal(valueJson(undefined).code, "VALUE_INVALID");
  assert.equal(valueJson(() => 1).code, "VALUE_INVALID");
  const circular = {};
  circular.self = circular;
  assert.equal(valueJson(circular).code, "VALUE_INVALID");
  assert.equal(valueJson(10n).code, "VALUE_INVALID");
  const big = valueJson("x".repeat(limits.storeValueMaxBytes));
  assert.equal(big.code, "VALUE_TOO_LARGE");
  assert.match(big.error, /1024 KB/);
});

test("sanitizeDownloadName keeps a saveable name and refuses an empty or long one", () => {
  assert.deepEqual(downloadName("report.csv"), { name: "report.csv" });
  assert.deepEqual(downloadName("../q3/report?.csv"), { name: "_q3_report_.csv" });
  assert.deepEqual(downloadName("  .hidden.txt.  "), { name: "hidden.txt" });
  assert.deepEqual(downloadName("a\u0000b"), { name: "ab" });
  assert.match(downloadName("...").error, /letter or digit/);
  assert.match(downloadName(42).error, /file name/);
  assert.match(downloadName("x".repeat(201)).error, /200 characters/);
});

test("downloadMimeType passes a plain type and falls back for anything else", () => {
  assert.equal(downloadMimeType("text/csv"), "text/csv");
  assert.equal(downloadMimeType("Text/Plain; charset=UTF-8"), "text/plain; charset=utf-8");
  assert.equal(downloadMimeType("text/html\r\nX: y"), "application/octet-stream");
  assert.equal(downloadMimeType(""), "application/octet-stream");
  assert.equal(downloadMimeType(undefined), "application/octet-stream");
});

test("normalizeAcceptTokens keeps MIME types, wildcards and extensions, bounded", () => {
  assert.deepEqual(normalizeAcceptTokens("image/*, .PDF,text/csv, bogus, ../x"), ["image/*", ".pdf", "text/csv"]);
  assert.deepEqual(normalizeAcceptTokens([".md", 3, "application/json"]), [".md", "application/json"]);
  assert.deepEqual(normalizeAcceptTokens(undefined), []);
  assert.equal(normalizeAcceptTokens(Array.from({ length: 40 }, () => ".txt")).length, 20);
});

test("pageAppError carries a stable code", () => {
  const error = pageAppError("NO_AGENT", "No agent");
  assert.equal(error.name, "LavishError");
  assert.equal(/** @type {any} */ (error).code, "NO_AGENT");
});

function harness() {
  const posted = [];
  const apps = createPageApps({
    post: (type, payload) => posted.push({ type, ...payload }),
    nonce: "doc-1",
    limits,
    encodeToon,
  });
  const answer = (request, result) =>
    apps.handleResult({ type: "lavish:pageAppResult", id: request.id, nonce: "doc-1", ...result });
  return { apps, posted, answer, api: apps.api };
}

test("store calls go to the chrome as one request each and resolve with the chrome's answer", async () => {
  const { api, posted, answer } = harness();
  const set = api.store.set("notes", { done: 2 });
  assert.equal(posted[0].type, "lavish:pageApp");
  assert.equal(posted[0].op, "store.set");
  assert.equal(posted[0].key, "notes");
  assert.equal(posted[0].json, '{"done":2}');
  assert.equal(posted[0].nonce, "doc-1");
  answer(posted[0], { ok: true, value: { keys: 1, bytes: 15 } });
  assert.equal(await set, undefined);

  const got = api.store.get("notes");
  answer(posted[1], { ok: true, value: { found: true, value: { done: 2 } } });
  assert.deepEqual(await got, { done: 2 });

  const missing = api.store.get("other");
  answer(posted[2], { ok: true, value: { found: false } });
  assert.equal(await missing, undefined);

  const removed = api.store.delete("notes");
  answer(posted[3], { ok: true, value: { deleted: true } });
  assert.equal(await removed, true);

  const listed = api.store.list("no");
  assert.equal(posted[4].prefix, "no");
  answer(posted[4], { ok: true, value: { keys: ["notes"] } });
  assert.deepEqual(await listed, ["notes"]);
});

test("store refuses a bad key or value before anything is posted", async () => {
  const { api, posted } = harness();
  await assert.rejects(api.store.set("", 1), { code: "KEY_INVALID" });
  await assert.rejects(api.store.set("k", undefined), { code: "VALUE_INVALID" });
  await assert.rejects(api.store.get("a\tb"), { code: "KEY_INVALID" });
  await assert.rejects(api.store.list(/** @type {any} */ (4)), { code: "KEY_INVALID" });
  assert.equal(posted.length, 0);
});

test("a chrome error reaches the page with its code", async () => {
  const { api, posted, answer } = harness();
  const set = api.store.set("k", "v");
  answer(posted[0], { ok: false, code: "STORE_FULL", error: "A page can store up to 5 MB." });
  await assert.rejects(set, { code: "STORE_FULL", message: "A page can store up to 5 MB." });
});

test("results for another document or an unknown id are ignored", async () => {
  const { apps, api, posted } = harness();
  const got = api.store.get("k");
  assert.equal(apps.handleResult({ type: "lavish:pageAppResult", id: posted[0].id, nonce: "doc-0", ok: true }), true);
  assert.equal(apps.handleResult({ type: "lavish:pageAppResult", id: "r99", nonce: "doc-1", ok: true }), true);
  assert.equal(apps.handleResult({ type: "lavish:somethingElse" }), false);
  apps.handleResult({
    type: "lavish:pageAppResult",
    id: posted[0].id,
    nonce: "doc-1",
    ok: true,
    value: { found: false },
  });
  assert.equal(await got, undefined);
});
