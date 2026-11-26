import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ACCEPTED_FILE_TYPES,
  detectFileType,
  isImageAttachmentId,
  resolveAttachment,
  statAttachmentForServe,
  writeAttachment,
} from "../src/attachment-store.js";

const KEY = "0123456789abcdef";
const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8BQz0BkYGAAADAAA/8W1p0AAAAASUVORK5CYII=",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

async function withDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-attach-files-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("detectFileType takes images and PDF by their bytes and text by UTF-8, named by its extension", () => {
  assert.deepEqual(detectFileType(PNG_2x1, "x.csv"), { mime: "image/png", ext: "png" });
  assert.deepEqual(detectFileType(PDF, "brief.txt"), { mime: "application/pdf", ext: "pdf" });
  assert.deepEqual(detectFileType(Buffer.from("a,b\n1,2\n"), "Q3.CSV"), { mime: "text/csv", ext: "csv" });
  assert.deepEqual(detectFileType(Buffer.from("# Notes é"), "notes.md"), { mime: "text/markdown", ext: "md" });
  assert.deepEqual(detectFileType(Buffer.from('{"a":1}'), "data.json"), { mime: "application/json", ext: "json" });
  // Text under any other name is stored as .txt; the agent still gets the original name.
  assert.deepEqual(detectFileType(Buffer.from("echo hi"), "run.sh"), { mime: "text/plain", ext: "txt" });
  assert.equal(detectFileType(Buffer.from([0x4d, 0x5a, 0x00, 0x01]), "tool.exe"), null);
  assert.equal(detectFileType(Buffer.from([0xc3, 0x28]), "bad.txt"), null);
  assert.equal(detectFileType(Buffer.alloc(0), "empty.txt"), null);
});

test("every accepted file type has a matching detector result", () => {
  const exts = new Set(ACCEPTED_FILE_TYPES.map((type) => type.ext));
  for (const ext of ["png", "jpg", "webp", "pdf", "txt", "csv", "md", "json"]) assert.ok(exts.has(ext), ext);
});

test("a picked PDF is stored as a file, resolved with its path, and never served back", async () => {
  await withDir(async (dir) => {
    const meta = await writeAttachment(dir, KEY, PDF, { kind: "file", nameHint: "brief.pdf" });
    assert.match(meta.id, /^[0-9a-f]{64}\.pdf$/);
    assert.equal(meta.type, "file");
    assert.equal(meta.mime, "application/pdf");
    assert.equal(meta.width, 0);
    const resolved = await resolveAttachment(dir, KEY, meta.id);
    assert.equal(resolved?.type, "file");
    assert.equal(resolved?.path, meta.path);
    assert.equal(isImageAttachmentId(meta.id), false);
    assert.equal(await statAttachmentForServe(dir, KEY, meta.id), null);
  });
});

test("an image upload still refuses documents", async () => {
  await withDir(async (dir) => {
    await assert.rejects(writeAttachment(dir, KEY, PDF, {}), { statusCode: 415, message: /unsupported image type/ });
    await assert.rejects(writeAttachment(dir, KEY, Buffer.from([0, 1, 2]), { kind: "file" }), {
      statusCode: 415,
      message: /unsupported file type/,
    });
  });
});
