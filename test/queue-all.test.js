import assert from "node:assert/strict";
import test from "node:test";

import {
  appendNote,
  batchSummaryPrompt,
  copyAllText,
  fallbackAnswerPrompt,
  formatAnswerLines,
  hasOwnNoteField,
  isQueueAllOff,
  queueAllButtonLabel,
  queueAllStatusText,
  questionSubmitter,
  questionTitle,
  readQuestionFields,
  summarizeQuestions,
  topLevelQuestionScopes,
} from "../src/queue-all.js";

// A small element stub: enough DOM for the helpers, which only read tags, attributes, values and
// ancestry. `closest` understands the two attribute selectors the helpers ask for.
function el(tag, attrs = {}, props = {}) {
  /** @type {any} */
  const node = {
    tagName: tag.toUpperCase(),
    parentElement: null,
    children: [],
    attrs,
    // Like the DOM, an input's value property starts as its value attribute.
    value: attrs.value,
    ...props,
    getAttribute(name) {
      return Object.hasOwn(node.attrs, name) ? node.attrs[name] : null;
    },
    closest(selector) {
      for (let current = node; current; current = current.parentElement) {
        if (selector === "[data-lavish-question]" && current.getAttribute("data-lavish-question") !== null)
          return current;
        if (selector === "[data-lavish-ui]" && current.getAttribute("data-lavish-ui") !== null) return current;
        if (selector === "fieldset[disabled]" && current.tagName === "FIELDSET" && current.disabled) return current;
      }
      return null;
    },
    descendants() {
      return node.children.flatMap((child) => [child, ...child.descendants()]);
    },
    querySelectorAll(selector) {
      const all = node.descendants();
      if (selector === "[data-lavish-question]")
        return all.filter((d) => d.getAttribute("data-lavish-question") !== null);
      if (selector === "input, select, textarea")
        return all.filter((d) => ["INPUT", "SELECT", "TEXTAREA"].includes(d.tagName));
      if (selector === "button") return all.filter((d) => d.tagName === "BUTTON");
      if (selector === "[data-lavish-submit]") return all.filter((d) => d.getAttribute("data-lavish-submit") !== null);
      if (selector === 'button[type="submit"], input[type="submit"]')
        return all.filter((d) => ["BUTTON", "INPUT"].includes(d.tagName) && d.getAttribute("type") === "submit");
      if (selector === "button:not([type])")
        return all.filter((d) => d.tagName === "BUTTON" && d.getAttribute("type") === null);
      throw new Error("unexpected selector " + selector);
    },
    querySelector(selector) {
      return node.querySelectorAll(selector)[0] || null;
    },
  };
  return node;
}

function append(parent, ...children) {
  for (const child of children) {
    child.parentElement = parent;
    parent.children.push(child);
  }
  return parent;
}

test("the bar is off only when the page says so", () => {
  for (const value of ["off", "OFF", " false ", "none", "0"]) assert.equal(isQueueAllOff(value), true, value);
  for (const value of [null, undefined, "", "on", "auto"]) assert.equal(isQueueAllOff(value), false, String(value));
});

test("questions are counted once, nested scopes and Lavish UI left out", () => {
  const body = el("body");
  const c1 = el("form", { "data-lavish-question": "C1" });
  const nested = el("div", { "data-lavish-question": "C1-detail" });
  append(c1, nested);
  const c2 = el("div", { "data-lavish-question": "C2" });
  const ui = append(el("div", { "data-lavish-ui": "queue-all" }), el("div", { "data-lavish-question": "fake" }));
  append(body, c1, c2, ui);
  assert.deepEqual(
    topLevelQuestionScopes(body).map((scope) => scope.getAttribute("data-lavish-question")),
    ["C1", "C2"],
  );
  assert.deepEqual(topLevelQuestionScopes(null), []);
});

test("an answer reads checked choices, text and selects, and skips the rest", () => {
  const form = el("form", { "data-lavish-question": "plan" });
  append(
    form,
    el("input", { type: "radio", name: "plan", value: "Starter" }, { checked: false }),
    el("input", { type: "radio", name: "plan", value: "Pro" }, { checked: true }),
    el(
      "input",
      { type: "checkbox", name: "extras", value: "" },
      { checked: true, labels: [{ textContent: "  Annual   billing " }] },
    ),
    el("input", { type: "text", name: "blank" }, { value: "   " }),
    el("input", { type: "hidden", name: "secret" }, { value: "x" }),
    el("input", { type: "text", name: "off" }, { value: "ignored", disabled: true }),
    el("textarea", { name: "note" }, { value: "line one\nline two" }),
    el(
      "select",
      { name: "when" },
      {
        selectedOptions: [
          { value: "Q1", disabled: false },
          { value: "Q9", disabled: true },
        ],
      },
    ),
    el("button", { type: "submit" }),
  );
  const nested = el("div", { "data-lavish-question": "inner" });
  append(nested, el("input", { type: "text", name: "inner" }, { value: "belongs to inner" }));
  append(form, nested);

  assert.deepEqual(readQuestionFields(form), [
    { label: "plan", value: "Pro" },
    { label: "extras", value: "Annual billing" },
    { label: "note", value: "line one\nline two" },
    { label: "when", value: "Q1" },
  ]);
  assert.deepEqual(formatAnswerLines(readQuestionFields(form)), [
    "plan: Pro",
    "extras: Annual billing",
    "note: line one\n    line two",
    "when: Q1",
  ]);
});

test("a question with nothing chosen reads as unanswered", () => {
  const form = el("form", { "data-lavish-question": "C3" });
  append(form, el("input", { type: "radio", name: "c3", value: "A" }, { checked: false }));
  assert.deepEqual(readQuestionFields(form), []);
});

test("the submitter is the explicit one, then submit, then a button that says it queues", () => {
  const explicit = el("button", { type: "button", "data-lavish-submit": "" });
  assert.equal(questionSubmitter(append(el("div"), el("button", { type: "submit" }), explicit)), explicit);

  const submit = el("button", { type: "submit" });
  assert.equal(questionSubmitter(append(el("form"), submit)), submit);

  const implicit = el("button");
  assert.equal(questionSubmitter(append(el("form"), implicit)), implicit);

  const worded = el("button", { type: "button" }, { textContent: "Queue answer" });
  assert.equal(
    questionSubmitter(append(el("div"), el("button", { type: "button" }, { textContent: "Show more" }), worded)),
    worded,
  );

  assert.equal(
    questionSubmitter(append(el("div"), el("button", { type: "button" }, { textContent: "Show more" }))),
    null,
  );
});

test("status and button labels say how many are answered and which are open", () => {
  const all = summarizeQuestions([
    { key: "C1", answered: true },
    { key: "C2", answered: true },
  ]);
  assert.deepEqual(all, { total: 2, answered: 2, missing: [] });
  assert.equal(queueAllButtonLabel(all), "Queue all 2 answers");
  assert.equal(queueAllStatusText(all), "2 of 2 answered.");

  const some = summarizeQuestions([
    { key: "C1", answered: true },
    { key: "C2", answered: false },
    { key: "C3", answered: false },
  ]);
  assert.equal(queueAllButtonLabel(some), "Queue 1 answer");
  assert.equal(queueAllStatusText(some), "1 of 3 answered. Open: C2, C3.");

  const none = summarizeQuestions([{ key: "C1", answered: false }]);
  assert.equal(queueAllButtonLabel(none), "Queue all answers");

  const many = summarizeQuestions(Array.from({ length: 9 }, (_, i) => ({ key: "Q" + i, answered: false })));
  assert.equal(queueAllStatusText(many), "0 of 9 answered. Open: Q0, Q1, Q2, Q3, Q4, Q5 and 3 more.");
  assert.equal(queueAllStatusText(summarizeQuestions([])), "");
});

test("the summary carries one short line per answer, so a pasted summary stands on its own", () => {
  assert.equal(fallbackAnswerPrompt("C2", ["c2: Yes", "note: ship it"]), "Answer to C2:\n  c2: Yes\n  note: ship it");
  assert.equal(
    batchSummaryPrompt(
      [
        { key: "L1", answer: "Yes", note: false },
        { key: "L4", answer: "x".repeat(120), note: true },
        { key: "S5", answer: "", note: true },
      ],
      ["C3"],
    ),
    "Queue all: 3 answers.\n- L1: Yes\n- L4: " +
      "x".repeat(87) +
      "... (with a note)\n- S5: note only (with a note)\nLeft open: C3.\nAct on every answer and account for each question ID before reporting completion.",
  );
  assert.match(batchSummaryPrompt([{ key: "C1", answer: "Go" }], []), /^Queue all: 1 answer\.\n- C1: Go\nAct/);
});

test("copy text names each question, keeps notes, and ends with the page note", () => {
  assert.equal(
    copyAllText(
      [
        { key: "C1", title: "Which film?", lines: ["c1: Yes"], note: "" },
        { key: "C2", title: "Language", lines: [], note: "" },
        { key: "C3", title: "", lines: [], note: "Ask the client first\nthen decide" },
      ],
      "Ship before Friday",
      "Release decisions",
    ),
    "Answers: Release decisions\n\nC1 · Which film?\n  c1: Yes\n\nC3\n  Note: Ask the client first\n    then decide\n\nNote for the whole page:\n  Ship before Friday",
  );
  assert.equal(copyAllText([{ key: "C1", lines: [] }]), "");
  assert.equal(copyAllText([], "Only a note"), "Note for the whole page:\n  Only a note");
});

test("a note rides on its prompt with its line breaks, and an empty one changes nothing", () => {
  assert.equal(appendNote("C1: Yes", "  first\nsecond  "), "C1: Yes\n\nNote from the reviewer:\nfirst\nsecond");
  assert.equal(appendNote("C1: Yes", "   "), "C1: Yes");
  assert.match(batchSummaryPrompt(["C1"], [], "Ship it"), /completion\.\n\nNote from the reviewer:\nShip it$/);
});

test("a question's title is its first heading, and a textarea of its own means no Lavish note", () => {
  const scope = el("form", { "data-lavish-question": "C1" });
  const heading = el("h3", {}, { textContent: "  C1 ·   Which film? " });
  scope.querySelector = (selector) => (selector.startsWith("h1") ? heading : null);
  assert.equal(questionTitle(scope), "C1 · Which film?");
  assert.equal(questionTitle(null), "");

  const withArea = append(el("form", { "data-lavish-question": "C2" }), el("textarea", {}, { disabled: false }));
  withArea.querySelectorAll = (selector) => (selector === "textarea" ? withArea.children : []);
  assert.equal(hasOwnNoteField(withArea), true);
  const withInput = append(el("form", { "data-lavish-question": "C3" }), el("input", { type: "text" }));
  withInput.querySelectorAll = (selector) => (selector === "textarea" ? [] : withInput.children);
  assert.equal(hasOwnNoteField(withInput), false);
});
