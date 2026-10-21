// Copyright (c) 2026 JADEV-CORP. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { encodeToon } from "../src/toon-encode.js";

// The official encoder, as the AXI SDK that prints Lavish's own CLI output resolves it.
const sdkDir = realpathSync(fileURLToPath(new URL("../node_modules/axi-sdk-js", import.meta.url)));
const { encode } = await import(
  pathToFileURL(path.join(sdkDir, "..", "@toon-format", "toon", "dist", "index.mjs")).href
);

const cases = {
  "a choice": { question: "D20", answer: "Build routes per parking now, before the PR", note: "" },
  "strings that need quotes": {
    empty: "",
    padded: " x ",
    literal: "true",
    nil: "null",
    number: "42",
    float: "-3.5e2",
    octal: "007",
    colon: "a: b",
    comma: "a,b",
    quote: 'say "hi"',
    backslash: "C:\\work",
    newline: "one\ntwo",
    tab: "a\tb",
    bracket: "[x]",
    brace: "{x}",
    dash: "-start",
    unicode: "café ✓",
  },
  "odd keys": { "": 1, "with space": 2, "a.b": 3, "9lives": 4, _ok: 5, 'quo"te': 6 },
  "numbers and literals": {
    zero: -0,
    nan: Number.NaN,
    inf: Infinity,
    big: 12n,
    flag: false,
    none: null,
    gone: undefined,
  },
  "nested objects": { a: { b: { c: 1 }, empty: {} }, d: [] },
  "primitive arrays": { tags: ["x", "y z", "", "1"], counts: [1, 2, 3], mixed: [1, "a", true, null] },
  "tabular rows": {
    rows: [
      { id: 1, name: "A" },
      { id: 2, name: "B,C" },
    ],
  },
  "rows that are not tabular": {
    differentKeys: [{ id: 1 }, { name: "x" }],
    nestedValue: [{ id: 1, tags: ["a"] }],
    emptyObjects: [{}, {}],
  },
  "list items": {
    items: [
      1,
      "two",
      [1, 2],
      [[1], [2, [3]]],
      { only: "one" },
      { first: [{ a: 1 }, { a: 2 }], then: "x" },
      { first: [1, 2], then: { deep: true } },
      { first: [], then: 1 },
      { first: [{ a: 1 }, "b"], then: 2 },
      { first: { inner: 1 }, then: 2 },
      { first: {}, then: 3 },
      {},
    ],
  },
  "arrays of arrays": { grid: [[1, 2], [3]], deeper: [[{ a: 1 }]] },
  "dates and collections": {
    when: new Date("2026-10-21T00:00:00Z"),
    set: new Set(["a", "b"]),
    map: new Map([["k", 1]]),
    custom: new (class Thing {})(),
  },
};

for (const [name, value] of Object.entries(cases)) {
  test(`TOON matches the official encoder: ${name}`, () => {
    assert.equal(encodeToon(value), encode(value));
  });
}

test("TOON matches the official encoder at the root", () => {
  for (const value of ["text", "", 5, true, null, [], [1, 2], [{ a: 1 }], {}]) {
    assert.equal(encodeToon(value), encode(value), JSON.stringify(value));
  }
});
