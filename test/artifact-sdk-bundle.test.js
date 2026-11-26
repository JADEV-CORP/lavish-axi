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
      const shadowRoot = createElement("shadow-root");
      // A new Reveal drops the previous marker by querying the shadow root for its class, so that
      // query answers with the markers actually appended there.
      shadowRoot.querySelectorAll = (selector) =>
        selector === ".lavish-reveal-marker"
          ? shadowRoot.children.filter((child) => child.className === "lavish-reveal-marker")
          : [];
      element.shadowRoot = shadowRoot;
      return shadowRoot;
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

// Resolves the `tag#id:nth-of-type(n) > ...` chains `selector()` emits against the stub tree, so a
// test can ask the SDK how many elements its own selector matches.
function queryChildChain(root, selectorText) {
  const parts = String(selectorText)
    .split(">")
    .map((part) => part.trim());
  const parsed = parts.map((part) => {
    const match = /^([a-z0-9-]+)(?:#([^:]+))?(?::nth-of-type\((\d+)\))?$/i.exec(part);
    return match ? { tag: match[1].toUpperCase(), id: match[2], nth: match[3] ? Number(match[3]) : null } : null;
  });
  if (parsed.some((part) => !part)) return [];
  const matchesPart = (node, part) => {
    if (!node || node.tagName !== part.tag) return false;
    if (part.id !== undefined && node.id !== part.id) return false;
    if (part.nth !== null) {
      const same = (node.parentElement?.children || []).filter((x) => x.tagName === node.tagName);
      if (same.indexOf(node) + 1 !== part.nth) return false;
    }
    return true;
  };
  const results = [];
  const visit = (node) => {
    let current = node;
    let ok = true;
    for (let index = parsed.length - 1; index >= 0; index -= 1) {
      if (!matchesPart(current, parsed[index])) {
        ok = false;
        break;
      }
      current = current.parentElement;
    }
    if (ok) results.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return results;
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
  structuralQueries = false,
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
        return structuralQueries ? queryChildChain(documentElement, selector) : [];
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
    document: sandbox.document,
    Element: sandbox.Element,
    posted,
    body,
    documentElement,
    api: sandbox.window.lavish,
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
    // The SDK checks `instanceof Element`, so a stub that must pass that check takes this prototype.
    asElement(stub) {
      return Object.setPrototypeOf(stub, sandbox.Element.prototype);
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
    // Runs only the queued animation frames (the harness schedules them as 0 ms timers), leaving
    // longer timers such as the reveal marker's removal queued.
    runFrames() {
      const pending = timers.filter((timer) => timer.ms === 0 && !timer.ran && !timer.cancelled);
      for (const timer of pending) {
        timer.ran = true;
        timer.fn();
      }
    },
    // Runs the queued timers of exactly `ms` milliseconds.
    runTimersOf(ms) {
      for (const timer of timers.filter((entry) => entry.ms === ms && !entry.ran && !entry.cancelled)) {
        timer.ran = true;
        timer.fn();
      }
    },
    revealMarkers() {
      return documentElement.children
        .flatMap((child) => child.shadowRoot?.children || [])
        .filter((child) => child.className === "lavish-reveal-marker");
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

// Reveal scrolls smoothly, so the target's rect only reaches its final place once the scroll
// settles. This target reports its pre-scroll rect until the test says the scroll has settled.
function bootRevealTarget() {
  const sdk = bootSdk({ runAnimationFrames: true });
  const scroll = { settled: false, reads: 0 };
  const target = sdk.asElement(appendTo(sdk.body, cell("section", "Revised block")));
  const calls = [];
  target.scrollIntoView = (options) => calls.push(options);
  target.getBoundingClientRect = () =>
    ++scroll.reads && scroll.settled
      ? { left: 40, top: 300, right: 640, bottom: 420, width: 600, height: 120 }
      : { left: 40, top: 2200, right: 640, bottom: 2320, width: 600, height: 120 };
  sdk.setDocumentQuery((selector) => (selector === "#revised" ? target : null));
  return { sdk, scroll, calls };
}

function assertMarkerAtSettledRect(sdk) {
  const markers = sdk.revealMarkers();
  assert.equal(markers.length, 1);
  assert.deepEqual(
    { left: markers[0].style.left, top: markers[0].style.top, width: markers[0].style.width },
    { left: "40px", top: "300px", width: "600px" },
    "the marker sits on the settled rect, not the pre-scroll one",
  );
}

test("reveal keeps the smooth scroll and moves the marker to the settled rect frame by frame", () => {
  const { sdk, scroll, calls } = bootRevealTarget();
  sdk.sendChromeMessage({ type: "lavish:revealElement", selector: "#revised" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].behavior, "smooth");
  scroll.settled = true;
  sdk.runFrames();
  assertMarkerAtSettledRect(sdk);
});

test("a reveal marker stops tracking once it is removed or replaced", () => {
  const { sdk, scroll } = bootRevealTarget();
  sdk.sendChromeMessage({ type: "lavish:revealElement", selector: "#revised" });
  sdk.sendChromeMessage({ type: "lavish:revealElement", selector: "#revised" });
  assert.equal(sdk.revealMarkers().length, 1, "a new reveal replaces the previous marker at once");
  const readsBeforeFrame = scroll.reads;
  sdk.runFrames();
  assert.equal(scroll.reads - readsBeforeFrame, 1, "a new reveal stops the previous one's frame loop");
  sdk.runTimersOf(2400);
  assert.equal(sdk.revealMarkers().length, 0);
  const readsAtRemoval = scroll.reads;
  sdk.runFrames();
  sdk.runFrames();
  assert.equal(scroll.reads, readsAtRemoval, "no frame re-reads the target after the marker is gone");
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
  const sdk = bootSdk({ structuralQueries: true });
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
  const sdk = bootSdk({ structuralQueries: true });
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

// The chrome hands a click on a node whose note is already sending back as `annotateElement` with
// the node's own selector, so a note can be queued from the `<g>` itself. A click on any of its
// shapes still finds that note: the node is one target however deep the click lands.
test("a note queued on a diagram node itself opens again from the node's shape", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const { label, shape } = buildMermaidNode(sdk);
  const node = label.parentElement;
  sdk.setDocumentQuery((selector) => (selector === "g#flowchart-A-0" ? node : null));
  sdk.sendChromeMessage({ type: "lavish:annotateElement", selector: "g#flowchart-A-0" });
  const queued = sdk.queue("Rename this step");
  assert.equal(queued.prompt.selector, queued.prompt.target.selector);
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(shape);

  assert.equal(sdk.cards().length, cardsBefore);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.selector);
});

// Every note inside a diagram node also answers to the node's selector, and the chrome opens the
// newest note carrying the selector it is given. A click on an element with its own note must
// name that note's selector, not the node's, or it would open a later note on another shape.
test("a click inside a diagram node reopens the clicked element's own note before the node's", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const { label, shape } = buildMermaidNode(sdk);
  const otherShape = appendTo(label.parentElement, createElement("path"));
  const notes = [];
  for (const [element, text] of [
    [shape, "Recolour this box"],
    [label, "Rename this step"],
    [otherShape, "Thicken this border"],
  ]) {
    sdk.click(element);
    notes.push(sdk.queue(text).prompt);
  }
  sdk.sendChromeMessage({
    type: "lavish:queuedAnchors",
    selectors: [...new Set(notes.flatMap((prompt) => [prompt.selector, prompt.target.selector]))],
  });

  sdk.click(label);

  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, notes[1].selector);
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

// #445: two structurally identical elements deeper than five levels used to share one selector,
// so clicking the second reopened the first one's queued note.
test("structurally identical deep elements get distinct selectors and their own notes", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const images = [];
  for (let index = 0; index < 2; index += 1) {
    let node = appendTo(sdk.body, createElement("section"));
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
    images.push(appendTo(node, createElement("img")));
  }

  sdk.click(images[0]);
  const first = sdk.queue("Swap this photo");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [first.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(images[1]);

  assert.equal(sdk.cards().length, cardsBefore + 1, "the second image opens a fresh card");
  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor");
  const second = sdk.queue("Crop this one");
  assert.notEqual(second.prompt.selector, first.prompt.selector);
  assert.deepEqual(queryChildChain(sdk.body.parentElement, first.prompt.selector), [images[0]]);
  assert.deepEqual(queryChildChain(sdk.body.parentElement, second.prompt.selector), [images[1]]);
});

// An id only stops the climb when it names one element: generated pages repeat ids.
test("a repeated id does not stop the selector climb", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const images = [];
  for (let index = 0; index < 2; index += 1) {
    const section = appendTo(sdk.body, createElement("section"));
    const card = appendTo(section, createElement("div"));
    card.id = "card";
    images.push(appendTo(card, createElement("img")));
  }

  sdk.click(images[0]);
  const first = sdk.queue("Swap this photo");
  sdk.click(images[1]);
  const second = sdk.queue("Crop this one");

  assert.notEqual(second.prompt.selector, first.prompt.selector);
  assert.deepEqual(queryChildChain(sdk.body.parentElement, first.prompt.selector), [images[0]]);
  assert.deepEqual(queryChildChain(sdk.body.parentElement, second.prompt.selector), [images[1]]);
});

// A chain that matches nothing in the document (here a detached subtree) is not unique either.
test("a selector matching no element keeps climbing", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const detached = createElement("main");
  const images = [];
  for (let index = 0; index < 2; index += 1) {
    let node = appendTo(detached, createElement("section"));
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
    images.push(appendTo(node, createElement("img")));
  }

  sdk.click(images[0]);
  const first = sdk.queue("Swap this photo");
  sdk.click(images[1]);
  const second = sdk.queue("Crop this one");

  assert.notEqual(second.prompt.selector, first.prompt.selector);
});

// In an HTML document a type selector matches an SVG element only in its own case, so a chain
// through `<foreignObject>` (Mermaid wraps every node label in one) must keep that case to name
// anything. The stubbed query below answers the way a browser does for the lowercased tag.
test("a selector through an SVG foreignObject keeps its case and names the clicked element", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const svg = appendTo(appendTo(sdk.body, createElement("section")), createElement("svg"));
  const foreignObject = appendTo(svg, createElement("foreignObject"));
  foreignObject.localName = "foreignObject";
  const label = appendTo(
    appendTo(appendTo(foreignObject, createElement("div")), createElement("p")),
    createElement("span"),
  );
  const query = sdk.document.querySelectorAll;
  sdk.document.querySelectorAll = (selector) => (String(selector).includes("foreignobject") ? [] : query(selector));

  sdk.click(label);
  const queued = sdk.queue("Rename this step");

  assert.deepEqual(sdk.document.querySelectorAll(queued.prompt.selector), [label]);
});

// A queued note made before a structurally identical branch appeared must still
// reopen when its element is clicked, though that element's fresh selector is now longer.
test("a queued note reopens after an identical branch is added beside it", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const build = () => {
    let node = appendTo(sdk.body, createElement("section"));
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
    return appendTo(node, createElement("img"));
  };
  const original = build();
  sdk.click(original);
  const queued = sdk.queue("Swap this photo");
  const twin = build();
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(original);

  assert.equal(sdk.cards().length, cardsBefore);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.selector);

  // The new twin is not the element the note resolves to, so it opens a fresh card.
  sdk.click(twin);
  assert.equal(sdk.cards().length, cardsBefore + 1);
});

// `snapshot()` reads only uid/tag/text, so it must not build selectors, whose
// uniqueness checks query the whole document once per element.
test("snapshot does not query the document for selector uniqueness", () => {
  const sdk = bootSdk({ structuralQueries: true });
  for (let index = 0; index < 3; index += 1) {
    let node = appendTo(sdk.body, createElement("section"));
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
  }
  // The stub Element class matches nothing; let snapshot()'s walk see the stub elements.
  Object.defineProperty(sdk.Element, Symbol.hasInstance, { value: (value) => Boolean(value?.tagName) });
  const queries = [];
  const realQuery = sdk.document.querySelectorAll;
  sdk.document.querySelectorAll = (selector) => {
    queries.push(selector);
    return realQuery(selector);
  };

  sdk.sendChromeMessage({ type: "lavish:requestSnapshot", snapshot_request_id: "s-1" });

  const response = sdk.posted.at(-1);
  assert.equal(response.type, "lavish:snapshot");
  assert.match(response.snapshot, /section/);
  assert.deepEqual(queries, []);
});

// An identical branch inserted *before* the annotated one makes the queued selector's
// first match the new copy. The note must still follow the element it was queued from.
test("a queued note follows its element when an identical branch is inserted before it", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const build = () => {
    const section = appendTo(sdk.body, createElement("section"));
    let node = section;
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
    return { section, img: appendTo(node, createElement("img")) };
  };
  const original = build().img;
  sdk.click(original);
  const queued = sdk.queue("Swap this photo");
  const copy = build();
  sdk.body.children.splice(sdk.body.children.indexOf(copy.section), 1);
  sdk.body.children.unshift(copy.section);
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(copy.img);
  assert.equal(sdk.cards().length, cardsBefore + 1);
  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor");

  sdk.click(original);
  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, queued.prompt.selector);
});

// Two notes on one element whose selector changed between them: the chrome lists selectors oldest
// note first and opens the newest note carrying the selector it gets, so a click must name the
// newer note's selector, as it did when the click sent the element's fresh selector.
test("a click reopens the newer of two notes queued on one element whose selector changed", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.api.queuePrompt("Reword this", { element: paragraph, queueKey: "" });
  const older = sdk.posted.at(-1).prompt;
  const inserted = cell("p", "Inserted above");
  inserted.parentElement = sdk.body;
  sdk.body.children.unshift(inserted);
  sdk.api.queuePrompt("Shorten this", { element: paragraph, queueKey: "" });
  const newer = sdk.posted.at(-1).prompt;
  assert.notEqual(newer.selector, older.selector);
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [older.selector, newer.selector] });

  sdk.click(paragraph);

  const message = sdk.posted.at(-1);
  assert.equal(message.type, "lavish:editQueuedAnchor");
  assert.equal(message.selector, newer.selector);
});

// A note the chrome cannot open (it is Sending) answers the reopen click with
// `lavish:annotateElement` and the note's stored selector. The fresh card must open on the
// element the note was queued from, not on the inserted copy that selector now matches first.
test("a fresh card for a note that cannot open lands on its element, not the copy its selector now names first", () => {
  const sdk = bootSdk({ structuralQueries: true });
  sdk.setDocumentQuery((selector) => queryChildChain(sdk.body.parentElement, selector)[0] ?? null);
  const build = () => {
    const section = appendTo(sdk.body, createElement("section"));
    let node = section;
    for (let depth = 0; depth < 4; depth += 1) node = appendTo(node, createElement("div"));
    return { section, img: appendTo(node, createElement("img")) };
  };
  const original = build().img;
  sdk.click(original);
  const queued = sdk.queue("Swap this photo");
  const copy = build();
  sdk.body.children.splice(sdk.body.children.indexOf(copy.section), 1);
  sdk.body.children.unshift(copy.section);
  assert.equal(queryChildChain(sdk.body.parentElement, queued.prompt.selector)[0], copy.img);

  sdk.sendChromeMessage({ type: "lavish:annotateElement", selector: queued.prompt.selector });
  const fresh = sdk.queue("Crop this one");

  assert.deepEqual(queryChildChain(sdk.body.parentElement, fresh.prompt.selector), [original]);
});

// After a reload the frame has no record of which element a note came from, so the note falls
// back to its selector and the element that selector names reopens it.
test("after a reload a queued note reopens on the element its selector names", () => {
  const before = bootSdk({ structuralQueries: true });
  before.click(appendTo(before.body, cell("p", "Just prose")));
  const queued = before.queue("Reword this");
  const sdk = bootSdk({ structuralQueries: true });
  const reloaded = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(reloaded);

  assert.equal(sdk.cards().length, cardsBefore);
  assert.equal(sdk.posted.at(-1).type, "lavish:editQueuedAnchor");
  assert.equal(sdk.posted.at(-1).selector, queued.prompt.selector);
});

// After a reload the stored selector may be written differently from the selector the page now
// builds for the same element. It still reopens the note when it names that one element alone.
test("after a reload a queued selector that names only the clicked element reopens its note", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: ["body > p"] });
  const cardsBefore = sdk.cards().length;

  sdk.click(paragraph);

  assert.equal(sdk.cards().length, cardsBefore);
  assert.equal(sdk.posted.at(-1).type, "lavish:editQueuedAnchor");
  assert.equal(sdk.posted.at(-1).selector, "body > p");
});

// A text note is about the words, so no click reopens it, and it must not take over an element
// note's selector string either. After a reorder hands that string to another element, a text note
// queued inside that element would otherwise make a click there reopen the other element's note.
test("a text note queued inside an element does not make a click there reopen another element's note", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const moved = appendTo(sdk.body, cell("p", "First"));
  const other = appendTo(sdk.body, cell("p", "Second"));
  sdk.click(moved);
  const elementNote = sdk.queue("Reword this");
  sdk.body.children.reverse();
  sdk.selectText(other, "Second");
  // The drag-select's own click, which the SDK swallows.
  sdk.click(other);
  sdk.queue("Fix this wording");
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [elementNote.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(other);

  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor", "the text note reopened another element's note");
  assert.equal(sdk.cards().length, cardsBefore + 1);
});

// Once a queued note's element is removed from the page, a different element that
// now matches its stored selector must not reopen that note; it opens a fresh card instead.
test("a queued note whose element was removed does not reopen on the element now matching its selector", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const paragraph = appendTo(sdk.body, cell("p", "Just prose"));
  sdk.click(paragraph);
  const queued = sdk.queue("Reword this");
  paragraph.isConnected = false;
  sdk.body.children.splice(sdk.body.children.indexOf(paragraph), 1);
  const other = appendTo(sdk.body, cell("p", "Other text"));
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  const cardsBefore = sdk.cards().length;

  sdk.click(other);

  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor", "another element reopened the note");
  assert.equal(sdk.cards().length, cardsBefore + 1);
});

// After a reload the page has no record of which element a note came from, so its selector only
// reopens it when that selector names exactly one element, the one clicked.
test("after a reload a queued selector reopens its note only when it names exactly the clicked element", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const first = appendTo(sdk.body, cell("p", "Just prose"));
  appendTo(sdk.body, cell("p", "Just prose"));
  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: ["body > p"] });
  const cardsBefore = sdk.cards().length;

  sdk.click(first);

  assert.notEqual(sdk.posted.at(-1)?.type, "lavish:editQueuedAnchor", "an ambiguous selector reopened the note");
  assert.equal(sdk.cards().length, cardsBefore + 1);
});

// Deep repeated structure can climb past 300 chars. The queued prompt keeps the whole
// selector, it still names only the clicked element, and a click on it reopens the note.
test("a selector longer than 300 chars is queued whole and still reopens its note", () => {
  const sdk = bootSdk({ structuralQueries: true });
  const images = [];
  for (let index = 0; index < 2; index += 1) {
    let node = appendTo(sdk.body, createElement("section"));
    for (let depth = 0; depth < 60; depth += 1) node = appendTo(node, createElement("div"));
    images.push(appendTo(node, createElement("img")));
  }
  sdk.click(images[1]);
  const queued = sdk.queue("Swap this photo");

  assert.ok(queued.prompt.selector.length > 300, `selector is ${queued.prompt.selector.length} chars`);
  assert.deepEqual(queryChildChain(sdk.body.parentElement, queued.prompt.selector), [images[1]]);

  sdk.sendChromeMessage({ type: "lavish:queuedAnchors", selectors: [queued.prompt.selector] });
  sdk.click(images[1]);
  assert.equal(sdk.posted.at(-1).type, "lavish:editQueuedAnchor");
  assert.equal(sdk.posted.at(-1).selector, queued.prompt.selector);
});

// A Mermaid node's target carries its own selector, so snapshot() must not build
// that one either; tag and text still come from the node.
test("snapshot does not query the document for a diagram node's selector", () => {
  const sdk = bootSdk({ structuralQueries: true });
  buildMermaidNode(sdk);
  Object.defineProperty(sdk.Element, Symbol.hasInstance, { value: (value) => Boolean(value?.tagName) });
  const queries = [];
  const realQuery = sdk.document.querySelectorAll;
  sdk.document.querySelectorAll = (selector) => {
    queries.push(selector);
    return realQuery(selector);
  };

  sdk.sendChromeMessage({ type: "lavish:requestSnapshot", snapshot_request_id: "s-1" });

  const response = sdk.posted.at(-1);
  assert.equal(response.type, "lavish:snapshot");
  assert.match(response.snapshot, /mermaid-node/);
  assert.match(response.snapshot, /Start/);
  assert.deepEqual(queries, []);
});

test("setDocumentMeta posts the title and icon the page asked for, stamped with the load token", () => {
  const sdk = bootSdk();
  sdk.api.setDocumentMeta({ title: "(1) Board", icon: "data:image/svg+xml,<svg/>" });
  const message = sdk.posted.find((entry) => entry.type === "lavish:documentMeta");
  assert.deepEqual(
    { ...message },
    {
      type: "lavish:documentMeta",
      title: "(1) Board",
      icon: "data:image/svg+xml,<svg/>",
      artifact_load_token: "load-token",
    },
  );
});

test("setDocumentMeta forwards null to restore, omits unset fields and drops non-strings", () => {
  const sdk = bootSdk();
  sdk.api.setDocumentMeta({ title: null });
  sdk.api.setDocumentMeta({ icon: 42, title: { toString: () => "x" } });
  sdk.api.setDocumentMeta();
  const messages = sdk.posted.filter((entry) => entry.type === "lavish:documentMeta");
  assert.deepEqual(
    messages.map((entry) => JSON.parse(JSON.stringify({ title: entry.title, icon: entry.icon }))),
    [{ title: null }, {}, {}],
  );
});

test("the served SDK bundle relays page storage through the chrome and resolves its answer", async () => {
  const sdk = bootSdk();
  const saved = sdk.api.store.set("draft", { lines: 2 });
  const request = sdk.posted.at(-1);
  assert.equal(request.type, "lavish:pageApp");
  assert.equal(request.op, "store.set");
  assert.equal(request.json, '{"lines":2}');
  assert.equal(request.artifact_load_token, "load-token");
  assert.equal(typeof request.nonce, "string");

  sdk.sendChromeMessage({ type: "lavish:pageAppResult", id: request.id, nonce: request.nonce, ok: true });
  assert.equal(await saved, undefined);

  const read = sdk.api.store.get("draft");
  const get = sdk.posted.at(-1);
  sdk.sendChromeMessage({
    type: "lavish:pageAppResult",
    id: get.id,
    nonce: get.nonce,
    ok: true,
    value: { found: true, value: { lines: 2 } },
  });
  assert.deepEqual(await read, { lines: 2 });
});

test("the served SDK bundle exposes ask, files.pick and download beside store", () => {
  const sdk = bootSdk();
  assert.equal(typeof sdk.api.ask, "function");
  assert.equal(typeof sdk.api.files.pick, "function");
  assert.equal(typeof sdk.api.download, "function");
  assert.deepEqual(Object.keys(sdk.api.store).sort(), ["delete", "get", "list", "set"]);
});

test("the served SDK bundle asks one question at a time and resolves the agent's answer", async () => {
  const sdk = bootSdk();
  const answer = sdk.api.ask("Which plan?", { data: { plans: ["A", "B"] }, timeoutMs: 1 });
  const request = sdk.posted.at(-1);
  assert.equal(request.op, "ask");
  assert.equal(request.question, "Which plan?");
  assert.equal(request.context, "plans[2]: A,B");
  // Clamped to the shortest wait a page may ask for.
  assert.equal(request.timeout_ms, 10000);
  await assert.rejects(sdk.api.ask("Another?"), { code: "ASK_BUSY" });

  sdk.sendChromeMessage({
    type: "lavish:pageAppResult",
    id: request.id,
    nonce: request.nonce,
    pending: true,
    wait_ms: 25000,
  });
  sdk.sendChromeMessage({
    type: "lavish:pageAppResult",
    id: request.id,
    nonce: request.nonce,
    ok: true,
    value: "Plan B.",
  });
  assert.equal(await answer, "Plan B.");

  // The page may ask again once the answer is in.
  const next = sdk.api.ask("And the price?");
  const second = sdk.posted.at(-1);
  sdk.sendChromeMessage({
    type: "lavish:pageAppResult",
    id: second.id,
    nonce: second.nonce,
    ok: false,
    code: "NO_AGENT",
    error: "No agent is listening to this page.",
  });
  await assert.rejects(next, { code: "NO_AGENT", message: "No agent is listening to this page." });
});
