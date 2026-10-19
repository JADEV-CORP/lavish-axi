// Find in the page (#3789): the pure parts of the artifact SDK's Ctrl+F search. createSdkJs
// serializes every export here into the SDK bundle, so this module exports functions only, and
// each one stands alone (no imports, no module-level constants).

// Ctrl+F, or Cmd+F on macOS, with no other modifier.
export function isFindHotkeyEvent(event) {
  if (!event || event.altKey || event.shiftKey) return false;
  return Boolean(event.ctrlKey || event.metaKey) && String(event.key || "").toLowerCase() === "f";
}

// Where `query` occurs in `text`, ignoring case, as [start, end) offsets into `text`. Any run of
// whitespace in the query matches any run in the page, the way rendered text collapses it. At most
// `limit` matches, so a one-letter search on a long page stays quick.
export function findTextMatches(text, query, limit = 1000) {
  const words = String(query || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return [];
  const pattern = new RegExp(words.join("\\s+"), "giu");
  const matches = [];
  for (const match of String(text).matchAll(pattern)) {
    if (!match[0]) continue;
    matches.push([match.index, match.index + match[0].length]);
    if (matches.length >= limit) break;
  }
  return matches;
}

// The text node an offset in the joined page text falls in: `starts` holds each node's first offset,
// in order. Returns the node's index, by binary search.
export function findTextNodeIndex(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}
