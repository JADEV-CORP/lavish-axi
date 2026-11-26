// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDiffRows,
  decodeHtmlEntities,
  diffSequences,
  diffWords,
  formatByteDelta,
  formatBytes,
  htmlSourceLines,
  htmlToTextLines,
  summarizeVersionChange,
  versionDiffLimits,
  versionSummaryText,
} from "../src/version-diff.js";

function lcsLength(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table[0][0];
}

// A small deterministic generator, so a failure reproduces.
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

test("diffSequences finds a shortest edit script that rebuilds both sides", () => {
  const random = seeded(7);
  for (let round = 0; round < 800; round += 1) {
    const make = () => Array.from({ length: Math.floor(random() * 12) }, () => "abcd"[Math.floor(random() * 4)]);
    const a = make();
    const b = make();
    const { ops, exact } = diffSequences(a, b);
    assert.equal(exact, true);
    assert.deepEqual(
      ops.filter((op) => op.op !== "delete").map((op) => (op.op === "insert" ? b[op.b] : a[op.a])),
      b,
      "keeping equal lines and inserts rebuilds b",
    );
    assert.deepEqual(
      ops.filter((op) => op.op !== "insert").map((op) => a[op.a]),
      a,
      "keeping equal lines and deletes rebuilds a",
    );
    assert.equal(ops.filter((op) => op.op === "equal").length, lcsLength(a, b), `minimal for ${a} -> ${b}`);
  }
});

test("diffSequences reports a rewrite instead of searching past its edit budget", () => {
  const a = Array.from({ length: 300 }, (_, index) => `a${index}`);
  const b = Array.from({ length: 300 }, (_, index) => `b${index}`);
  const { ops, exact } = diffSequences(a, b, { maxEdits: 50 });
  assert.equal(exact, false);
  assert.equal(ops.filter((op) => op.op === "delete").length, 300);
  assert.equal(ops.filter((op) => op.op === "insert").length, 300);
});

test("diffSequences keeps long unchanged runs cheap", () => {
  const before = Array.from({ length: 20_000 }, (_, index) => `line ${index}`);
  const after = before.slice();
  after.splice(10_000, 1, "changed");
  const started = Date.now();
  const { ops } = diffSequences(before, after);
  assert.ok(Date.now() - started < 1000);
  assert.equal(ops.filter((op) => op.op !== "equal").length, 2);
});

test("htmlToTextLines reads the text a page shows, one block per line", () => {
  const html = `<!doctype html><html><head><title>Ignored title</title><style>p { color: red }</style>
  <script>const fake = "<p>not text</p>";</script></head><body>
  <h1>Pricing &amp; plans</h1><p>Pro costs <b>12</b>&nbsp;EUR, a &lt; b</p>
  <!-- <p>hidden comment</p> -->
  <ul><li>One</li><li>Two</li></ul>
  <img alt="x > y" src="a.png"><p data-note='quote > inside'>After the image</p>
  <template><p>Template text</p></template>
  </body></html>`;
  assert.deepEqual(htmlToTextLines(html), [
    "Pricing & plans",
    "Pro costs 12 EUR, a < b",
    "One",
    "Two",
    "After the image",
  ]);
});

test("htmlToTextLines stays linear on hostile input", () => {
  const started = Date.now();
  htmlToTextLines("<".repeat(500_000) + "<script>" + "x".repeat(500_000));
  htmlToTextLines('<div title="'.repeat(100_000));
  assert.ok(Date.now() - started < 1500);
});

test("decodeHtmlEntities handles numeric and named entities and leaves unknown ones", () => {
  assert.equal(decodeHtmlEntities("&#65;&#x42;&hellip;&unknown;&amp;"), "AB…&unknown;&");
});

test("htmlSourceLines splits the source and caps the line count", () => {
  assert.deepEqual(htmlSourceLines("a\r\nb\nc"), ["a", "b", "c"]);
  const many = "x\n".repeat(versionDiffLimits().lines + 50);
  assert.equal(htmlSourceLines(many).length, versionDiffLimits().lines);
});

test("diffWords marks the words that changed inside a line", () => {
  assert.deepEqual(diffWords("Price is 10 EUR", "Price is 12 EUR today"), [
    ["=", "Price is "],
    ["-", "10"],
    ["+", "12"],
    ["=", " EUR"],
    ["+", " today"],
  ]);
});

test("buildDiffRows pairs changed lines, folds unchanged runs and counts the change", () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index}`);
  const after = before.slice();
  after[10] = "line ten";
  after.splice(25, 0, "new line");
  after.splice(2, 1);
  const { rows, stats, identical } = buildDiffRows(before, after, { context: 1 });
  assert.equal(identical, false);
  assert.deepEqual(stats, { added: 1, removed: 1, changed: 1 });
  const kinds = rows.map((row) => row.t);
  assert.ok(kinds.includes("skip"));
  const mod = rows.find((row) => row.t === "mod");
  assert.equal(mod.a, 11);
  assert.deepEqual(mod.parts, [
    ["=", "line "],
    ["-", "10"],
    ["+", "ten"],
  ]);
  const added = rows.find((row) => row.t === "add");
  assert.equal(added.text, "new line");
  assert.equal(rows.find((row) => row.t === "del").text, "line 2");
});

test("buildDiffRows reports identical input and bounds its output", () => {
  assert.deepEqual(buildDiffRows(["a", "b"], ["a", "b"]).identical, true);
  const before = Array.from({ length: 400 }, (_, index) => `x${index}`);
  const after = Array.from({ length: 400 }, (_, index) => (index % 2 ? `y${index}` : `x${index}`));
  const result = buildDiffRows(before, after, { maxRows: 50 });
  assert.equal(result.rows.length, 50);
  assert.equal(result.truncated, true);
});

test("summarizeVersionChange says what the text did", () => {
  const first = summarizeVersionChange(null, "<h1>Plan</h1><p>Step one</p>");
  assert.equal(first.kind, "first");
  assert.equal(first.excerpt, "Plan");
  assert.equal(versionSummaryText({ summary: first, source: "open" }), 'First version: "Plan"');

  const changed = summarizeVersionChange(
    "<p>Price is 10 EUR</p><p>Keep</p>",
    "<p>Price is 12 EUR</p><p>Keep</p><p>New</p>",
  );
  assert.equal(changed.kind, "text");
  assert.deepEqual([changed.changed, changed.added, changed.removed], [1, 1, 0]);
  assert.equal(changed.excerpt, "Price is 12 EUR");
  assert.equal(versionSummaryText({ summary: changed }), '1 line changed, 1 added: "Price is 12 EUR"');

  const removed = summarizeVersionChange("<p>Keep</p><p>Old row</p>", "<p>Keep</p>");
  assert.equal(versionSummaryText({ summary: removed }), '1 line removed: removed "Old row"');

  const markup = summarizeVersionChange('<p class="a">Same</p>', '<p class="b">Same</p>');
  assert.equal(markup.kind, "markup");
  assert.equal(versionSummaryText({ summary: markup }), "Markup only, same text");

  assert.equal(versionSummaryText({ source: "restore", restored_from: 3, summary: markup }), "Restored version 3");
});

test("summarizeVersionChange keeps excerpts short", () => {
  const long = "word ".repeat(100);
  const summary = summarizeVersionChange("<p>a</p>", `<p>a</p><p>${long}</p>`);
  assert.ok(summary.excerpt.length <= versionDiffLimits().excerpt);
  assert.ok(summary.excerpt.endsWith("…"));
});

test("formatBytes and formatByteDelta read like a person writes them", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(20 * 1024), "20 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(formatByteDelta(0), "same size");
  assert.equal(formatByteDelta(2048), "+2.0 KB");
  assert.equal(formatByteDelta(-300), "-300 B");
});
