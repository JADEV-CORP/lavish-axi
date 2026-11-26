// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
//
// The gallery: every page this machine opened in Lavish, for people. It reads the session store
// (state.json) and each page's own <title>, and keeps pins in the state directory. Paths leave the
// server only shortened (~ for the home folder), on the same host rules as every other route.
import crypto from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const GALLERY_PINS_FILE = "gallery-pins.json";
const MAX_PINS = 500;
// The <title> is read from the start of the file only; a page whose title sits further down shows
// its file name instead.
const HEAD_BYTES = 16 * 1024;
const TITLE_CACHE_MAX = 4_000;
const READ_CONCURRENCY = 32;

export function isValidGalleryKey(key) {
  return typeof key === "string" && /^[0-9a-f]{16}$/.test(key);
}

// "~/dev/app/.lavish/plan.html" for a file under the home folder, the path itself otherwise.
export function shortPath(file, home = homedir()) {
  const normalized = String(file || "").replaceAll("\\", "/");
  const normalizedHome = String(home || "").replaceAll("\\", "/");
  if (normalizedHome && normalized === normalizedHome) return "~";
  if (normalizedHome && normalized.startsWith(`${normalizedHome}/`)) {
    return `~/${normalized.slice(normalizedHome.length + 1)}`;
  }
  return normalized;
}

// The project a page belongs to: its folder, or the folder above when the page sits in a hidden
// working folder such as `.lavish/`.
export function projectLabel(file) {
  const folder = path.dirname(String(file || ""));
  const name = path.basename(folder);
  if (name.startsWith(".")) {
    const above = path.basename(path.dirname(folder));
    if (above && above !== path.sep && above !== ".") return above;
  }
  return name && name !== path.sep && name !== "." ? name : "";
}

// Where the page stands for the person reviewing it:
//   "ended"    the review was closed, by the reviewer or by the agent
//   "answered" the reviewer sent something the agent has not answered yet
//   "waiting"  the page waits for the reviewer
export function galleryStatus(session) {
  if (session?.status === "ended") return "ended";
  const pending = Array.isArray(session?.prompts) && session.prompts.length > 0;
  if (pending || session?.status === "feedback") return "answered";
  const chat = Array.isArray(session?.chat) ? session.chat : [];
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const role = chat[index]?.role;
    if (role === "agent") return "waiting";
    if (role === "user") return "answered";
  }
  return "waiting";
}

function isoOrEmpty(value) {
  const time = typeof value === "number" ? value : Date.parse(String(value || ""));
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : "";
}

/**
 * Pinned pages first, in pin order, then everything by last change, newest first.
 * @param {any[]} entries
 */
export function sortGalleryEntries(entries, pins = []) {
  const pinOrder = new Map(pins.map((key, index) => [key, index]));
  return entries.slice().sort((a, b) => {
    const pa = pinOrder.has(a.key) ? pinOrder.get(a.key) : Infinity;
    const pb = pinOrder.has(b.key) ? pinOrder.get(b.key) : Infinity;
    if (pa !== pb) return pa - pb;
    const ta = Date.parse(a.changed_at) || 0;
    const tb = Date.parse(b.changed_at) || 0;
    if (ta !== tb) return tb - ta;
    return String(a.path).localeCompare(String(b.path));
  });
}

async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Reads each page's <title> and last change, cached by modification time so a gallery of hundreds
 * of pages costs one stat per page after the first load.
 * @param {(html: string) => { title: string }} extractHead
 */
export function createPageHeadReader(extractHead) {
  /** @type {Map<string, { mtimeMs: number, size: number, title: string }>} */
  const cache = new Map();
  return async function readPageHead(file) {
    let info;
    try {
      info = await stat(file);
    } catch {
      cache.delete(file);
      return { missing: true, title: "", mtimeMs: 0 };
    }
    if (!info.isFile()) return { missing: true, title: "", mtimeMs: 0 };
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return { missing: false, title: cached.title, mtimeMs: info.mtimeMs };
    }
    let title;
    let handle;
    try {
      handle = await open(file, "r");
      const buffer = Buffer.alloc(Math.min(HEAD_BYTES, Math.max(0, info.size)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      title = extractHead(buffer.subarray(0, bytesRead).toString("utf8")).title || "";
    } catch {
      title = "";
    } finally {
      await handle?.close().catch(() => {});
    }
    if (cache.size >= TITLE_CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, title });
    return { missing: false, title, mtimeMs: info.mtimeMs };
  };
}

/**
 * The gallery's rows. Nothing here carries the full path: `path` is shortened with ~.
 * @param {any[]} sessions every session in state.json
 * @param {{ pins?: string[], listening?: Set<string>, readHead: (file: string) => Promise<{ missing: boolean, title: string, mtimeMs: number }>, home?: string }} options
 */
export async function buildGalleryEntries(sessions, { pins = [], listening = new Set(), readHead, home = homedir() }) {
  const pinned = new Set(pins);
  const valid = (Array.isArray(sessions) ? sessions : []).filter(
    (session) => session && isValidGalleryKey(session.key) && typeof session.file === "string" && session.file,
  );
  const entries = await mapWithLimit(valid, READ_CONCURRENCY, async (session) => {
    const head = await readHead(session.file);
    const fileName = path.basename(session.file);
    return {
      key: session.key,
      title: head.title || fileName,
      file_name: fileName,
      folder: projectLabel(session.file),
      path: shortPath(session.file, home),
      changed_at: head.missing ? isoOrEmpty(session.updated_at) : isoOrEmpty(head.mtimeMs),
      status: galleryStatus(session),
      ...(session.status === "ended" && session.ended_by ? { ended_by: String(session.ended_by) } : {}),
      listening: listening.has(session.key),
      pinned: pinned.has(session.key),
      missing: head.missing,
    };
  });
  return sortGalleryEntries(entries, pins);
}

// Pins live in the state directory beside state.json, as a list of session keys, newest first.
export class GalleryPins {
  constructor(stateDirectory) {
    this.file = path.join(stateDirectory, GALLERY_PINS_FILE);
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      const keys = Array.isArray(parsed?.pins) ? parsed.pins.filter(isValidGalleryKey) : [];
      return [...new Set(keys)].slice(0, MAX_PINS);
    } catch {
      return [];
    }
  }

  /** @returns {Promise<string[]>} */
  set(key, pinned) {
    const run = this.queue.then(async () => {
      if (!isValidGalleryKey(key)) throw new Error("invalid page key");
      const current = await this.read();
      const next = pinned ? [key, ...current.filter((item) => item !== key)] : current.filter((item) => item !== key);
      const bounded = next.slice(0, MAX_PINS);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, `${JSON.stringify({ format: 1, pins: bounded }, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.file);
      return bounded;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

function galleryIcon(paths, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// Lucide icons, the set the chrome uses.
export const GALLERY_ICONS = Object.freeze({
  search: galleryIcon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', 15),
  moon: galleryIcon(
    '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
  ),
  sun: galleryIcon(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  ),
  pin: galleryIcon(
    '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
    15,
  ),
  file: galleryIcon(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    15,
  ),
});

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The gallery page. The rows are drawn by /lavish-assets/gallery-client.js from the JSON below, so
 * the first paint needs no second request.
 * @param {{ entries: any[], themeBootstrapJs: string, faviconTag: string, logoSvg: string }} options
 */
export function createGalleryHtml({ entries, themeBootstrapJs, faviconTag, logoSvg }) {
  const data = jsonScript({ entries, generated_at: new Date().toISOString() });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Pages · Lavish</title>
${faviconTag}
<script>${themeBootstrapJs}</script>
<link rel="stylesheet" href="/chrome.css">
<link rel="stylesheet" href="/lavish-assets/gallery.css">
</head>
<body class="lavish gallery-page">
<header class="bar gallery-bar"><a class="brand gallery-brand" href="/" aria-label="Lavish pages"><span class="brand-logo" aria-hidden="true">${logoSvg}</span><span class="brand-mark">Lavish</span></a><span class="bar-rule" aria-hidden="true"></span><span class="gallery-bar-title">Pages</span><div class="spacer" aria-hidden="true"></div><button class="theme-toggle" id="galleryTheme" type="button" aria-label="Switch to dark theme" title="Switch to dark theme"><span class="gallery-theme-icon" data-icon="moon">${GALLERY_ICONS.moon}</span><span class="gallery-theme-icon" data-icon="sun">${GALLERY_ICONS.sun}</span></button></header>
<main class="gallery" id="gallery">
<div class="gallery-head"><h1 class="gallery-title">Pages</h1><p class="gallery-sub" id="gallerySummary">Every page opened in Lavish on this machine.</p></div>
<div class="gallery-tools"><label class="gallery-search">${GALLERY_ICONS.search}<input id="gallerySearch" type="search" placeholder="Search titles, folders and paths" autocomplete="off" spellcheck="false" aria-label="Search pages"><kbd class="gallery-kbd" aria-hidden="true">/</kbd></label><div class="gallery-filters" id="galleryFilters" role="group" aria-label="Show"><button class="gallery-filter" type="button" data-filter="all" aria-pressed="true">All <span class="gallery-filter-count" data-count="all"></span></button><button class="gallery-filter" type="button" data-filter="waiting" aria-pressed="false">Waiting <span class="gallery-filter-count" data-count="waiting"></span></button><button class="gallery-filter" type="button" data-filter="answered" aria-pressed="false">Answered <span class="gallery-filter-count" data-count="answered"></span></button><button class="gallery-filter" type="button" data-filter="ended" aria-pressed="false">Ended <span class="gallery-filter-count" data-count="ended"></span></button></div></div>
<section class="gallery-section" id="galleryPinnedSection" aria-labelledby="galleryPinnedTitle" hidden><h2 class="gallery-section-title" id="galleryPinnedTitle">Pinned</h2><ul class="gallery-list" id="galleryPinned"></ul></section>
<section class="gallery-section" id="galleryAllSection" aria-labelledby="galleryAllTitle"><h2 class="gallery-section-title" id="galleryAllTitle">All pages</h2><ul class="gallery-list" id="galleryList"></ul></section>
<div class="gallery-empty" id="galleryEmpty" hidden><p class="gallery-empty-title" id="galleryEmptyTitle">No pages yet</p><p class="gallery-empty-copy" id="galleryEmptyCopy">A page shows up here once an agent opens it with <code>lavish page.html</code>.</p></div>
<p class="gallery-status-line" id="galleryStatusLine" role="status" aria-live="polite"></p>
</main>
<div class="gallery-icons" hidden><span id="galleryIconPin">${GALLERY_ICONS.pin}</span><span id="galleryIconFile">${GALLERY_ICONS.file}</span></div>
<script id="lavish-gallery" type="application/json">${data}</script>
<script src="/lavish-assets/gallery-client.js"></script>
</body>
</html>`;
}
