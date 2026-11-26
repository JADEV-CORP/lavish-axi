// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
// TOON for the context data an artifact attaches to a prompt (#3834): the official encoder's default
// output (2-space indent, comma delimiter, no key folding) in functions only, because the artifact
// SDK inlines this module with serializeModuleHelpers. test/toon-encode.test.js compares every case
// with @toon-format/toon.

/** Plain JSON data from any value, the way the official encoder normalizes it. */
export function toonNormalize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && typeof value.toJSON === "function") {
    const next = value.toJSON();
    if (next !== value) return toonNormalize(next);
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Object.is(value, -0) ? 0 : Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toonNormalize);
  if (value instanceof Set) return Array.from(value).map(toonNormalize);
  if (value instanceof Map) return Object.fromEntries(Array.from(value, ([k, v]) => [String(k), toonNormalize(v)]));
  if (typeof value === "object") {
    // A plain object from any realm: its prototype is null or a root Object.prototype.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return null;
    /** @type {Record<string, unknown>} */
    const normalized = {};
    for (const key of Object.keys(value)) normalized[key] = toonNormalize(value[key]);
    return normalized;
  }
  return null;
}

export function toonIsPrimitive(value) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function toonIsObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toonEscape(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

export function toonString(value) {
  const safe =
    value !== "" &&
    value === value.trim() &&
    value !== "true" &&
    value !== "false" &&
    value !== "null" &&
    !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value) &&
    !/^0\d+$/.test(value) &&
    !/[:"\\[\]{}\n\r\t,]/.test(value) &&
    !value.startsWith("-");
  return safe ? value : '"' + toonEscape(value) + '"';
}

export function toonPrimitive(value) {
  if (value === null) return "null";
  if (typeof value === "string") return toonString(value);
  return String(value);
}

export function toonKey(key) {
  return /^[A-Z_][\w.]*$/i.test(key) ? key : '"' + toonEscape(key) + '"';
}

/** `key[N]{fields}:`, with key and fields optional. */
export function toonHeader(length, key, fields) {
  return (
    (key === undefined ? "" : toonKey(key)) +
    "[" +
    length +
    "]" +
    (fields ? "{" + fields.map(toonKey).join(",") + "}" : "") +
    ":"
  );
}

export function toonInline(values, key) {
  const header = toonHeader(values.length, key);
  return values.length === 0 ? header : header + " " + values.map(toonPrimitive).join(",");
}

/** The field list when every row is a flat object with the first row's keys, else undefined. */
export function toonTabularFields(rows) {
  if (rows.length === 0 || !rows.every(toonIsObject)) return undefined;
  const fields = Object.keys(rows[0]);
  if (fields.length === 0) return undefined;
  for (const row of rows) {
    if (Object.keys(row).length !== fields.length) return undefined;
    for (const field of fields) if (!(field in row) || !toonIsPrimitive(row[field])) return undefined;
  }
  return fields;
}

export function toonLine(lines, depth, content) {
  lines.push("  ".repeat(depth) + content);
}

export function toonObjectLines(lines, value, depth) {
  for (const [key, item] of Object.entries(value)) {
    if (toonIsPrimitive(item)) toonLine(lines, depth, toonKey(key) + ": " + toonPrimitive(item));
    else if (Array.isArray(item)) toonArrayLines(lines, key, item, depth);
    else {
      toonLine(lines, depth, toonKey(key) + ":");
      toonObjectLines(lines, item, depth + 1);
    }
  }
}

export function toonArrayLines(lines, key, items, depth) {
  if (items.every(toonIsPrimitive)) {
    toonLine(lines, depth, toonInline(items, key));
    return;
  }
  const fields = toonTabularFields(items);
  toonLine(lines, depth, toonHeader(items.length, key, fields));
  if (fields) {
    for (const row of items) toonLine(lines, depth + 1, fields.map((field) => toonPrimitive(row[field])).join(","));
    return;
  }
  for (const item of items) toonListItemLines(lines, item, depth + 1);
}

export function toonListItemLines(lines, item, depth) {
  if (toonIsPrimitive(item)) {
    toonLine(lines, depth, "- " + toonPrimitive(item));
    return;
  }
  if (Array.isArray(item)) {
    if (item.every(toonIsPrimitive)) {
      toonLine(lines, depth, "- " + toonInline(item));
      return;
    }
    toonLine(lines, depth, "- " + toonHeader(item.length));
    for (const nested of item) toonListItemLines(lines, nested, depth + 1);
    return;
  }
  const entries = Object.entries(item);
  if (entries.length === 0) {
    toonLine(lines, depth, "-");
    return;
  }
  const [[firstKey, firstValue], ...rest] = entries;
  const fields = Array.isArray(firstValue) ? toonTabularFields(firstValue) : undefined;
  if (fields) {
    toonLine(lines, depth, "- " + toonHeader(firstValue.length, firstKey, fields));
    for (const row of firstValue)
      toonLine(lines, depth + 2, fields.map((field) => toonPrimitive(row[field])).join(","));
  } else if (toonIsPrimitive(firstValue)) {
    toonLine(lines, depth, "- " + toonKey(firstKey) + ": " + toonPrimitive(firstValue));
  } else if (Array.isArray(firstValue)) {
    if (firstValue.every(toonIsPrimitive)) toonLine(lines, depth, "- " + toonKey(firstKey) + toonInline(firstValue));
    else {
      toonLine(lines, depth, "- " + toonKey(firstKey) + toonHeader(firstValue.length));
      for (const nested of firstValue) toonListItemLines(lines, nested, depth + 2);
    }
  } else {
    toonLine(lines, depth, "- " + toonKey(firstKey) + ":");
    toonObjectLines(lines, firstValue, depth + 2);
  }
  toonObjectLines(lines, Object.fromEntries(rest), depth + 1);
}

/** Encodes any value as TOON. */
export function encodeToon(value) {
  const normalized = toonNormalize(value);
  /** @type {string[]} */
  const lines = [];
  if (toonIsPrimitive(normalized)) return toonPrimitive(normalized);
  if (Array.isArray(normalized)) toonArrayLines(lines, undefined, normalized, 0);
  else toonObjectLines(lines, normalized, 0);
  return lines.join("\n");
}
