/* global document, window, location */
// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
//
// The gallery page (Jadev fork): every page this machine opened in Lavish. The server embeds the
// rows (src/gallery.js); this script draws them once, filters by toggling `hidden`, and refetches
// when the tab comes back, so hundreds of pages stay quick. Text goes in with textContent only.
(() => {
  const byId = (id) => /** @type {any} */ (document.getElementById(id));
  const search = byId("gallerySearch");
  const filters = byId("galleryFilters");
  const pinnedSection = byId("galleryPinnedSection");
  const pinnedList = byId("galleryPinned");
  const allSection = byId("galleryAllSection");
  const allList = byId("galleryList");
  const allTitle = byId("galleryAllTitle");
  const emptyBox = byId("galleryEmpty");
  const emptyTitle = byId("galleryEmptyTitle");
  const emptyCopy = byId("galleryEmptyCopy");
  const summary = byId("gallerySummary");
  const statusLine = byId("galleryStatusLine");
  const themeButton = byId("galleryTheme");
  const main = byId("gallery");
  // The pin icon is the server's own SVG; each row gets a copy of the node.
  const pinIcon = byId("galleryIconPin")?.firstElementChild || null;
  if (!search || !allList || !main) return;

  /** @type {any[]} */
  let entries = [];
  try {
    entries = JSON.parse(byId("lavish-gallery")?.textContent || "{}").entries || [];
  } catch {
    entries = [];
  }
  let filter = "all";
  let words = [];
  /** @type {Map<string, any>} */
  const rows = new Map();
  let lastPayload = JSON.stringify(entries);

  const STATUS_LABELS = { waiting: "Waiting for you", answered: "Answered", ended: "Ended" };
  const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
  const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

  function relativeTime(iso) {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return "";
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 45) return "just now";
    if (seconds < 3600) return Math.round(seconds / 60) + " min ago";
    if (seconds < 86400) return Math.round(seconds / 3600) + " h ago";
    const days = Math.round(seconds / 86400);
    if (days === 1) return "yesterday";
    if (days < 7) return days + " days ago";
    return dateFormat.format(new Date(time));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function statusText(entry) {
    if (entry.missing) return "File missing";
    if (entry.status === "ended") return entry.ended_by === "agent" ? "Ended by the agent" : "Ended";
    return STATUS_LABELS[entry.status] || "Waiting for you";
  }

  function haystack(entry) {
    return [entry.title, entry.folder, entry.path, entry.file_name].join(" ").toLowerCase();
  }

  function buildRow(entry) {
    const row = el("li", "gallery-row");
    row.dataset.key = entry.key;
    row.dataset.status = entry.missing ? "missing" : entry.status;
    const link = el(entry.missing ? "div" : "a", "gallery-link");
    if (!entry.missing) {
      link.href = "/session/" + encodeURIComponent(entry.key);
      if (entry.status === "ended") link.title = "Reopen this review";
    } else {
      link.setAttribute("aria-disabled", "true");
      link.title = "The page file is no longer at this path.";
    }
    const main = el("span", "gallery-main");
    main.append(el("span", "gallery-name", entry.title || entry.file_name), el("span", "gallery-path", entry.path));
    const folder = el("span", "gallery-folder", entry.folder || "");
    const state = el("span", "gallery-state");
    state.dataset.status = row.dataset.status;
    if (entry.listening && entry.status !== "ended") {
      state.dataset.listening = "true";
      state.title = "The agent is listening for your answer.";
    }
    state.append(el("span", "gallery-dot"), el("span", "gallery-state-text", statusText(entry)));
    const time = el("time", "gallery-time", relativeTime(entry.changed_at));
    time.dateTime = entry.changed_at;
    if (entry.changed_at) time.title = "Last change " + fullFormat.format(new Date(entry.changed_at));
    link.append(main, folder, state, time);
    const pin = el("button", "gallery-pin");
    pin.type = "button";
    if (pinIcon) pin.append(pinIcon.cloneNode(true));
    pin.setAttribute("aria-pressed", String(Boolean(entry.pinned)));
    pin.setAttribute("aria-label", (entry.pinned ? "Unpin " : "Pin ") + (entry.title || entry.file_name));
    pin.title = entry.pinned ? "Unpin" : "Pin to the top";
    row.append(link, pin);
    return { row, entry, text: haystack(entry), time };
  }

  function render() {
    const focusKey = /** @type {any} */ (document.activeElement)?.closest?.(".gallery-row")?.dataset.key || "";
    const focusPin = Boolean(/** @type {any} */ (document.activeElement)?.classList?.contains("gallery-pin"));
    rows.clear();
    const pinned = document.createDocumentFragment();
    const rest = document.createDocumentFragment();
    for (const entry of entries) {
      const built = buildRow(entry);
      rows.set(entry.key, built);
      (entry.pinned ? pinned : rest).append(built.row);
    }
    pinnedList.replaceChildren(pinned);
    allList.replaceChildren(rest);
    applyFilter();
    if (focusKey) {
      const target = rows.get(focusKey)?.row.querySelector(focusPin ? ".gallery-pin" : ".gallery-link");
      target?.focus?.();
    }
  }

  function applyFilter() {
    const counts = { all: 0, waiting: 0, answered: 0, ended: 0 };
    let shownPinned = 0;
    let shownRest = 0;
    for (const { row, entry, text } of rows.values()) {
      const matchesSearch = words.every((word) => text.includes(word));
      if (matchesSearch) {
        counts.all += 1;
        if (counts[entry.status] !== undefined) counts[entry.status] += 1;
      }
      const visible = matchesSearch && (filter === "all" || entry.status === filter);
      row.hidden = !visible;
      if (visible && entry.pinned) shownPinned += 1;
      else if (visible) shownRest += 1;
    }
    for (const node of filters.querySelectorAll("[data-count]")) {
      node.textContent = String(counts[node.dataset.count] ?? 0);
    }
    pinnedSection.hidden = shownPinned === 0;
    allSection.hidden = shownRest === 0;
    allTitle.textContent = shownPinned ? "Other pages" : "All pages";
    const total = entries.length;
    summary.textContent =
      total === 0
        ? "Every page opened in Lavish on this machine shows up here."
        : total + (total === 1 ? " page" : " pages") + " opened in Lavish on this machine.";
    const shown = shownPinned + shownRest;
    emptyBox.hidden = shown > 0;
    if (shown === 0) {
      if (total === 0) {
        emptyTitle.textContent = "No pages yet";
        emptyCopy.textContent = "A page shows up here once an agent opens it with lavish page.html.";
      } else {
        emptyTitle.textContent = "No page matches";
        emptyCopy.textContent = words.length ? "Try fewer words, or clear the search." : "No page has this status.";
      }
    }
  }

  function setFilter(next) {
    filter = next;
    for (const button of filters.querySelectorAll("[data-filter]")) {
      button.setAttribute("aria-pressed", String(button.dataset.filter === filter));
    }
    applyFilter();
  }

  function setStatus(text) {
    statusLine.textContent = text || "";
  }

  async function refresh() {
    try {
      const response = await fetch("/api/gallery", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      const next = Array.isArray(data.entries) ? data.entries : [];
      const payload = JSON.stringify(next);
      if (payload === lastPayload) {
        refreshTimes();
        return;
      }
      lastPayload = payload;
      entries = next;
      render();
    } catch {
      // Lavish stopped or is restarting; the page keeps what it shows.
    }
  }

  function refreshTimes() {
    for (const { entry, time } of rows.values()) time.textContent = relativeTime(entry.changed_at);
  }

  async function togglePin(key) {
    const entry = entries.find((item) => item.key === key);
    if (!entry) return;
    const pinned = !entry.pinned;
    try {
      const response = await fetch("/api/gallery/pins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, pinned }),
      });
      if (!response.ok) throw new Error("pin failed");
      const data = await response.json();
      const order = new Map((Array.isArray(data.pins) ? data.pins : []).map((item, index) => [item, index]));
      for (const item of entries) item.pinned = order.has(item.key);
      // Pinned first in pin order, the rest as the server sorted them.
      entries.sort((a, b) => {
        const pa = order.has(a.key) ? order.get(a.key) : Infinity;
        const pb = order.has(b.key) ? order.get(b.key) : Infinity;
        if (pa !== pb) return pa - pb;
        return (Date.parse(b.changed_at) || 0) - (Date.parse(a.changed_at) || 0);
      });
      lastPayload = JSON.stringify(entries);
      render();
      setStatus(pinned ? "Pinned " + entry.title + "." : "Unpinned " + entry.title + ".");
    } catch {
      setStatus("Could not save the pin. Lavish may have stopped.");
    }
  }

  async function reopen(entry) {
    setStatus("Reopening " + entry.title + "…");
    try {
      const response = await fetch("/api/gallery/" + encodeURIComponent(entry.key) + "/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.url !== "string" || !data.url.startsWith("/session/")) {
        setStatus(data.error ? "Could not reopen: " + data.error : "Could not reopen this page.");
        return;
      }
      location.href = data.url;
    } catch {
      setStatus("Could not reopen this page. Lavish may have stopped.");
    }
  }

  main.addEventListener("click", (event) => {
    const target = /** @type {any} */ (event.target);
    const pin = target?.closest?.(".gallery-pin");
    if (pin) {
      void togglePin(pin.closest(".gallery-row")?.dataset.key || "");
      return;
    }
    const link = target?.closest?.("a.gallery-link");
    if (!link) return;
    const entry = rows.get(link.closest(".gallery-row")?.dataset.key || "")?.entry;
    // A plain click on an ended review reopens it first; a modified click keeps the browser's own
    // behaviour (a new tab shows the review as it ended).
    if (entry?.status === "ended" && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
      event.preventDefault();
      void reopen(entry);
    }
  });
  search.addEventListener("input", () => {
    words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    applyFilter();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && search.value) {
      search.value = "";
      words = [];
      applyFilter();
    } else if (event.key === "Enter") {
      const first = [...rows.values()].find(({ row }) => !row.hidden)?.row.querySelector("a.gallery-link");
      first?.click();
    }
  });
  filters.addEventListener("click", (event) => {
    const button = /** @type {any} */ (event.target)?.closest?.("[data-filter]");
    if (button) setFilter(button.dataset.filter);
  });
  document.addEventListener("keydown", (event) => {
    const active = /** @type {any} */ (document.activeElement);
    const typing = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
    if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      search.focus();
      search.select();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, 30_000);

  // Theme: the same stored choice as the review chrome, so both follow one switch.
  const THEME_KEY = "lavish-axi:theme";
  const root = document.documentElement;
  const darkQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  // Used only when the browser refuses storage, so the switch still works for this visit.
  let unsavedTheme = "";
  function storedTheme() {
    try {
      const value = window.localStorage.getItem(THEME_KEY);
      return value === "light" || value === "dark" ? value : "";
    } catch {
      return unsavedTheme;
    }
  }
  function effectiveTheme() {
    return storedTheme() || (darkQuery?.matches ? "dark" : "light");
  }
  function applyTheme() {
    const stored = storedTheme();
    if (stored) root.dataset.theme = stored;
    else delete root.dataset.theme;
    const dark = effectiveTheme() === "dark";
    const label = dark ? "Switch to light theme" : "Switch to dark theme";
    themeButton.setAttribute("aria-label", label);
    themeButton.title = label;
    themeButton.setAttribute("aria-pressed", String(dark));
    for (const icon of themeButton.querySelectorAll("[data-icon]")) {
      icon.hidden = icon.dataset.icon !== (dark ? "sun" : "moon");
    }
  }
  themeButton.addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      unsavedTheme = next;
    }
    applyTheme();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY) applyTheme();
  });
  darkQuery?.addEventListener?.("change", applyTheme);

  applyTheme();
  render();
  window.setInterval(refreshTimes, 60_000);
})();
