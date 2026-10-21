import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { createSdkJs } from "../src/server.js";

// The SDK the browser actually runs is a serialized bundle, not the module: `createSdkJs` has to
// declare every helper `createArtifactSdk` reaches for. A helper left out compiles fine and only
// ReferenceErrors on the first click, so these tests boot the served bundle and drive the real
// annotation path through a DOM stub instead of inspecting the module directly.

function createElement(tag) {
  const attributes = new Map();
  const queried = new Map();
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    nodeType: 1,
    parentElement: null,
    children: [],
    style: {},
    value: "",
    innerHTML: "",
    textContent: "",
    offsetWidth: 100,
    offsetHeight: 100,
    hidden: false,
    listeners: [],
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    after(node) {
      const parent = element.parentElement;
      if (!parent) return;
      node.parentElement = parent;
      parent.children.splice(parent.children.indexOf(element) + 1, 0, node);
    },
    contains(other) {
      for (let current = other; current; current = current.parentElement) if (current === element) return true;
      return false;
    },
    matches(selectorList) {
      return String(selectorList)
        .split(",")
        .some((part) => {
          const selector = part.trim();
          // `tag`, `[attr]`, or `tag[attr]` (e.g. `a[href]`): enough selector for what the SDK asks.
          const bracket = selector.indexOf("[");
          const tag = bracket >= 0 ? selector.slice(0, bracket) : selector;
          if (tag && tag !== element.tagName.toLowerCase()) return false;
          return bracket < 0 || attributes.has(selector.slice(bracket + 1, selector.indexOf("]")).split("=")[0]);
        });
    },
    closest(selectorList) {
      let current = element;
      while (current) {
        if (current.matches(selectorList)) return current;
        current = current.parentElement;
      }
      return null;
    },
    appendChild(child) {
      child.parentElement = element;
      element.children.push(child);
      return child;
    },
    remove() {
      const index = element.parentElement?.children.indexOf(element) ?? -1;
      if (index >= 0) element.parentElement.children.splice(index, 1);
    },
    // Card internals are looked up by class after innerHTML is assigned, so hand back a stable
    // stub per selector: the test drives the very buttons the SDK wired up.
    querySelector(selector) {
      if (!queried.has(selector)) queried.set(selector, createElement(selector.replace(/^[.#]/, "")));
      return queried.get(selector);
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30 };
    },
    addEventListener(type, handler) {
      element.listeners.push({ type, handler });
    },
    removeEventListener() {},
    focus() {},
    click() {},
    scrollIntoView() {},
    attachShadow() {
      element.shadowRoot = createElement("shadow-root");
      return element.shadowRoot;
    },
  };
  return element;
}

function appendTo(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function cell(tag, text) {
  const element = createElement(tag);
  element.textContent = text;
  return element;
}

function bootSdk({
  runAnimationFrames = false,
  revisionsScript = null,
  revisionMarkElements = [],
  query = () => null,
  // What getComputedStyle answers, per element, for tests that read the page's colours.
  /** @type {(el: any, page: { documentElement: any, body: any }) => Record<string, string>} */
  computedStyle = (/** @type {any} */ _el, /** @type {any} */ _page) => /** @type {Record<string, string>} */ ({}),
  htmlAnnotate = null,
  platform = "Linux",
} = {}) {
  const posted = [];
  const documentListeners = [];
  // Deferred work the SDK schedules, run only when a test asks for it: the draft-anchor settle
  // re-query is a real timer, and asserting on it means running it rather than assuming it.
  const timers = [];
  const scheduleTimer = (fn, ms) => timers.push({ fn, ms }) && timers.length;
  const cancelTimer = (id) => {
    if (timers[id - 1]) timers[id - 1].cancelled = true;
  };
  /** @type {(selector: string) => any} */
  let documentQuery = query;
  /** @type {any} */
  let selection = null;
  const documentElement = createElement("html");
  const head = createElement("head");
  const body = createElement("body");
  if (htmlAnnotate !== null) documentElement.setAttribute("data-lavish-annotate", htmlAnnotate);
  appendTo(documentElement, head);
  appendTo(documentElement, body);
  for (const element of revisionMarkElements) appendTo(body, element);

  const sandbox = {
    parent: { postMessage: (message) => posted.push(message) },
    navigator: { platform },
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class ResizeObserver {
      observe() {}
      disconnect() {}
    },
    // A real URL constructor, so link resolution runs as in a browser, plus the blob helpers.
    URL: class extends URL {
      static createObjectURL() {
        return "blob:lavish-test";
      }
      static revokeObjectURL() {}
    },
    getComputedStyle: (/** @type {any} */ el) => computedStyle(el, { documentElement, body }),
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: (fn) => (runAnimationFrames ? scheduleTimer(fn, 0) : 0),
    document: {
      readyState: "complete",
      documentElement,
      head,
      body,
      activeElement: body,
      baseURI: "http://127.0.0.1/artifact/abc/index.html",
      addEventListener: (type, handler) => documentListeners.push({ type, handler }),
      removeEventListener() {},
      createElement,
      getElementById: () => null,
      querySelector: (selector) =>
        selector === "script[data-lavish-revisions]" ? revisionsScript : documentQuery(selector),
      querySelectorAll: (selector) => {
        if (selector === "[data-lavish-revision]") return revisionMarkElements;
        // The page's pictures, in document order, for the viewer's previous and next.
        if (selector === "img, svg") {
          const found = [];
          const walk = (node) => {
            for (const child of node.children) {
              if (child.tagName === "IMG" || child.tagName === "SVG") found.push(child);
              walk(child);
            }
          };
          walk(body);
          return found;
        }
        return [];
      },
      getSelection: () => selection,
    },
  };
  const windowListeners = [];
  sandbox.window = {
    addEventListener: (type, handler) => windowListeners.push({ type, handler }),
    removeEventListener() {},
    setTimeout: scheduleTimer,
    clearTimeout: cancelTimer,
    requestAnimationFrame: (fn) => (runAnimationFrames ? scheduleTimer(fn, 0) : 0),
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    location: { origin: "http://127.0.0.1" },
    URL: sandbox.URL,
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(createSdkJs("abc", 3, "load-token"), sandbox);

  return {
    posted,
    body,
    documentElement,
    api: sandbox.window.lavish,
    Element: sandbox.Element,
    // Explore mode's own click listener (zoom), registered after the annotation one.
    exploreClick(target) {
      const listener = documentListeners.filter((entry) => entry.type === "click").at(-1);
      const event = {
        target,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopPropagation() {},
      };
      listener.handler(event);
      return event;
    },
    // Every document keydown listener, as a key press anywhere in the page reaches them.
    keydown(props) {
      const event = {
        key: "",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...props,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopPropagation() {},
      };
      for (const entry of documentListeners.filter((listener) => listener.type === "keydown")) entry.handler(event);
      return event;
    },
    // Returns the dispatched event so a test can tell whether the SDK swallowed the click.
    click(target, modifiers = {}) {
      const listener = documentListeners.find((entry) => entry.type === "click");
      assert.ok(listener, "the SDK registers a document click listener");
      const event = {
        target,
        ctrlKey: false,
        metaKey: false,
        ...modifiers,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopPropagation() {},
      };
      listener.handler(event);
      return event;
    },
    // Releases the mouse over `target` with `text` selected inside it, as a drag-select would.
    selectText(target, text) {
      const textNode = { nodeType: 3, parentElement: target, parentNode: { childNodes: [] } };
      textNode.parentNode.childNodes.push(textNode);
      const range = {
        collapsed: false,
        commonAncestorContainer: textNode,
        startContainer: textNode,
        startOffset: 0,
        endContainer: textNode,
        endOffset: text.length,
        cloneRange: () => range,
        getClientRects: () => [],
        getBoundingClientRect: () => target.getBoundingClientRect(),
      };
      selection = { rangeCount: 1, getRangeAt: () => range, toString: () => text };
      const listener = documentListeners.find((entry) => entry.type === "mouseup");
      assert.ok(listener, "the SDK registers a document mouseup listener");
      listener.handler({ target });
      selection = null;
    },
    setDocumentQuery(query) {
      documentQuery = query;
    },
    runTimers() {
      const pending = timers.splice(0, timers.length);
      for (const timer of pending) {
        if (!timer.cancelled) timer.fn();
      }
    },
    async runAllTimers() {
      for (let round = 0; round < 100; round += 1) {
        await Promise.resolve();
        await Promise.resolve();
        const pending = timers.splice(0, timers.length);
        if (pending.length === 0) {
          await Promise.resolve();
          if (timers.length === 0) return;
          continue;
        }
        for (const timer of pending) {
          if (!timer.cancelled) timer.fn();
        }
      }
      assert.fail("the SDK timer queue did not settle");
    },
    // The chrome is the only legitimate sender, so its messages arrive with `source: parent`.
    sendChromeMessage(data) {
      const listeners = windowListeners.filter((entry) => entry.type === "message");
      assert.ok(listeners.length > 0, "the SDK registers a window message listener");
      for (const listener of listeners) listener.handler({ source: sandbox.parent, data });
    },
    cards() {
      return documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .filter((child) => child.className === "lavish-annotation-card");
    },
    card() {
      const card = this.cards().at(-1);
      assert.ok(card, "clicking an element opens an annotation card");
      return card;
    },
    queue(text) {
      const card = this.card();
      card.querySelector("textarea").value = text;
      card.querySelector(".lavish-send").onclick();
      return posted.at(-1);
    },
  };
}

for (const { label, attributes, enabled } of [
  { label: "default", attributes: {}, enabled: true },
  { label: "html off", attributes: { htmlAnnotate: "off" }, enabled: false },
  { label: "html on", attributes: { htmlAnnotate: "on" }, enabled: true },
  { label: "unknown html value", attributes: { htmlAnnotate: "no" }, enabled: true },
  { label: "empty html value", attributes: { htmlAnnotate: "" }, enabled: true },
]) {
  test(`annotation declaration honours ${label} and reports its initial mode`, () => {
    const sdk = bootSdk(attributes);
    const target = appendTo(sdk.body, cell("p", "Decision board"));
    assert.equal(sdk.click(target).defaultPrevented, enabled);
    assert.equal(sdk.cards().length, enabled ? 1 : 0);
    const mode = sdk.posted.find((message) => message.type === "lavish:annotationMode");
    assert.ok(mode, "the SDK reports the initial mode to the chrome");
    assert.equal(mode.enabled, enabled);
    assert.equal(mode.artifact_load_token, "load-token");
  });
}

// Applying the page's "off" default closes no card, so it must not report one gone: the chrome
// saves every `card: null` report over the stored draft, and the frame's load event that replays
// that draft can arrive after a slow image, later than the report.
test("a page that declares off reports no review state at boot", () => {
  const sdk = bootSdk({ htmlAnnotate: "off" });
  sdk.runTimers();
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewState"),
    false,
    "nothing was open, so there is no card state to retire",
  );
  const target = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "h1", text: "needs a shorter headline" }, fields: [] },
  });
  sdk.setDocumentQuery((selector) => (selector === "h1" ? target : null));
  sdk.runTimers();
  assert.equal(sdk.card().querySelector("textarea").value, "needs a shorter headline");
});

test("the chrome can turn annotation on and off after a page declares off", () => {
  const sdk = bootSdk({ htmlAnnotate: "off" });
  const target = appendTo(sdk.body, cell("p", "Decision board"));
  assert.equal(sdk.click(target).defaultPrevented, false);
  sdk.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: true });
  assert.equal(sdk.click(target).defaultPrevented, true);
  assert.equal(sdk.cards().length, 1);
  sdk.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: false });
  assert.equal(sdk.click(target).defaultPrevented, false);
  // This harness retains closed cards; no new card should appear while disabled.
  assert.equal(sdk.cards().length, 1);
  sdk.runTimers();
  const state = sdk.posted.filter((message) => message.type === "lavish:reviewState").at(-1);
  assert.equal(state.state.card, null, "turning annotation off closes the active card");
});

function buildTable(sdk) {
  const table = appendTo(sdk.body, createElement("table"));
  const thead = appendTo(table, createElement("thead"));
  const headerRow = appendTo(thead, createElement("tr"));
  for (const label of ["Permission / setting", "Visible state", "Database evidence"]) {
    appendTo(headerRow, cell("th", label));
  }
  const tbody = appendTo(table, createElement("tbody"));
  const dataRow = appendTo(tbody, createElement("tr"));
  appendTo(dataRow, cell("td", "Media & Apple Music"));
  appendTo(dataRow, cell("td", "4 apps"));
  const evidence = appendTo(dataRow, cell("td", "Drive, Neovide, Cursor"));
  const badge = appendTo(evidence, cell("code", "Drive"));
  return { evidence, badge };
}

test("a requested layout diagnostic publishes even when the result is unchanged", async () => {
  const sdk = bootSdk({ runAnimationFrames: true });

  await sdk.runAllTimers();
  const first = sdk.posted.filter((message) => message.type === "lavish:layoutDiagnostics");
  assert.equal(first.length, 1);

  sdk.sendChromeMessage({ type: "lavish:requestLayoutDiagnostics" });
  await sdk.runAllTimers();
  const diagnostics = sdk.posted.filter((message) => message.type === "lavish:layoutDiagnostics");
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[1].artifact_pass_sequence, diagnostics[0].artifact_pass_sequence + 1);
  assert.deepEqual(diagnostics[1].findings, diagnostics[0].findings);
});

test("the served SDK echoes the snapshot request id", () => {
  const sdk = bootSdk();

  sdk.sendChromeMessage({ type: "lavish:requestSnapshot", snapshot_request_id: "snapshot-17" });

  const response = sdk.posted.at(-1);
  assert.equal(response.type, "lavish:snapshot");
  assert.equal(response.snapshot_request_id, "snapshot-17");
  assert.equal(response.artifact_load_token, "load-token");
});

// readArtifactRevisions calls parseRevisionRegistry and collectRevisionMarks, which in turn call
// the rest of the revision helper chain; a helper left out of the bundle only ReferenceErrors on
// this real read, which a source-grep over the bundle text cannot catch.
test("the served SDK bundle reports the artifact's own revision registry and marks", () => {
  const revisionsScript = createElement("script");
  revisionsScript.textContent = JSON.stringify([
    { id: "r1", label: "Tightened header copy", summary: "Shortened the hero headline" },
  ]);
  const marked = createElement("h1");
  marked.setAttribute("data-lavish-revision", "r1");
  marked.textContent = "Ship faster";

  const sdk = bootSdk({ revisionsScript, revisionMarkElements: [marked] });

  const message = sdk.posted.find((entry) => entry.type === "lavish:revisions");
  assert.ok(message, "the SDK reports the revision registry on load");
  assert.equal(message.revisions.length, 1);
  assert.equal(message.revisions[0].id, "r1");
  assert.equal(message.revisions[0].label, "Tightened header copy");
  assert.equal(message.revisions[0].mark_count, 1);
  assert.equal(message.marks.length, 1);
  assert.equal(message.marks[0].revision_id, "r1");
  assert.equal(message.marks[0].selector, "html > body > h1");
  assert.equal(message.marks[0].excerpt, "Ship faster");
});

test("the served SDK bundle queues a table-cell annotation without a missing-helper ReferenceError", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);
  const message = sdk.queue("Check this permission");

  assert.equal(message.type, "lavish:queuePrompt");
  assert.equal(message.prompt.prompt, "Check this permission");
  assert.deepEqual(
    { ...message.prompt.target },
    {
      type: "table-cell",
      selector: "body > table > tbody > tr > td:nth-of-type(3)",
      rowLabel: "Media & Apple Music",
      columnLabel: "Database evidence",
      text: "Drive, Neovide, Cursor",
    },
  );
});

test("the served SDK bundle keeps the clicked element's own identity inside a table cell", () => {
  const sdk = bootSdk();
  const { badge } = buildTable(sdk);

  sdk.click(badge);
  const message = sdk.queue("Rename this app");

  assert.equal(message.prompt.tag, "code");
  assert.equal(message.prompt.selector, "table > tbody > tr > td:nth-of-type(3) > code");
  assert.equal(message.prompt.text, "Drive");
  assert.equal(message.prompt.target.selector, "body > table > tbody > tr > td:nth-of-type(3)");
  assert.equal(message.prompt.target.columnLabel, "Database evidence");
});

test("the annotation card names the cell it annotates when the cell itself is clicked", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.click(evidence);

  assert.match(sdk.card().innerHTML, /Annotate cell: Media &amp; Apple Music → Database evidence/);
  assert.match(sdk.card().innerHTML, /about this table cell/);
});

test("the annotation card names the clicked element, not the cell, for a nested click", () => {
  const sdk = bootSdk();
  const { badge } = buildTable(sdk);

  sdk.click(badge);

  assert.match(sdk.card().innerHTML, /Annotate &lt;code&gt; in Media &amp; Apple Music → Database evidence/);
  assert.doesNotMatch(sdk.card().innerHTML, /about this table cell/);
});

test("the served SDK bundle resolves table coordinates only for annotation clicks", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);

  sdk.api.queuePrompt("Programmatic note", { element: evidence });

  assert.equal(sdk.posted.at(-1).prompt.target, undefined);
});

test("the served SDK bundle annotates elements outside tables with no table target", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const message = sdk.queue("Reword this");

  assert.equal(message.prompt.tag, "p");
  assert.equal(message.prompt.target, undefined);
});

// closeCard() clears the element highlight, so that highlight standing or gone is the observable proof of close.
function pressEscape(textarea) {
  const listener = textarea.listeners.find((entry) => entry.type === "keydown");
  assert.ok(listener, "the annotation textarea registers a keydown listener");
  listener.handler({ key: "Escape", preventDefault() {} });
}

test("Escape closes an annotation card with no text and no attachment", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  textarea.value = "   "; // whitespace-only counts as empty
  pressEscape(textarea);

  assert.equal(paragraph.style.outline, "", "the highlight is cleared, proving the card closed");
});

test("Escape during IME composition leaves an empty annotation card open", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  const listener = textarea.listeners.find((entry) => entry.type === "keydown");
  listener.handler({ key: "Escape", isComposing: true, preventDefault() {} });

  assert.notEqual(paragraph.style.outline, "", "a composing Escape belongs to the IME, not the card");
});

test("the Enter that confirms an IME conversion in WebKit leaves the annotation card open", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  textarea.value = "漢字";
  const listener = textarea.listeners.find((entry) => entry.type === "keydown");
  let prevented = false;
  // WebKit fires compositionend before this keydown, so only keyCode 229 marks it as the IME's.
  listener.handler({ key: "Enter", isComposing: false, keyCode: 229, preventDefault: () => (prevented = true) });

  assert.equal(prevented, false, "the IME keeps its Enter");
  assert.notEqual(paragraph.style.outline, "", "the card stays open");
});

test("Escape leaves an annotation card with typed text open and untouched", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const textarea = sdk.card().querySelector("textarea");
  textarea.value = "keep this note";
  pressEscape(textarea);

  assert.notEqual(paragraph.style.outline, "", "the card is still open, so the highlight remains");
  assert.equal(textarea.value, "keep this note", "Escape never discards the typed text");
});

test("Escape leaves an annotation card with an in-flight attachment open, even with no text", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  sdk.click(paragraph);
  const card = sdk.card();
  const attachInput = card.querySelector(".lavish-attach-input");
  // Never resolves - only the synchronous "uploading" status addFiles sets is needed here.
  attachInput.files = [{ name: "shot.png", type: "image/png", size: 10, arrayBuffer: () => new Promise(() => {}) }];
  const changeListener = attachInput.listeners.find((entry) => entry.type === "change");
  assert.ok(changeListener, "the attach input registers a change listener");
  changeListener.handler();

  pressEscape(card.querySelector("textarea"));

  assert.notEqual(
    paragraph.style.outline,
    "",
    "an attachment mid-upload is unsent content, so Escape must not close the card",
  );
});

// The chrome cannot see into this document, so a draft whose anchor is gone is only ever retired
// if the SDK says so. Silence left it to be retried against every later load.
test("the served SDK bundle reports a draft whose anchor the artifact no longer has", () => {
  const sdk = bootSdk();

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  // The load event proves the document parsed, not that it finished rendering, so nothing is
  // reported until the anchor has had time to appear.
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );

  sdk.runTimers();
  const report = sdk.posted.at(-1);
  assert.equal(report.type, "lavish:reviewDraftUnrestorable");
  assert.equal(report.selector, "#hero");
  assert.equal(report.artifact_load_token, "load-token");
});

// A section this page builds in script, or a Mermaid diagram, is not in the document when it
// loads. Reporting that as a missing anchor is how a live draft gets thrown away.
test("the served SDK bundle restores a draft whose anchor arrives after the load", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
    "an anchor that arrived late is restored, not reported gone",
  );
  assert.equal(sdk.card().querySelector("textarea").value, "needs a shorter headline");
});

test("the served SDK bundle reports nothing when there is no draft to restore", () => {
  const sdk = bootSdk();
  const before = sdk.posted.length;

  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: { card: null, fields: [] } });
  sdk.sendChromeMessage({ type: "lavish:restoreReviewState", state: { card: { selector: "#hero", text: "  " } } });
  sdk.runTimers();

  assert.equal(sdk.posted.length, before);
});

// `showAnnotationCard` closes whatever card is open before it draws, so a late restore landing on
// a card the user opened inside the settle window would delete text they are still typing - text
// no report has carried to the chrome yet.
test("the served SDK bundle leaves a card the user opened alone when the anchor arrives late", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector("textarea").value = "typing something new";
  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(sdk.card().querySelector("textarea").value, "typing something new");
  // The draft is still stored on the chrome side, so a later load can try again; nothing here
  // claims the anchor is gone either.
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );
});

// Cancelling a card reports `card: null`, which is what retires the stored draft on the chrome
// side. A late restore firing after that cancel would draw text the chrome no longer holds and
// report it back as a live draft, so the card the user dismissed reappears with someone else's
// text in it.
test("the served SDK bundle drops a late restore once the user has opened a card of their own", () => {
  const sdk = bootSdk();
  let late = null;
  sdk.setDocumentQuery((selector) => (selector === "#hero" ? late : null));

  sdk.sendChromeMessage({
    type: "lavish:restoreReviewState",
    state: { card: { selector: "#hero", text: "needs a shorter headline" }, fields: [] },
  });

  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  sdk.card().querySelector(".lavish-cancel").onclick();
  const cardsAfterCancel = sdk.cards().length;

  late = appendTo(sdk.body, cell("h1", "Headline"));
  sdk.runTimers();

  assert.equal(sdk.cards().length, cardsAfterCancel, "the cancelled card is not replaced by a restored one");
  assert.notEqual(sdk.card().querySelector("textarea").value, "needs a shorter headline");
  assert.equal(
    sdk.posted.some((message) => message.type === "lavish:reviewDraftUnrestorable"),
    false,
  );
});

test("clicking an element with a queued note asks the chrome to edit it instead of opening a card", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  const queued = sdk.queue("Reword this");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  // The stub shadow root keeps closed cards, so a new card shows as a higher count.
  const cardsBefore = sdk.cards().length;

  sdk.click(paragraph);

  assert.equal(sdk.cards().length, cardsBefore);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.selector);
  assert.equal(message.artifact_load_token, "load-token");
});

test("an element whose queued note left the queue opens a fresh card again", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  const queued = sdk.queue("Reword this");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [] });
  const cardsBefore = sdk.cards().length;

  sdk.click(paragraph);

  assert.equal(sdk.cards().length, cardsBefore + 1);
});

test("the chrome can hand an element click back for a fresh card", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.setDocumentQuery((selector) => (selector === "body > p" ? paragraph : null));

  sdk.sendChromeMessage({ type: "lavish:annotateElement", selector: "body > p" });

  assert.match(sdk.card().innerHTML, /Annotate &lt;p&gt;/);
});

// A Mermaid node as the SDK sees one: a `<g class="node">` inside an SVG Mermaid rendered.
function buildMermaidNode(sdk) {
  const svg = appendTo(sdk.body, createElement("svg"));
  svg.id = "mermaid-1";
  const node = appendTo(svg, createElement("g"));
  node.id = "flowchart-A-0";
  const matchesTag = node.matches;
  node.matches = (selectorList) =>
    String(selectorList)
      .split(",")
      .some((part) => part.trim() === "g.node") || matchesTag(selectorList);
  const label = appendTo(node, cell("span", "Start"));
  const shape = appendTo(node, createElement("rect"));
  return { label, shape };
}

test("a note queued from a diagram node's label opens again from the node's shape", () => {
  const sdk = bootSdk();
  const { label, shape } = buildMermaidNode(sdk);
  sdk.click(label);
  const queued = sdk.queue("Rename this step");
  sdk.sendChromeMessage({
    type: "lavish:queuedAnchors",
    selectors: [queued.prompt.selector, queued.prompt.target.selector],
  });
  const cardsBefore = sdk.cards().length;

  sdk.click(shape);

  assert.equal(sdk.cards().length, cardsBefore);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.target.selector);
});

test("a click inside a table cell opens only the note on the exact element clicked", () => {
  const sdk = bootSdk();
  const { evidence } = buildTable(sdk);
  const strong = appendTo(evidence, cell("strong", "Drive"));
  const em = appendTo(evidence, cell("em", "Cursor"));
  sdk.click(evidence);
  const cellNote = sdk.queue("Explain this cell");
  sdk.click(strong);
  const strongNote = sdk.queue("Explain this app");
  sdk.sendChromeMessage({
    type: "lavish:queuedAnchors",
    selectors: [cellNote.prompt.selector, strongNote.prompt.selector],
  });
  const cardsBefore = sdk.cards().length;

  sdk.click(em);

  assert.equal(sdk.cards().length, cardsBefore + 1);
  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor");
});

// In annotate mode a plain click on a link annotates it, so Ctrl-click (Cmd-click on macOS) is the
// way to follow the link without leaving annotate mode: the SDK steps aside and the browser opens it.
function buildLink(sdk) {
  const link = appendTo(sdk.body, cell("a", "Read the spec"));
  link.setAttribute("href", "https://example.com/spec");
  const inner = appendTo(link, cell("span", "spec"));
  return { link, inner };
}

// The follow modifier is the platform's own: Cmd on macOS, Ctrl elsewhere. Meta on Linux/Windows
// is the Super/Windows key, which is not a link-follow gesture there, so it annotates like a plain click.
for (const [platform, modifier] of [
  ["MacIntel", "metaKey"],
  ["Linux x86_64", "ctrlKey"],
  ["Win32", "ctrlKey"],
]) {
  test(`${modifier}-click on a link on ${platform} follows the link instead of annotating`, () => {
    const sdk = bootSdk({ platform });
    const { link, inner } = buildLink(sdk);

    for (const target of [link, inner]) {
      const event = sdk.click(target, { [modifier]: true });
      assert.equal(event.defaultPrevented, false, "the browser's own link handling runs");
    }
    assert.equal(sdk.cards().length, 0);
  });
}

for (const [platform, modifier] of [
  ["Linux x86_64", "metaKey"],
  ["Win32", "metaKey"],
  ["MacIntel", "ctrlKey"],
]) {
  test(`${modifier}-click on a link on ${platform} annotates like a plain click`, () => {
    const sdk = bootSdk({ platform });
    const { link } = buildLink(sdk);

    const event = sdk.click(link, { [modifier]: true });

    assert.equal(event.defaultPrevented, true, "the SDK keeps the frame from navigating");
    assert.match(sdk.card().innerHTML, /Annotate &lt;a&gt;/);
  });
}

test("a plain click on a link in annotate mode still opens an annotation card", () => {
  const sdk = bootSdk();
  const { link } = buildLink(sdk);

  const event = sdk.click(link);

  assert.equal(event.defaultPrevented, true);
  assert.match(sdk.card().innerHTML, /Annotate &lt;a&gt;/);
});

test("a modified click on something that is not a link still annotates", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));

  const event = sdk.click(paragraph, { ctrlKey: true });

  assert.equal(event.defaultPrevented, true);
  assert.match(sdk.card().innerHTML, /Annotate &lt;p&gt;/);
});

test("Ctrl-click follows a link even when the link already has a queued note", () => {
  const sdk = bootSdk();
  const { link } = buildLink(sdk);
  sdk.click(link);
  const queued = sdk.queue("Is this the right spec?");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const postedBefore = sdk.posted.length;

  const event = sdk.click(link, { ctrlKey: true });

  assert.equal(event.defaultPrevented, false);
  assert.equal(
    sdk.posted.slice(postedBefore).some((message) => message.type === "lavish:editQueuedAnchor"),
    false,
  );
});

test("Ctrl-click on a link after a text selection does not eat the next plain click", () => {
  const sdk = bootSdk();
  const { link } = buildLink(sdk);
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.selectText(paragraph, "prose");
  assert.match(sdk.card().innerHTML, /Annotate text/, "the selection opens a text annotation card");

  const followed = sdk.click(link, { ctrlKey: true });
  assert.equal(followed.defaultPrevented, false);

  sdk.click(paragraph);

  assert.match(sdk.card().innerHTML, /Annotate &lt;p&gt;/);
});

test("an answer queued through window.lavish gets a check beside its control once the chrome has it", () => {
  const sdk = bootSdk();
  const button = appendTo(sdk.body, createElement("button"));

  sdk.api.queuePrompt("Use the Pro plan", { element: button, queueKey: "plan" });
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:queuePrompt");
  assert.equal(message.prompt._lavishAck, "q1");

  sdk.sendChromeMessage({ type: "lavish:promptQueued", ack: "q2" });
  assert.equal(queuedChecks(sdk).length, 0, "an ack the SDK never issued draws nothing");
  sdk.sendChromeMessage({ type: "lavish:promptQueued", ack: "q1" });
  assert.equal(queuedChecks(sdk).length, 1);
  assert.match(queuedChecks(sdk)[0].innerHTML, /<span>Queued<\/span>/);
  sdk.sendChromeMessage({ type: "lavish:promptQueued", ack: "q1" });
  assert.equal(queuedChecks(sdk).length, 1, "each ack draws once");
});

test("a note queued from the annotation card carries no ack", () => {
  const sdk = bootSdk();
  const heading = appendTo(sdk.body, cell("h2", "Pricing"));
  sdk.click(heading);
  const message = sdk.queue("Bigger");
  assert.equal("_lavishAck" in message.prompt, false);
});

function queuedChecks(sdk) {
  return sdk.documentElement.children
    .flatMap((child) => child.shadowRoot?.children || [])
    .filter((child) => child.className === "lavish-queued-check");
}

test("the overlay takes the editor's preset accent, and only as plain oklch colors", () => {
  const sdk = bootSdk();
  const heading = appendTo(sdk.body, cell("h2", "Pricing"));
  sdk.click(heading);
  const host = sdk.documentElement.children.find((child) => child.shadowRoot);
  const props = new Map();
  host.style = { setProperty: (name, value) => props.set(name, value), removeProperty: (name) => props.delete(name) };

  sdk.sendChromeMessage({
    type: "lavish:theme",
    theme: "dark",
    accent: { light: "oklch(0.52 0.12 152)", dark: "oklch(0.54 0.12 152)" },
  });
  assert.equal(props.get("--primary"), "light-dark(oklch(0.52 0.12 152), oklch(0.54 0.12 152))");

  sdk.sendChromeMessage({
    type: "lavish:theme",
    theme: "dark",
    accent: { light: "red;background:url(x)", dark: "oklch(0.5 0.1 1)" },
  });
  assert.equal(props.has("--primary"), false, "anything else falls back to Lavish's own rose");
});

function autoThemeStyle(sdk) {
  return sdk.documentElement.children
    .flatMap((child) => [child, ...(child.children || [])])
    .find((node) => node.getAttribute?.("data-lavish-ui") === "auto-theme");
}

test("a lavish-auto page follows the editor's mode and preset colors, and only as plain oklch colors", () => {
  const sdk = bootSdk();
  sdk.documentElement.setAttribute("data-theme", "lavish-auto");
  sdk.sendChromeMessage({
    type: "lavish:theme",
    theme: "dark",
    accent: { light: "oklch(0.52 0.12 152)", dark: "oklch(0.54 0.12 152)" },
    colors: {
      "--color-primary": ["oklch(0.52 0.12 152)", "oklch(0.54 0.12 152)"],
      "--color-base-100": ["red", "oklch(0.1 0 0)"],
      "background:url(x);--x": ["oklch(0.5 0 0)", "oklch(0.5 0 0)"],
    },
  });
  const style = autoThemeStyle(sdk);
  assert.equal(
    style.textContent,
    ':root[data-theme="lavish-auto"]{color-scheme:dark;--color-primary:light-dark(oklch(0.52 0.12 152),oklch(0.54 0.12 152))}',
  );

  sdk.sendChromeMessage({ type: "lavish:theme", theme: "light", accent: null, colors: null });
  assert.equal(
    style.textContent,
    ':root[data-theme="lavish-auto"]{color-scheme:light}',
    "Lavish keeps the inline palette",
  );
});

test("a page on any other theme is left alone", () => {
  const sdk = bootSdk();
  sdk.documentElement.setAttribute("data-theme", "lavish");
  sdk.sendChromeMessage({
    type: "lavish:theme",
    theme: "dark",
    accent: null,
    colors: { "--color-primary": ["oklch(0.5 0.1 1)", "oklch(0.5 0.1 1)"] },
  });
  assert.equal(autoThemeStyle(sdk), undefined);
});

function linkedPicture(sdk, href, attributes = {}) {
  const link = appendTo(sdk.body, createElement("a"));
  link.setAttribute("href", href);
  for (const [name, value] of Object.entries(attributes)) link.setAttribute(name, value);
  link.href = new URL(href, "http://127.0.0.1/artifact/abc/index.html").href;
  const image = appendTo(link, createElement("img"));
  image.setAttribute("alt", "Check-in email");
  Object.assign(image, { complete: true, naturalWidth: 680, src: "http://127.0.0.1/artifact/abc/thumb.png" });
  for (const node of [link, image]) Object.setPrototypeOf(node, sdk.Element.prototype);
  return image;
}

test("a picture linked to a picture file opens the viewer on the linked file instead of following the link", () => {
  const sdk = bootSdk();
  sdk.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: false });
  for (const attributes of [{}, { target: "_blank" }]) {
    const image = linkedPicture(sdk, "assets/check-in.en.680.jpg?v=2", attributes);
    const event = sdk.exploreClick(image);
    assert.equal(event.defaultPrevented, true, "the link is not followed");
    const message = sdk.posted.at(-1);
    assert.equal(message.type, "lavish:zoomImage");
    assert.equal(message.src, "http://127.0.0.1/artifact/abc/assets/check-in.en.680.jpg?v=2");
    assert.equal(message.alt, "Check-in email");
  }
});

test("the viewer's previous and next get each picture with its place in the page", () => {
  const sdk = bootSdk();
  const linked = linkedPicture(sdk, "assets/full.png");
  const plain = appendTo(sdk.body, createElement("img"));
  plain.setAttribute("alt", "Second");
  Object.assign(plain, { complete: true, naturalWidth: 400, src: "http://127.0.0.1/artifact/abc/second.png" });
  Object.setPrototypeOf(plain, sdk.Element.prototype);

  sdk.sendChromeMessage({ type: "lavish:zoomPicture", index: 1 });
  let message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:zoomImage");
  assert.equal(message.src, "http://127.0.0.1/artifact/abc/second.png");
  assert.equal(message.index, 1);
  assert.equal(message.count, 2);

  sdk.sendChromeMessage({ type: "lavish:zoomPicture", index: 0 });
  message = sdk.posted.at(-1);
  assert.equal(message.src, "http://127.0.0.1/artifact/abc/assets/full.png", "a linked picture shows its linked file");
  assert.equal(message.alt, linked.getAttribute("alt"));

  const before = sdk.posted.length;
  sdk.sendChromeMessage({ type: "lavish:zoomPicture", index: 5 });
  sdk.sendChromeMessage({ type: "lavish:zoomPicture", index: "1" });
  assert.equal(sdk.posted.length, before, "an index with no picture asks for nothing");
});

test("a picture linked to a page, or a download link, keeps its click", () => {
  const sdk = bootSdk();
  sdk.sendChromeMessage({ type: "lavish:setAnnotationMode", enabled: false });
  /** @type {Array<[string, Record<string, string>]>} */
  const links = [
    ["https://example.com/report", {}],
    ["assets/shot.png", { download: "" }],
    ["javascript:alert(1)//.png", {}],
  ];
  for (const [href, attributes] of links) {
    const before = sdk.posted.length;
    const event = sdk.exploreClick(linkedPicture(sdk, href, attributes));
    assert.equal(event.defaultPrevented, false, href);
    assert.equal(
      sdk.posted.slice(before).some((message) => message.type === "lavish:zoomImage"),
      false,
      href,
    );
  }
});

function scrollbarReset(sdk) {
  return sdk.documentElement.children
    .flatMap((child) => [child, ...(child.children || [])])
    .find((node) => node.getAttribute?.("data-lavish-ui") === "scrollbar-reset");
}

test("a DaisyUI page gets its root scrollbar-color reset, so the editor's scrollbar shows", () => {
  const daisy = createElement("link");
  const sdk = bootSdk({
    query: (selector) => (selector === 'link[rel~="stylesheet"][href*="daisyui"]' ? daisy : null),
  });
  const style = scrollbarReset(sdk);
  assert.ok(style, "the SDK adds the reset");
  assert.match(style.textContent, /^:root:root\{scrollbar-color:auto\}/);
  assert.match(style.textContent, /@supports \(-moz-appearance:none\)\{:root:root\{scrollbar-color:oklch/);
});

test("a page without DaisyUI keeps its own scrollbar-color", () => {
  assert.equal(scrollbarReset(bootSdk()), undefined);
});

function scrollbarStyles(sdk) {
  return sdk.documentElement.children[0].children.filter((node) =>
    String(node.getAttribute?.("data-lavish-ui") || "").startsWith("scrollbar"),
  );
}

function bootWithPageBackground(html, body) {
  const page = { head: null };
  const sdk = bootSdk({
    runAnimationFrames: true,
    query: (selector) =>
      selector === 'style[data-lavish-ui="scrollbar"]'
        ? page.head?.children.find((node) => node.getAttribute?.("data-lavish-ui") === "scrollbar")
        : null,
    computedStyle: (el, { documentElement, body: pageBody }) =>
      el === documentElement ? { backgroundColor: html } : el === pageBody ? { backgroundColor: body } : {},
  });
  page.head = sdk.documentElement.children[0];
  sdk.runTimers();
  return sdk;
}

test("the page's own scrollbar track takes the page's background, right after the editor's scrollbar", () => {
  const sdk = bootWithPageBackground("rgba(0, 0, 0, 0)", "rgb(20, 16, 22)");
  const styles = scrollbarStyles(sdk);
  assert.deepEqual(
    styles.map((node) => node.getAttribute("data-lavish-ui")),
    ["scrollbar", "scrollbar-track"],
    "after the transparent track it overrides, before anything the page styles itself",
  );
  assert.equal(
    styles[1].textContent,
    ":where(html,body)::-webkit-scrollbar-track,:where(html,body)::-webkit-scrollbar-corner{background-color:rgb(20, 16, 22)}",
  );
});

test("a page without a background keeps the transparent track, and only a plain colour is written", () => {
  assert.equal(scrollbarStyles(bootWithPageBackground("rgba(0, 0, 0, 0)", "transparent")).length, 1);
  assert.equal(scrollbarStyles(bootWithPageBackground("red}body{display:none", "")).length, 1);
  const html = scrollbarStyles(bootWithPageBackground("oklch(0.145 0.008 326)", "rgb(1, 2, 3)"));
  assert.match(html[1].textContent, /background-color:oklch\(0\.145 0\.008 326\)\}$/, "html's own background wins");
});

test("Ctrl+F in the page asks the editor for its find bar, and an empty search reports nothing found", () => {
  const sdk = bootSdk();
  const event = sdk.keydown({ key: "f", ctrlKey: true });
  assert.equal(event.defaultPrevented, true, "the browser's own find stays closed");
  assert.equal(sdk.posted.at(-1).type, "lavish:openFind");

  sdk.sendChromeMessage({ type: "lavish:find", query: "   ", direction: 0 });
  const result = sdk.posted.at(-1);
  assert.equal(result.type, "lavish:findResult");
  assert.equal(result.count, 0);
  assert.equal(result.index, -1);
});

test("every artifact gets the editor's themed scrollbar, at zero specificity so its own styles win", () => {
  const sdk = bootSdk();
  const style = sdk.documentElement.children
    .flatMap((child) => [child, ...(child.children || [])])
    .find((node) => String(node.textContent || "").includes("::-webkit-scrollbar"));
  assert.ok(style, "the SDK adds the scrollbar style");
  assert.match(style.textContent, /:where\(\*\)::-webkit-scrollbar\{width:10px;height:10px\}/);
  assert.match(style.textContent, /::-webkit-scrollbar-thumb:active\{background-color:var\(--lavish-accent,/);
  assert.match(style.textContent, /@supports \(-moz-appearance:none\)\{:where\(\*\)\{scrollbar-width:thin;/);
  assert.doesNotMatch(style.textContent, /(^|\})(html|body|\*)[{:]/, "no rule with real specificity");
});

test("the served SDK bundle sends a prompt's context data as TOON", () => {
  const sdk = bootSdk();
  const paragraph = appendTo(sdk.body, cell("p", "D20"));

  sdk.api.queuePrompt("D20 several parkings: Build routes per parking now, before the PR", {
    element: paragraph,
    tag: "choice",
    data: {
      question: "D20",
      answer: "Build routes per parking now, before the PR",
      note: "",
      items: [
        { id: "R-03", disposition: "must-address" },
        { id: "R-08", disposition: "nice, later" },
      ],
    },
  });

  assert.equal(
    sdk.posted.at(-1).prompt.prompt,
    [
      "D20 several parkings: Build routes per parking now, before the PR",
      "",
      "Context data:",
      "question: D20",
      // A comma is the delimiter, so this value is quoted.
      'answer: "Build routes per parking now, before the PR"',
      'note: ""',
      "items[2]{id,disposition}:",
      "  R-03,must-address",
      '  R-08,"nice, later"',
    ].join("\n"),
  );
});
