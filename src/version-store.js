// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
//
// Page versions: every saved change of a page's HTML, kept in the state directory.
//
//   <state dir>/versions/<session key>/index.json         the list, oldest first
//   <state dir>/versions/<session key>/<sha256>.html.gz   one gzip object per distinct content
//
// A version is identified by its number in that page's list, which only grows. Content is stored
// once per distinct sha256, so a page saved back to an earlier state costs no new bytes. The
// directory is keyed by the session key (a hash of the canonical path), so one page's versions
// are never read through another page's key. The list keeps at most `maxVersions` entries and
// `maxPageBytes` of stored objects; the oldest entries go first, and the newest one always stays.
// Assets next to the page are not versioned.
//
// The server and the CLI both write here. Within one process a per-page lock orders writes;
// across processes, index.json is replaced atomically (write, then rename), and the newest
// entry's hash decides whether a save is new, so two processes recording the same content agree.
import crypto from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";

import { summarizeVersionChange } from "./version-diff.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const VERSION_INDEX_FORMAT = 1;
const MIB = 1024 * 1024;
export const DEFAULT_VERSION_LIMITS = Object.freeze({
  maxVersions: 50,
  maxPageBytes: 25 * MIB,
  maxVersionBytes: 10 * MIB,
});
const VERSION_SOURCES = new Set(["open", "save", "restore", "cli"]);

// LAVISH_AXI_VERSIONS=0 (or off) stops recording; listing and restoring what is stored still work.
// LAVISH_AXI_VERSIONS_MAX sets how many versions a page keeps, LAVISH_AXI_VERSIONS_MAX_MB how many
// stored megabytes. Both floor to whole numbers and need at least 1; anything else keeps the default.
export function resolveVersionLimits(env = process.env) {
  const switchValue = String(env.LAVISH_AXI_VERSIONS ?? "")
    .trim()
    .toLowerCase();
  const enabled = !(switchValue === "0" || switchValue === "off");
  return {
    enabled,
    maxVersions: positiveWhole(env.LAVISH_AXI_VERSIONS_MAX, DEFAULT_VERSION_LIMITS.maxVersions, 10_000),
    maxPageBytes:
      positiveWhole(env.LAVISH_AXI_VERSIONS_MAX_MB, DEFAULT_VERSION_LIMITS.maxPageBytes / MIB, 100_000) * MIB,
    maxVersionBytes: DEFAULT_VERSION_LIMITS.maxVersionBytes,
  };
}

function positiveWhole(raw, fallback, max) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) && value >= 1 ? Math.min(value, max) : fallback;
}

export function versionsRoot(stateDirectory) {
  return path.join(stateDirectory, "versions");
}

export function isValidVersionKey(key) {
  return typeof key === "string" && /^[0-9a-f]{16}$/.test(key);
}

export function parseVersionId(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]{0,8}$/.test(text)) return null;
  return Number(text);
}

function isValidHash(hash) {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
}

export function contentHash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Which entries survive the caps. Pure: `stored` maps a hash to its object's size on disk. The
// newest entry always stays, even alone over the byte cap, because it is the page as it is now.
export function planVersionPrune(versions, stored, { maxVersions, maxPageBytes }) {
  const kept = Array.isArray(versions) ? versions.slice() : [];
  const uniqueBytes = (list) => {
    const seen = new Set();
    let total = 0;
    for (const version of list) {
      if (seen.has(version.hash)) continue;
      seen.add(version.hash);
      total += Number(stored.get(version.hash)) || 0;
    }
    return total;
  };
  while (kept.length > 1 && (kept.length > maxVersions || uniqueBytes(kept) > maxPageBytes)) kept.shift();
  const live = new Set(kept.map((version) => version.hash));
  const dropHashes = [
    ...new Set((Array.isArray(versions) ? versions : []).map((v) => v.hash).filter((h) => !live.has(h))),
  ];
  return { kept, dropHashes };
}

function normalizeIndex(raw) {
  const versions = [];
  const seenIds = new Set();
  for (const entry of Array.isArray(raw?.versions) ? raw.versions : []) {
    if (!entry || typeof entry !== "object") continue;
    const id = Number(entry.id);
    if (!Number.isSafeInteger(id) || id < 1 || seenIds.has(id) || !isValidHash(entry.hash)) continue;
    seenIds.add(id);
    versions.push({
      id,
      hash: entry.hash,
      at: typeof entry.at === "string" ? entry.at : "",
      bytes: Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 ? entry.bytes : 0,
      stored: Number.isSafeInteger(entry.stored) && entry.stored >= 0 ? entry.stored : 0,
      source: VERSION_SOURCES.has(entry.source) ? entry.source : "save",
      ...(Number.isSafeInteger(entry.restored_from) ? { restored_from: entry.restored_from } : {}),
      summary: entry.summary && typeof entry.summary === "object" ? entry.summary : {},
    });
  }
  versions.sort((a, b) => a.id - b.id);
  const lastId = versions.length ? versions[versions.length - 1].id : 0;
  const nextId = Number.isSafeInteger(raw?.next_id) && raw.next_id > lastId ? raw.next_id : lastId + 1;
  return { format: VERSION_INDEX_FORMAT, next_id: nextId, versions };
}

export class VersionStore {
  /**
   * @param {string} root the `versions` folder in the state directory
   * @param {{ enabled?: boolean, maxVersions?: number, maxPageBytes?: number, maxVersionBytes?: number }} [limits]
   */
  constructor(root, limits = {}) {
    this.root = root;
    this.limits = { ...DEFAULT_VERSION_LIMITS, enabled: true, ...limits };
    /** @type {Map<string, Promise<unknown>>} */
    this.locks = new Map();
  }

  get enabled() {
    return this.limits.enabled !== false;
  }

  dirFor(key) {
    if (!isValidVersionKey(key)) throw new Error("invalid page key");
    return path.join(this.root, key);
  }

  /**
   * Runs `operation` after every earlier one for the same page has finished.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  withLock(key, operation) {
    const previous = this.locks.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(operation);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  async readIndex(key) {
    try {
      return normalizeIndex(JSON.parse(await readFile(path.join(this.dirFor(key), "index.json"), "utf8")));
    } catch (error) {
      if (error && (error.code === "ENOENT" || error instanceof SyntaxError)) return normalizeIndex(null);
      throw error;
    }
  }

  async #writeIndex(key, index) {
    const dir = this.dirFor(key);
    const temp = path.join(dir, `index.json.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path.join(dir, "index.json"));
  }

  // Creates `versions/` and the page's folder, never the state directory above them: a save that
  // lands after that directory was removed (a test cleaning up, a reset) must not bring it back.
  async #ensureDir(key) {
    const dir = this.dirFor(key);
    for (const folder of [this.root, dir]) {
      try {
        await mkdir(folder, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    await chmod(dir, 0o700).catch(() => {});
    return dir;
  }

  /** Oldest first. */
  async list(key) {
    return (await this.readIndex(key)).versions;
  }

  async get(key, id) {
    return (await this.list(key)).find((version) => version.id === id) || null;
  }

  async #readObject(key, hash) {
    if (!isValidHash(hash)) throw new Error("invalid version hash");
    const compressed = await readFile(path.join(this.dirFor(key), `${hash}.html.gz`));
    const bytes = await gunzipAsync(compressed);
    if (contentHash(bytes) !== hash) throw Object.assign(new Error("version data is damaged"), { code: "EDAMAGED" });
    return bytes;
  }

  /** The exact bytes of one version, or null when the page has no such version. */
  async read(key, id) {
    const version = await this.get(key, id);
    if (!version) return null;
    return { version, bytes: await this.#readObject(key, version.hash) };
  }

  /**
   * Adds `bytes` as the page's newest version unless the newest already has the same content.
   * @param {string} key
   * @param {Buffer} bytes
   * @param {{ source?: string, restoredFrom?: number, now?: Date }} [options]
   * @returns {Promise<{ recorded: boolean, reason?: string, version: any, hash: string, count: number }>}
   */
  record(key, bytes, options = {}) {
    return this.withLock(key, () => this.recordUnlocked(key, bytes, options));
  }

  /**
   * The body of `record`, for a caller already holding this page's lock through `withLock`.
   * @param {string} key
   * @param {Buffer} bytes
   * @param {{ source?: string, restoredFrom?: number, now?: Date }} [options]
   */
  async recordUnlocked(key, bytes, { source = "save", restoredFrom, now = new Date() } = {}) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ""), "utf8");
    const hash = contentHash(buffer);
    const index = await this.readIndex(key);
    const newest = index.versions[index.versions.length - 1] || null;
    if (!this.enabled)
      return { recorded: false, reason: "disabled", version: newest, hash, count: index.versions.length };
    if (newest && newest.hash === hash) {
      return { recorded: false, reason: "unchanged", version: newest, hash, count: index.versions.length };
    }
    if (buffer.length > this.limits.maxVersionBytes) {
      return { recorded: false, reason: "too-large", version: newest, hash, count: index.versions.length };
    }
    const dir = await this.#ensureDir(key);
    let previousText = null;
    if (newest) {
      try {
        previousText = (await this.#readObject(key, newest.hash)).toString("utf8");
      } catch {
        // A damaged or missing previous object only costs this version its comparison.
        previousText = null;
      }
    }
    const objectFile = path.join(dir, `${hash}.html.gz`);
    let storedBytes;
    try {
      storedBytes = (await stat(objectFile)).size;
    } catch {
      const compressed = await gzipAsync(buffer, { level: 6 });
      const temp = `${objectFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, compressed, { mode: 0o600 });
      await rename(temp, objectFile);
      storedBytes = compressed.length;
    }
    const summary = summarizeVersionChange(newest ? previousText : null, buffer.toString("utf8"));
    if (newest && previousText === null) summary.kind = "unknown";
    const version = {
      id: index.next_id,
      hash,
      at: now.toISOString(),
      bytes: buffer.length,
      stored: storedBytes,
      source: VERSION_SOURCES.has(source) ? source : "save",
      ...(Number.isSafeInteger(restoredFrom) ? { restored_from: restoredFrom } : {}),
      summary: { ...summary, delta: newest ? buffer.length - newest.bytes : buffer.length },
    };
    const stored = new Map(index.versions.map((entry) => [entry.hash, entry.stored]));
    stored.set(hash, storedBytes);
    const { kept } = planVersionPrune([...index.versions, version], stored, this.limits);
    await this.#writeIndex(key, { format: VERSION_INDEX_FORMAT, next_id: version.id + 1, versions: kept });
    await this.#removeUnreferenced(key, kept);
    return { recorded: true, version, hash, count: kept.length };
  }

  // Deletes the objects no kept entry names, and temp files left by an interrupted write. A temp
  // file younger than a minute may belong to another process that is about to rename it.
  async #removeUnreferenced(key, kept) {
    const dir = this.dirFor(key);
    const live = new Set(kept.map((version) => version.hash));
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    await Promise.all(
      names.map(async (name) => {
        const file = path.join(dir, name);
        const object = /^([0-9a-f]{64})\.html\.gz$/.exec(name);
        if (object) {
          if (!live.has(object[1])) await rm(file, { force: true }).catch(() => {});
          return;
        }
        if (!name.endsWith(".tmp")) return;
        const info = await stat(file).catch(() => null);
        if (info && Date.now() - info.mtimeMs >= 60_000) await rm(file, { force: true }).catch(() => {});
      }),
    );
  }
}
