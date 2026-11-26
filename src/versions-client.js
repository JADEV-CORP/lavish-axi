/* global document, window */
// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
//
// The Versions panel (Jadev fork). It lists every saved version of this page, shows one read-only,
// compares two, and restores one after the reviewer confirms. The server computes the list, the
// summaries and the diff rows (src/version-diff.js); this script only draws them, with textContent,
// never as HTML. It loads after chrome-client.js and reaches that script only through two window
// functions it declares (setLayerOpen, closeMenus) and the `lavish:versions` document event, so the
// two files can change apart.
(() => {
  const byId = (id) => /** @type {any} */ (document.getElementById(id));
  const dialog = byId("versionsDialog");
  const surface = byId("versionsSurface");
  const openButton = byId("openVersions");
  if (!dialog || !surface || !openButton) return;
  const chrome = /** @type {any} */ (window);
  const pageKey = (() => {
    try {
      return String(JSON.parse(byId("lavish-session")?.textContent || "{}").key || "");
    } catch {
      return "";
    }
  })();
  const list = byId("versionsList");
  const sub = byId("versionsSub");
  const closeButton = byId("versionsClose");
  const tabView = byId("versionsTabView");
  const tabCompare = byId("versionsTabCompare");
  const compareWrap = byId("versionsCompareWrap");
  const compareBase = byId("versionsCompareBase");
  const modes = byId("versionsModes");
  const restoreButton = byId("versionsRestore");
  const restoreLabel = byId("versionsRestoreLabel");
  const confirmBox = byId("versionsConfirm");
  const confirmText = byId("versionsConfirmText");
  const confirmCancel = byId("versionsConfirmCancel");
  const confirmRestore = byId("versionsConfirmRestore");
  const frame = byId("versionsFrame");
  const diffView = byId("versionsDiff");
  const empty = byId("versionsEmpty");
  const note = byId("versionsNote");
  const status = byId("versionsStatus");
  const endedOverlay = byId("endedOverlay");

  /** @type {any[]} newest first, as the server sends them */
  let versions = [];
  let selectedId = 0;
  let baseId = 0;
  let tab = "view";
  let mode = "text";
  let listRequest = 0;
  let diffRequest = 0;
  let restoring = false;
  let frameSrc = "";

  const api = (suffix) => "/api/" + encodeURIComponent(pageKey) + "/versions" + suffix;
  const isOpen = () => !dialog.hidden;
  const isEnded = () => Boolean(endedOverlay && !endedOverlay.hidden);

  function setLayer(open) {
    if (typeof chrome.setLayerOpen === "function") {
      chrome.setLayerOpen(dialog, open, open ? { surface } : { surface, closeToken: "--modal-close-dur" });
    } else {
      dialog.hidden = !open;
    }
  }

  function setStatus(text) {
    status.textContent = text || "";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const timeFormat = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  function formatTime(iso) {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return "";
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 45) return "just now";
    if (seconds < 3600) return Math.round(seconds / 60) + " min ago";
    if (seconds < 6 * 3600) return Math.round(seconds / 3600) + " h ago";
    return timeFormat.format(new Date(time));
  }

  function versionById(id) {
    return versions.find((version) => version.id === id) || null;
  }

  function openPanel() {
    if (isEnded()) return;
    if (typeof chrome.closeMenus === "function") chrome.closeMenus();
    setLayer(true);
    hideConfirm();
    setStatus("");
    void load({ keepSelection: false });
    closeButton.focus();
  }

  function closePanel() {
    if (!isOpen()) return;
    hideConfirm();
    setLayer(false);
    // Stop the version's scripts; nothing keeps running behind a closed panel.
    frameSrc = "";
    frame.src = "about:blank";
    openButton.focus?.();
  }

  async function load({ keepSelection }) {
    const request = ++listRequest;
    if (!versions.length) sub.textContent = "Loading the saved versions…";
    try {
      const response = await fetch(api(""), { cache: "no-store" });
      if (!response.ok) throw new Error("list failed");
      const data = await response.json();
      if (request !== listRequest) return;
      const previous = versionById(selectedId);
      versions = Array.isArray(data.versions) ? data.versions : [];
      const count = versions.length;
      sub.textContent =
        count === 0
          ? data.enabled === false
            ? "Saving versions is off (LAVISH_AXI_VERSIONS=0)."
            : "No saved versions yet."
          : count +
            (count === 1 ? " saved version" : " saved versions") +
            " of this page, kept on this machine." +
            (data.enabled === false ? " Saving new ones is off." : "");
      const current = versions.find((version) => version.current) || versions[0] || null;
      const keep = keepSelection && previous && !previous.current ? versionById(previous.id) : null;
      select(keep ? keep.id : current ? current.id : 0, { focus: false });
    } catch {
      if (request !== listRequest) return;
      sub.textContent = "Could not load the versions. Close the panel and try again.";
    }
  }

  function renderList() {
    const rows = versions.map((version) => {
      const row = el("button", "versions-row");
      row.type = "button";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(version.id === selectedId));
      row.dataset.id = String(version.id);
      row.tabIndex = version.id === selectedId ? 0 : -1;
      const top = el("span", "versions-row-top");
      top.append(el("span", "versions-row-name", "Version " + version.id));
      if (version.current) top.append(el("span", "versions-badge", "Current"));
      if (version.source === "restore") top.append(el("span", "versions-badge versions-badge-muted", "Restored"));
      const time = el("time", "versions-row-time", formatTime(version.at));
      time.dateTime = version.at;
      time.title = new Date(version.at).toLocaleString();
      top.append(time);
      row.append(top, el("span", "versions-row-summary", version.summary || "Saved"));
      row.append(el("span", "versions-row-meta", version.size + " · " + version.change));
      return row;
    });
    list.replaceChildren(...rows);
    if (!rows.length) list.append(el("p", "versions-list-empty", "Versions appear here each time the page is saved."));
  }

  function select(id, { focus = true } = {}) {
    selectedId = id;
    const index = versions.findIndex((version) => version.id === id);
    // Compare with the version saved just before this one, which is the change it made.
    baseId = index >= 0 && index + 1 < versions.length ? versions[index + 1].id : 0;
    hideConfirm();
    renderList();
    renderCompareOptions();
    renderDetail();
    if (focus) list.querySelector('[aria-selected="true"]')?.focus();
  }

  function renderCompareOptions() {
    const options = versions
      .filter((version) => version.id !== selectedId)
      .map((version) => {
        const option = el(
          "option",
          "",
          "Version " + version.id + (version.current ? " (current)" : "") + ", " + formatTime(version.at),
        );
        option.value = String(version.id);
        option.selected = version.id === baseId;
        return option;
      });
    compareBase.replaceChildren(...options);
    compareBase.disabled = options.length === 0;
  }

  function renderDetail() {
    const selected = versionById(selectedId);
    tabView.setAttribute("aria-selected", String(tab === "view"));
    tabCompare.setAttribute("aria-selected", String(tab === "compare"));
    compareWrap.hidden = tab !== "compare";
    modes.hidden = tab !== "compare";
    for (const button of modes.querySelectorAll("[data-mode]")) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
    }
    restoreButton.disabled = !selected || selected.current || restoring || isEnded();
    restoreLabel.textContent = selected && !selected.current ? "Restore version " + selected.id : "Restore";
    restoreButton.title = selected?.current ? "This is the page as it is now." : "";
    if (!selected) {
      frame.hidden = true;
      diffView.hidden = true;
      note.hidden = true;
      showEmpty(versions.length ? "Pick a version." : "Nothing saved yet.");
      return;
    }
    if (tab === "view") {
      diffView.hidden = true;
      empty.hidden = true;
      frame.hidden = false;
      note.hidden = false;
      const src = api("/" + selected.id + "/view");
      if (frameSrc !== src) {
        frameSrc = src;
        frame.src = src;
      }
      return;
    }
    frame.hidden = true;
    note.hidden = true;
    void loadDiff();
  }

  function showEmpty(text) {
    empty.textContent = text;
    empty.hidden = false;
  }

  async function loadDiff() {
    const request = ++diffRequest;
    const selected = versionById(selectedId);
    if (!selected) return;
    if (!baseId) {
      diffView.hidden = true;
      showEmpty("This is the oldest saved version, so there is nothing older to compare it with.");
      return;
    }
    empty.hidden = true;
    diffView.hidden = false;
    diffView.setAttribute("aria-busy", "true");
    try {
      const query = "?from=" + baseId + "&to=" + selected.id + "&mode=" + mode;
      const response = await fetch(api("/diff" + query), { cache: "no-store" });
      if (!response.ok) throw new Error("diff failed");
      const data = await response.json();
      if (request !== diffRequest) return;
      renderDiff(data);
    } catch {
      if (request !== diffRequest) return;
      diffView.hidden = true;
      showEmpty("Could not compare these two versions.");
    } finally {
      if (request === diffRequest) diffView.removeAttribute("aria-busy");
    }
  }

  function lineNumber(value) {
    return el("span", "versions-ln", value ? String(value) : "");
  }

  function diffLine(kind, a, b, content) {
    const line = el("div", "versions-line versions-line-" + kind);
    const sign = kind === "add" ? "+" : kind === "del" ? "-" : " ";
    line.append(lineNumber(a), lineNumber(b), el("span", "versions-sign", sign));
    const text = el("span", "versions-text");
    if (typeof content === "string") text.textContent = content;
    else text.append(...content);
    line.append(text);
    return line;
  }

  // One changed line drawn twice: the old one with its removed words marked, the new one with its
  // added words marked.
  function partsFor(parts, keep) {
    return parts
      .filter(([kind]) => kind === "=" || kind === keep)
      .map(([kind, text]) => (kind === "=" ? document.createTextNode(text) : el("mark", "versions-mark", text)));
  }

  function renderDiff(data) {
    const nodes = [];
    const stats = data.stats || {};
    const head = el("p", "versions-diff-head");
    const from = versionById(data.from);
    const to = versionById(data.to);
    const label = (version, id) => "version " + id + (version?.current ? " (current)" : "");
    head.textContent =
      "From " +
      label(from, data.from) +
      " to " +
      label(to, data.to) +
      ": " +
      [
        stats.changed ? stats.changed + " changed" : "",
        stats.added ? stats.added + " added" : "",
        stats.removed ? stats.removed + " removed" : "",
      ]
        .filter(Boolean)
        .join(", ");
    if (data.identical) {
      head.textContent =
        data.mode === "html"
          ? "The HTML of these two versions is the same."
          : "The text is the same. Switch to HTML to see what changed in the markup.";
      nodes.push(head);
      diffView.replaceChildren(...nodes);
      return;
    }
    nodes.push(head);
    for (const row of Array.isArray(data.rows) ? data.rows : []) {
      if (row.t === "skip") {
        nodes.push(el("div", "versions-skip", row.count + (row.count === 1 ? " unchanged line" : " unchanged lines")));
      } else if (row.t === "same") {
        nodes.push(diffLine("same", row.a, row.b, row.text));
      } else if (row.t === "add") {
        nodes.push(diffLine("add", 0, row.b, row.text));
      } else if (row.t === "del") {
        nodes.push(diffLine("del", row.a, 0, row.text));
      } else if (row.t === "mod") {
        const parts = Array.isArray(row.parts) ? row.parts : [];
        nodes.push(diffLine("del", row.a, 0, partsFor(parts, "-")));
        nodes.push(diffLine("add", 0, row.b, partsFor(parts, "+")));
      }
    }
    if (data.truncated) nodes.push(el("p", "versions-diff-foot", "The comparison stops here: it is too long to show."));
    if (data.exact === false) {
      nodes.push(
        el("p", "versions-diff-foot", "Too much changed to match lines one by one, so the middle shows as replaced."),
      );
    }
    diffView.replaceChildren(...nodes);
    diffView.scrollTop = 0;
  }

  function showConfirm() {
    const selected = versionById(selectedId);
    if (!selected || selected.current || isEnded()) return;
    confirmText.textContent =
      "Restore version " +
      selected.id +
      "? The page file gets this version's HTML back. What the page holds now stays in this list, and the restore is saved as a new version.";
    confirmRestore.textContent = "Restore version " + selected.id;
    confirmBox.hidden = false;
    confirmCancel.focus();
  }

  function hideConfirm() {
    if (confirmBox) confirmBox.hidden = true;
  }

  async function restoreSelected() {
    const selected = versionById(selectedId);
    if (!selected || restoring) return;
    restoring = true;
    confirmRestore.disabled = true;
    renderDetail();
    setStatus("Restoring version " + selected.id + "…");
    try {
      const response = await fetch(api("/" + selected.id + "/restore"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 && data.status === "ended") {
        setStatus("This review has ended, so the page was not changed.");
      } else if (!response.ok || data.status !== "restored") {
        setStatus(data.error ? "Restore failed: " + data.error : "Restore failed. The page was not changed.");
      } else {
        setStatus("Restored version " + selected.id + ". The page shows it now.");
        hideConfirm();
        restoring = false;
        await load({ keepSelection: false });
        return;
      }
    } catch {
      setStatus("Restore failed: Lavish did not answer. Check the page before trying again.");
    } finally {
      restoring = false;
      confirmRestore.disabled = false;
      renderDetail();
    }
  }

  openButton.addEventListener("click", openPanel);
  closeButton.addEventListener("click", closePanel);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closePanel();
  });
  list.addEventListener("click", (event) => {
    const row = /** @type {any} */ (event.target)?.closest?.(".versions-row");
    if (row) select(Number(row.dataset.id));
  });
  list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const index = versions.findIndex((version) => version.id === selectedId);
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(versions.length - 1, index + 1);
    if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = versions.length - 1;
    if (next >= 0 && next !== index) {
      event.preventDefault();
      select(versions[next].id);
    }
  });
  tabView.addEventListener("click", () => {
    tab = "view";
    renderDetail();
  });
  tabCompare.addEventListener("click", () => {
    tab = "compare";
    renderDetail();
  });
  compareBase.addEventListener("change", () => {
    baseId = Number(compareBase.value) || 0;
    void loadDiff();
  });
  modes.addEventListener("click", (event) => {
    const button = /** @type {any} */ (event.target)?.closest?.("[data-mode]");
    if (!button || button.dataset.mode === mode) return;
    mode = button.dataset.mode === "html" ? "html" : "text";
    renderDetail();
  });
  restoreButton.addEventListener("click", showConfirm);
  confirmCancel.addEventListener("click", () => {
    hideConfirm();
    restoreButton.focus();
  });
  confirmRestore.addEventListener("click", () => void restoreSelected());
  // Capture phase, so Escape closes this panel (or its confirmation) before the chrome's own
  // Escape handling closes anything underneath.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !isOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      if (!confirmBox.hidden) {
        hideConfirm();
        restoreButton.focus();
      } else {
        closePanel();
      }
    },
    true,
  );
  document.addEventListener("lavish:versions", () => {
    if (isOpen()) void load({ keepSelection: true });
  });
  // A review that ends closes the panel: an ended review is read-only.
  if (endedOverlay && typeof window.MutationObserver === "function") {
    new window.MutationObserver(() => {
      if (isEnded()) closePanel();
    }).observe(endedOverlay, { attributes: true, attributeFilter: ["hidden"] });
  }
})();
