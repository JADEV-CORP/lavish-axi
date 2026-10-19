import assert from "node:assert/strict";
import test from "node:test";

import { findTextMatches, findTextNodeIndex, isFindHotkeyEvent } from "../src/find-in-page.js";

test("matches ignore case, treat any whitespace alike, and take the query literally", () => {
  const text = "Parking bookings\nEvery Booking has a plate.  A booking (or two) costs $5.";
  assert.deepEqual(
    findTextMatches(text, "booking").map(([start, end]) => text.slice(start, end)),
    ["booking", "Booking", "booking"],
  );
  assert.deepEqual(
    findTextMatches(text, "plate. a").map(([start, end]) => text.slice(start, end)),
    ["plate.  A"],
    "one space in the query matches the page's two",
  );
  assert.deepEqual(
    findTextMatches(text, "(or two) costs $5").map(([start, end]) => text.slice(start, end)),
    ["(or two) costs $5"],
    "regular-expression characters are plain text",
  );
  assert.deepEqual(findTextMatches(text, "   "), []);
  assert.deepEqual(findTextMatches(text, "zebra"), []);
});

test("a search stops at its limit and handles text outside ASCII", () => {
  assert.equal(findTextMatches("a".repeat(50), "a", 10).length, 10);
  const text = "Réservation RÉSERVATION";
  assert.equal(findTextMatches(text, "réservation").length, 2);
});

test("an offset in the joined text maps back to its text node", () => {
  const starts = [0, 5, 5, 12];
  assert.equal(findTextNodeIndex(starts, 0), 0);
  assert.equal(findTextNodeIndex(starts, 4), 0);
  assert.equal(findTextNodeIndex(starts, 5), 2, "an empty node is skipped for the one after it");
  assert.equal(findTextNodeIndex(starts, 11), 2);
  assert.equal(findTextNodeIndex(starts, 40), 3);
});

test("Ctrl+F and Cmd+F open find; with Shift or Alt they do not", () => {
  assert.equal(isFindHotkeyEvent({ key: "f", ctrlKey: true }), true);
  assert.equal(isFindHotkeyEvent({ key: "F", metaKey: true }), true);
  assert.equal(isFindHotkeyEvent({ key: "f", ctrlKey: true, shiftKey: true }), false);
  assert.equal(isFindHotkeyEvent({ key: "f", ctrlKey: true, altKey: true }), false);
  assert.equal(isFindHotkeyEvent({ key: "f" }), false);
  assert.equal(isFindHotkeyEvent(null), false);
});
