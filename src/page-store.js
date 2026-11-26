// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
// Page storage: the JSON a page keeps through `window.lavish.store`, one file per page under
// `<state-dir>/page-data/<session key>.json`. The session key is the hash of the artifact's canonical
// path, so data follows the page file, survives reloads and server restarts, and never enters
// `state.json`, which is rewritten on every store operation.
//
// The file holds `{ v, file, updated_at, entries }`. Entries are kept in a Map in memory, because a
// page may use `__proto__` or `constructor` as a key, and written back with Object.fromEntries.
// Every operation runs under one mutex, so a read-modify-write never loses a concurrent write.
// Files and the folder are owner-only: what a page stores is the reviewer's own data.

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { AsyncMutex } from "./async-mutex.js";
import { pageAppLimits, pageStoreKeyError, utf8ByteLength } from "./page-apps.js";

const KEY_RE = /^[0-9a-f]{16}$/;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
let temporaryFileId = 0;

export function pageDataDir(stateDir) {
  return path.join(stateDir, "page-data");
}

export function pageDataFile(stateDir, key) {
  if (!KEY_RE.test(String(key || ""))) throw pageStoreError("SESSION_INVALID", "invalid page key", 400);
  return path.join(pageDataDir(stateDir), `${key}.json`);
}

/**
 * An error the routes answer with its status and code.
 * @returns {Error & { statusCode: number, code: string }}
 */
export function pageStoreError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

function entryBytes(key, json) {
  return utf8ByteLength(key) + utf8ByteLength(json);
}

/**
 * @param {string} stateDir
 * @param {{ limits?: Record<string, number>, log?: (line: string) => void }} [options]
 */
export function createPageStore(stateDir, { limits = pageAppLimits(), log = () => {} } = {}) {
  const lock = new AsyncMutex();

  /** @returns {Promise<{ file: string, updatedAt: string, entries: Map<string, { value: unknown, bytes: number }>, bytes: number }>} */
  async function load(key) {
    const file = pageDataFile(stateDir, key);
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { file: "", updatedAt: "", entries: new Map(), bytes: 0 };
      throw error;
    }
    const entries = new Map();
    let bytes = 0;
    try {
      const parsed = JSON.parse(raw);
      const stored = parsed && typeof parsed.entries === "object" && parsed.entries ? parsed.entries : {};
      for (const [name, value] of Object.entries(stored)) {
        const size = entryBytes(name, JSON.stringify(value));
        entries.set(name, { value, bytes: size });
        bytes += size;
      }
      return {
        file: typeof parsed?.file === "string" ? parsed.file : "",
        updatedAt: typeof parsed?.updated_at === "string" ? parsed.updated_at : "",
        entries,
        bytes,
      };
    } catch {
      // An unreadable file must not lock the page out of its own storage. Keep the bytes aside
      // for a person to look at, and start the page over empty.
      await rename(file, `${file}.corrupt`).catch(() => {});
      log(`[lavish] page data for ${key} was unreadable and was moved to ${path.basename(file)}.corrupt`);
      return { file: "", updatedAt: "", entries: new Map(), bytes: 0 };
    }
  }

  async function save(key, artifactFile, entries) {
    const file = pageDataFile(stateDir, key);
    if (entries.size === 0) {
      await rm(file, { force: true });
      return "";
    }
    const dir = pageDataDir(stateDir);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE).catch(() => {});
    const updatedAt = new Date().toISOString();
    const body = JSON.stringify({
      v: 1,
      file: artifactFile,
      updated_at: updatedAt,
      entries: Object.fromEntries([...entries].map(([name, entry]) => [name, entry.value])),
    });
    const temporary = `${file}.${process.pid}.${++temporaryFileId}.tmp`;
    try {
      await writeFile(temporary, body, { mode: FILE_MODE });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return updatedAt;
  }

  function checkKey(name) {
    const error = pageStoreKeyError(name, limits);
    if (error) throw pageStoreError("KEY_INVALID", error);
  }

  return {
    limits,

    /** @returns {Promise<{ found: boolean, value?: unknown }>} */
    async get(key, name) {
      checkKey(name);
      return lock.runExclusive(async () => {
        const { entries } = await load(key);
        const entry = entries.get(name);
        return entry ? { found: true, value: entry.value } : { found: false };
      });
    },

    /**
     * Store `value` (already parsed JSON) under `name` for the page at `artifactFile`.
     * @returns {Promise<{ keys: number, bytes: number }>}
     */
    async set(key, artifactFile, name, value) {
      checkKey(name);
      if (value === undefined) throw pageStoreError("VALUE_INVALID", "A stored value cannot be undefined.");
      const json = JSON.stringify(value);
      if (typeof json !== "string") throw pageStoreError("VALUE_INVALID", "The value is not JSON.");
      if (utf8ByteLength(json) > limits.storeValueMaxBytes) {
        throw pageStoreError(
          "VALUE_TOO_LARGE",
          `One stored value is limited to ${Math.floor(limits.storeValueMaxBytes / 1024)} KB of JSON.`,
          413,
        );
      }
      return lock.runExclusive(async () => {
        const { entries, bytes } = await load(key);
        const previous = entries.get(name);
        const size = entryBytes(name, json);
        const total = bytes - (previous ? previous.bytes : 0) + size;
        if (!previous && entries.size >= limits.storeMaxKeys) {
          throw pageStoreError("STORE_FULL", `A page can store up to ${limits.storeMaxKeys} keys.`, 507);
        }
        if (total > limits.storePageMaxBytes) {
          throw pageStoreError(
            "STORE_FULL",
            `A page can store up to ${Math.floor(limits.storePageMaxBytes / (1024 * 1024))} MB. Delete keys it no longer needs.`,
            507,
          );
        }
        entries.set(name, { value: JSON.parse(json), bytes: size });
        await save(key, artifactFile, entries);
        return { keys: entries.size, bytes: total };
      });
    },

    /** @returns {Promise<{ deleted: boolean }>} */
    async delete(key, artifactFile, name) {
      checkKey(name);
      return lock.runExclusive(async () => {
        const { entries } = await load(key);
        if (!entries.delete(name)) return { deleted: false };
        await save(key, artifactFile, entries);
        return { deleted: true };
      });
    },

    /** @returns {Promise<{ keys: string[] }>} */
    async list(key, prefix = "") {
      const text = String(prefix);
      if (text.length > limits.storeKeyMaxChars) {
        throw pageStoreError("KEY_INVALID", `A list prefix is limited to ${limits.storeKeyMaxChars} characters.`);
      }
      return lock.runExclusive(async () => {
        const { entries } = await load(key);
        return { keys: [...entries.keys()].filter((name) => name.startsWith(text)).sort() };
      });
    },

    /** Everything a page stored, for `lavish data`. */
    async read(key) {
      pageDataFile(stateDir, key);
      return lock.runExclusive(async () => {
        const { file, updatedAt, entries, bytes } = await load(key);
        return {
          file,
          updated_at: updatedAt,
          keys: entries.size,
          bytes,
          entries: Object.fromEntries(
            [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, entry]) => [name, entry.value]),
          ),
        };
      });
    },

    /** Delete everything a page stored. */
    async clear(key) {
      pageDataFile(stateDir, key);
      return lock.runExclusive(async () => {
        const { entries, bytes } = await load(key);
        await rm(pageDataFile(stateDir, key), { force: true });
        return { keys: entries.size, bytes };
      });
    },
  };
}
