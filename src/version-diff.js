// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
//
// Pure helpers behind page versions (src/version-store.js): the text a page shows, a line diff
// with word-level detail, the rows the Versions panel draws, and the one-line summary each saved
// version carries. Nothing here touches the disk or the network.
//
// The chrome (src/chrome-client.js and src/versions-client.js) is served as raw files and cannot
// import this module, so the server computes diff rows and summary strings and the browser only
// draws them, the same split the layout-warning inbox uses.

// Bounds, so one huge or hostile page cannot stall the server's event loop. Every walk below is
// linear in its input, and these cap the input.
export function versionDiffLimits() {
  return {
    // Characters of HTML read when extracting text. Bigger pages are compared on their start.
    textSourceChars: 2_000_000,
    // Lines compared on each side.
    lines: 20_000,
    // Edit distance the line diff searches before it reports the middle as rewritten.
    edits: 2_000,
    // Characters of one line shown in a diff row; comparison always uses the whole line.
    rowChars: 2_000,
    // Rows one diff response carries.
    rows: 1_500,
    // Lines longer than this are not split into words.
    wordLineChars: 2_000,
    // Characters of a summary excerpt.
    excerpt: 120,
  };
}

// Elements whose content a browser never shows as page text.
function isSkippedElement(name) {
  return (
    name === "script" ||
    name === "style" ||
    name === "template" ||
    name === "noscript" ||
    name === "title" ||
    name === "textarea"
  );
}

// Elements that start a new line of text. Inline elements (a, b, span, code) do not.
const BLOCK_ELEMENTS = new Set(
  (
    "address article aside blockquote br caption dd details dialog div dl dt fieldset figcaption figure footer " +
    "form h1 h2 h3 h4 h5 h6 header hr legend li main nav ol option p pre section summary table tbody td tfoot th " +
    "thead tr ul button label img svg"
  ).split(" "),
);

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  times: "×",
  rarr: "→",
  larr: "←",
  bull: "•",
  euro: "€",
};

export function decodeHtmlEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// The text a page shows, one line per block, read from its HTML without a DOM. One forward walk:
// comments, script-like elements and tags are skipped, block elements break lines. Text that a
// script builds at runtime is not in the HTML, so it is not here either; the HTML view of the
// diff covers that case.
export function htmlToTextLines(html) {
  const limits = versionDiffLimits();
  const source = String(html ?? "").slice(0, limits.textSourceChars);
  const lower = source.toLowerCase();
  const length = source.length;
  const chunks = [];
  let index = 0;
  while (index < length) {
    const open = source.indexOf("<", index);
    if (open === -1) {
      chunks.push(source.slice(index));
      break;
    }
    if (open > index) chunks.push(source.slice(index, open));
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      index = end === -1 ? length : end + 3;
      continue;
    }
    const next = source[open + 1] || "";
    if (next === "!" || next === "?") {
      const end = source.indexOf(">", open);
      index = end === -1 ? length : end + 1;
      continue;
    }
    const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(source.slice(open, open + 64));
    if (!nameMatch) {
      // A bare "<" in text, as in "a < b".
      chunks.push("<");
      index = open + 1;
      continue;
    }
    const name = nameMatch[1].toLowerCase();
    const closing = next === "/";
    // The tag ends at the first ">" outside a quoted attribute value.
    let cursor = open + nameMatch[0].length;
    let quote = "";
    while (cursor < length) {
      const char = source[cursor];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
      cursor += 1;
    }
    index = cursor >= length ? length : cursor + 1;
    if (!closing && isSkippedElement(name)) {
      const close = lower.indexOf(`</${name}`, index);
      if (close === -1) {
        index = length;
      } else {
        const end = source.indexOf(">", close);
        index = end === -1 ? length : end + 1;
      }
      chunks.push("\n");
      continue;
    }
    if (BLOCK_ELEMENTS.has(name)) chunks.push("\n");
  }
  const lines = [];
  for (const raw of decodeHtmlEntities(chunks.join("")).split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    lines.push(line);
    if (lines.length >= limits.lines) break;
  }
  return lines;
}

// The page's HTML as lines, for the source view of a diff.
export function htmlSourceLines(html) {
  const limits = versionDiffLimits();
  const lines = String(html ?? "").split(/\r?\n/);
  return lines.length > limits.lines ? lines.slice(0, limits.lines) : lines;
}

// The furthest point the diagonal `k` reaches with one more edit, read from the previous round.
// `previous(k)` returns -1 for a diagonal the previous round never reached. Shared by the forward
// search and the backtrack, so both make the same choice.
function nextMove(previous, k, n, m) {
  const down = previous(k + 1);
  const right = previous(k - 1);
  const downX = down >= 0 && down - k <= m ? down : -1;
  const rightX = right >= 0 && right + 1 <= n ? right + 1 : -1;
  if (downX < 0 && rightX < 0) return null;
  if (downX >= rightX) return { x: downX, fromK: k + 1 };
  return { x: rightX, fromK: k - 1 };
}

// Myers' O((N+M)D) shortest edit script for a[a0..a1) against b[b0..b1). Each round keeps a copy
// of the furthest points it started from, only over the diagonals it can reach, so memory grows
// with D squared and never with N times M. Returns null when the script needs more than
// `maxEdits` edits.
function myersMiddle(a, b, a0, a1, b0, b1, maxEdits) {
  const n = a1 - a0;
  const m = b1 - b0;
  const maxD = Math.min(n + m, maxEdits);
  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3).fill(-1);
  // The virtual start: diagonal 1 at x = 0, so the first round begins at (0, 0).
  v[offset + 1] = 0;
  /** @type {Int32Array[]} */
  const trace = [];
  for (let d = 0; d <= maxD; d += 1) {
    // Diagonals -d-1 .. d+1 as they stood before this round, at index k + d + 1.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    const live = (k) => (k < -maxD - 1 || k > maxD + 1 ? -1 : v[offset + k]);
    for (let k = -d; k <= d; k += 2) {
      if (k < -m || k > n) continue;
      const move = nextMove(live, k, n, m);
      if (!move) continue;
      let x = move.x;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x === n && y === m) return backtrack(trace, d, n, m, a0, b0);
    }
  }
  return null;
}

// Walks the rounds backwards from (n, m). In round d the path took one edit from the point it
// reached in round d - 1 (the snapshot names it) and then a diagonal run of equal lines.
function backtrack(trace, finalD, n, m, a0, b0) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = finalD; d >= 0; d -= 1) {
    const snapshot = trace[d];
    const previous = (k) => {
      const index = k + d + 1;
      return index < 0 || index >= snapshot.length ? -1 : snapshot[index];
    };
    const move = nextMove(previous, x - y, n, m);
    if (!move) break;
    const prevX = previous(move.fromK);
    const prevY = prevX - move.fromK;
    // The run of equal lines stops exactly at the point right after the edit.
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ op: "equal", a: a0 + x, b: b0 + y });
    }
    if (d > 0) {
      // A down move keeps x and adds b[prevY]; a right move drops a[prevX].
      if (x === prevX) ops.push({ op: "insert", a: -1, b: b0 + prevY });
      else ops.push({ op: "delete", a: a0 + prevX, b: -1 });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

// The shortest edit script turning `a` into `b`, compared with ===. Common lines at both ends are
// matched first, then Myers runs on what is left. When that would take more than `maxEdits`
// edits, the middle is reported as removed and added, and `exact` is false.
export function diffSequences(a, b, { maxEdits = versionDiffLimits().edits } = {}) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endA = left.length;
  let endB = right.length;
  while (endA > start && endB > start && left[endA - 1] === right[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops = [];
  for (let index = 0; index < start; index += 1) ops.push({ op: "equal", a: index, b: index });
  let exact = true;
  if (endA > start || endB > start) {
    const middle =
      endA === start || endB === start ? null : myersMiddle(left, right, start, endA, start, endB, maxEdits);
    if (middle) {
      ops.push(...middle);
    } else {
      exact = endA === start || endB === start;
      for (let index = start; index < endA; index += 1) ops.push({ op: "delete", a: index, b: -1 });
      for (let index = start; index < endB; index += 1) ops.push({ op: "insert", a: -1, b: index });
    }
  }
  for (let index = endA, other = endB; index < left.length; index += 1, other += 1) {
    ops.push({ op: "equal", a: index, b: other });
  }
  return { ops, exact };
}

// Words and the spaces between them, so a word diff can be joined back into the exact line.
export function splitWords(text) {
  return String(text || "").match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
}

// One changed line against its replacement, as runs of [op, text]: "=" kept, "-" removed, "+"
// added. Adjacent runs of the same op are merged.
export function diffWords(before, after) {
  const limits = versionDiffLimits();
  const a = String(before || "");
  const b = String(after || "");
  if (a.length > limits.wordLineChars || b.length > limits.wordLineChars) {
    return [
      ["-", a],
      ["+", b],
    ].filter(([, text]) => text);
  }
  const left = splitWords(a);
  const right = splitWords(b);
  const { ops } = diffSequences(left, right, { maxEdits: 400 });
  /** @type {[string, string][]} */
  const parts = [];
  for (const op of ops) {
    const kind = op.op === "equal" ? "=" : op.op === "delete" ? "-" : "+";
    const text = op.op === "insert" ? right[op.b] : left[op.a];
    const last = parts[parts.length - 1];
    if (last && last[0] === kind) last[1] += text;
    else parts.push([kind, text]);
  }
  return parts;
}

function clipRowText(text) {
  const limit = versionDiffLimits().rowChars;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// The rows the Versions panel draws for two lists of lines. A removed line followed by an added
// one becomes one "mod" row with word-level parts; unchanged runs longer than the context become
// one "skip" row. Line numbers are 1-based.
export function buildDiffRows(before, after, { context = 3, maxRows = versionDiffLimits().rows } = {}) {
  const left = Array.isArray(before) ? before : [];
  const right = Array.isArray(after) ? after : [];
  const { ops, exact } = diffSequences(left, right);
  /** @type {any[]} */
  const raw = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (let index = 0; index < ops.length; ) {
    const op = ops[index];
    if (op.op === "equal") {
      raw.push({ t: "same", a: op.a + 1, b: op.b + 1, text: clipRowText(left[op.a]) });
      index += 1;
      continue;
    }
    const deletes = [];
    const inserts = [];
    while (index < ops.length && ops[index].op !== "equal") {
      if (ops[index].op === "delete") deletes.push(ops[index].a);
      else inserts.push(ops[index].b);
      index += 1;
    }
    const paired = Math.min(deletes.length, inserts.length);
    for (let pair = 0; pair < paired; pair += 1) {
      changed += 1;
      raw.push({
        t: "mod",
        a: deletes[pair] + 1,
        b: inserts[pair] + 1,
        parts: diffWords(left[deletes[pair]], right[inserts[pair]]).map(([kind, text]) => [kind, clipRowText(text)]),
      });
    }
    for (const lineIndex of deletes.slice(paired)) {
      removed += 1;
      raw.push({ t: "del", a: lineIndex + 1, text: clipRowText(left[lineIndex]) });
    }
    for (const lineIndex of inserts.slice(paired)) {
      added += 1;
      raw.push({ t: "add", b: lineIndex + 1, text: clipRowText(right[lineIndex]) });
    }
  }
  const stats = { added, removed, changed };
  if (added + removed + changed === 0) return { rows: [], stats, identical: true, exact, truncated: false };
  // Keep `context` unchanged rows on each side of a change; fold the rest.
  const keep = new Array(raw.length).fill(false);
  raw.forEach((row, index) => {
    if (row.t === "same") return;
    for (let near = Math.max(0, index - context); near <= Math.min(raw.length - 1, index + context); near += 1) {
      keep[near] = true;
    }
  });
  const rows = [];
  let truncated = false;
  for (let index = 0; index < raw.length; ) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    if (keep[index]) {
      rows.push(raw[index]);
      index += 1;
      continue;
    }
    let count = 0;
    while (index < raw.length && !keep[index]) {
      count += 1;
      index += 1;
    }
    rows.push({ t: "skip", count });
  }
  return { rows, stats, identical: false, exact, truncated };
}

function clipExcerpt(text) {
  const limit = versionDiffLimits().excerpt;
  const flat = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

// What one saved version changed against the one before it, in the shape the index stores:
// `kind` is "first" (nothing before it), "text" (the page's text changed) or "markup" (only the
// HTML around the text). `excerpt` is the first text that changed, `excerpt_kind` says whether it
// was added or removed.
export function summarizeVersionChange(previousHtml, nextHtml) {
  const next = String(nextHtml ?? "");
  const nextBytes = Buffer.byteLength(next);
  if (previousHtml === null || previousHtml === undefined) {
    const lines = htmlToTextLines(next);
    return {
      kind: "first",
      delta: nextBytes,
      added: lines.length,
      removed: 0,
      changed: 0,
      excerpt: clipExcerpt(lines[0] || ""),
      excerpt_kind: lines.length ? "added" : "",
    };
  }
  const previous = String(previousHtml);
  const delta = nextBytes - Buffer.byteLength(previous);
  const before = htmlToTextLines(previous);
  const after = htmlToTextLines(next);
  const { rows, stats } = buildDiffRows(before, after, { context: 0, maxRows: 200 });
  let excerpt = "";
  let excerptKind = "";
  for (const row of rows) {
    if (row.t === "add") {
      excerpt = row.text;
      excerptKind = "added";
    } else if (row.t === "mod") {
      const addedText = row.parts
        .filter(([kind]) => kind === "+")
        .map(([, text]) => text)
        .join(" ");
      if (addedText.trim()) {
        // The new line itself reads better than its added words alone.
        excerpt = row.parts
          .filter(([kind]) => kind !== "-")
          .map(([, text]) => text)
          .join("");
        excerptKind = "added";
      } else {
        excerpt = row.parts
          .filter(([kind]) => kind === "-")
          .map(([, text]) => text)
          .join(" ");
        excerptKind = "removed";
      }
    } else if (row.t === "del") {
      excerpt = row.text;
      excerptKind = "removed";
    }
    if (excerpt.trim()) break;
  }
  return {
    kind: stats.added + stats.removed + stats.changed > 0 ? "text" : "markup",
    delta,
    added: stats.added,
    removed: stats.removed,
    changed: stats.changed,
    excerpt: clipExcerpt(excerpt),
    excerpt_kind: excerpt.trim() ? excerptKind : "",
  };
}

export function formatBytes(bytes) {
  const value = Math.abs(Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatByteDelta(delta) {
  const value = Number(delta) || 0;
  if (value === 0) return "same size";
  return `${value > 0 ? "+" : "-"}${formatBytes(value)}`;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function countPhrase(summary) {
  const changed = Number(summary.changed) || 0;
  const added = Number(summary.added) || 0;
  const removed = Number(summary.removed) || 0;
  const bits = [];
  if (changed) bits.push(plural(changed, "line changed", "lines changed"));
  if (added) bits.push(bits.length ? `${added} added` : plural(added, "line added", "lines added"));
  if (removed) bits.push(bits.length ? `${removed} removed` : plural(removed, "line removed", "lines removed"));
  return bits.join(", ");
}

// One line a person reads in the Versions panel and an agent reads in `lavish versions`.
export function versionSummaryText(version) {
  const summary = version && typeof version.summary === "object" && version.summary ? version.summary : {};
  if (version?.source === "restore" && Number.isInteger(version.restored_from)) {
    return `Restored version ${version.restored_from}`;
  }
  const quoted = summary.excerpt ? `"${summary.excerpt}"` : "";
  if (summary.kind === "first") return quoted ? `First version: ${quoted}` : "First version";
  if (summary.kind === "markup") return "Markup only, same text";
  if (summary.kind === "text") {
    const counts = countPhrase(summary);
    const excerpt = quoted && summary.excerpt_kind === "removed" ? `removed ${quoted}` : quoted;
    return [counts, excerpt].filter(Boolean).join(": ") || "Text changed";
  }
  return "Saved";
}
