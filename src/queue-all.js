// Queue all: the bar Lavish adds at the end of every page that asks questions. Each
// `data-lavish-question` scope keeps its own Queue answer control; the bar runs all of them in one
// click, so the reviewer never depends on the author remembering a page-level button.
//
// createSdkJs serializes every export here into the SDK bundle, so this module exports functions
// only. A helper may use its own arguments, browser globals, and sibling exports, nothing else.

// `<html data-lavish-queue-all="off">` turns the bar off for a page that must not show it.
export function isQueueAllOff(value) {
  return ["off", "false", "none", "0"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

// Question scopes in document order. A scope nested in another belongs to its parent, and Lavish's
// own UI never counts.
export function topLevelQuestionScopes(root) {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return [...root.querySelectorAll("[data-lavish-question]")].filter(
    (el) => !el.parentElement?.closest?.("[data-lavish-question]") && !el.closest?.("[data-lavish-ui]"),
  );
}

// The answer a scope holds right now, as {label, value} pairs. Same reading rules as the input
// playbook's copy-all snippet: unchecked choices, disabled controls, buttons and blank text are
// left out, so an empty list means the question is unanswered.
export function readQuestionFields(scope) {
  const fields = [];
  if (!scope || typeof scope.querySelectorAll !== "function") return fields;
  const skipped = new Set(["button", "submit", "reset", "image", "hidden", "file", "range", "color", "password"]);
  for (const el of scope.querySelectorAll("input, select, textarea")) {
    if (el.disabled || el.closest?.("fieldset[disabled]")) continue;
    // A control inside a nested question belongs to that question.
    if (el.closest?.("[data-lavish-question]") !== scope) continue;
    const type = String(el.getAttribute?.("type") || el.type || "").toLowerCase();
    if (el.tagName === "INPUT" && skipped.has(type)) continue;
    const isChoice = type === "checkbox" || type === "radio";
    if (isChoice && !el.checked) continue;
    const labelText = el.labels?.[0]?.textContent?.trim().replace(/\s+/g, " ") || "";
    let values;
    if (el.tagName === "SELECT") {
      values = [...el.selectedOptions]
        .filter((option) => !option.disabled)
        .map((option) => String(option.value || option.textContent || "").trim())
        .filter(Boolean);
    } else {
      const raw = isChoice && !String(el.getAttribute?.("value") || "").trim() ? labelText : String(el.value ?? "");
      values = raw.trim() ? [raw.trim()] : [];
    }
    const label =
      el.getAttribute?.("name") ||
      labelText ||
      el.getAttribute?.("aria-label") ||
      el.getAttribute?.("placeholder") ||
      String(el.tagName || "field").toLowerCase();
    for (const value of values) fields.push({ label: String(label).slice(0, 120), value: value.slice(0, 4000) });
  }
  return fields;
}

// The control that sends one question's answer: an explicit data-lavish-submit, else the form's
// submit button, else a button whose words say it queues or submits.
export function questionSubmitter(scope) {
  if (!scope || typeof scope.querySelector !== "function") return null;
  const explicit = scope.querySelector("[data-lavish-submit]");
  if (explicit) return explicit;
  const submit = scope.querySelector('button[type="submit"], input[type="submit"]');
  if (submit) return submit;
  if (scope.tagName === "FORM") return scope.querySelector("button:not([type])");
  return (
    [...scope.querySelectorAll("button")].find((button) =>
      /\b(queue|submit|send|answer|confirm|valider|envoyer)\b/i.test(String(button.textContent || "")),
    ) || null
  );
}

// One line per field; a multi-line value keeps its lines, indented under the label.
export function formatAnswerLines(fields) {
  return (Array.isArray(fields) ? fields : []).map(
    (field) => `${field.label}: ${String(field.value).split("\n").join("\n    ")}`,
  );
}

export function summarizeQuestions(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const answered = list.filter((entry) => entry.answered).length;
  return {
    total: list.length,
    answered,
    missing: list.filter((entry) => !entry.answered).map((entry) => String(entry.key)),
  };
}

export function queueAllButtonLabel(summary) {
  if (!summary || !summary.answered) return "Queue all answers";
  if (summary.answered === 1) return "Queue 1 answer";
  return summary.answered === summary.total
    ? `Queue all ${summary.answered} answers`
    : `Queue ${summary.answered} answers`;
}

export function queueAllStatusText(summary) {
  if (!summary || !summary.total) return "";
  const count = `${summary.answered} of ${summary.total} answered`;
  if (!summary.missing.length) return `${count}.`;
  const shown = summary.missing.slice(0, 6).join(", ");
  const more = summary.missing.length > 6 ? ` and ${summary.missing.length - 6} more` : "";
  return `${count}. Open: ${shown}${more}.`;
}

// Used when a question has an answer but its page control queued nothing (no handler, or a
// wrapper without a button), so the answer still reaches the agent.
export function fallbackAnswerPrompt(key, lines) {
  return `Answer to ${key}:\n${(Array.isArray(lines) ? lines : []).map((line) => "  " + line).join("\n")}`;
}

// The closing note of a batch: one short line per question, so a pasted summary stands on its
// own, the questions the reviewer left open, and the note for the whole page. It repeats only the
// first answer line of each question, cut short, so it adds little to what the agent reads.
export function batchSummaryPrompt(answers, missing, pageNote = "") {
  const done = Array.isArray(answers) ? answers : [];
  const open = Array.isArray(missing) ? missing : [];
  const lines = done.map((entry) => {
    if (typeof entry === "string") return `- ${entry}`;
    const first = String(entry.answer || "").split("\n")[0];
    const short = first.length > 90 ? first.slice(0, 87) + "..." : first;
    return `- ${entry.key}: ${short || "note only"}${entry.note ? " (with a note)" : ""}`;
  });
  const parts = [`Queue all: ${done.length} answer${done.length === 1 ? "" : "s"}.`];
  if (lines.length) parts.push(lines.join("\n"));
  if (open.length) parts.push(`Left open: ${open.join(", ")}.`);
  parts.push("Act on every answer and account for each question ID before reporting completion.");
  return appendNote(parts.join("\n"), pageNote);
}

// The visible title of a question: its first heading, legend or card title. The ID alone is
// cryptic in a pasted answer, so Copy and prompts carry both.
export function questionTitle(scope) {
  if (!scope || typeof scope.querySelector !== "function") return "";
  const heading = scope.querySelector("h1, h2, h3, h4, h5, h6, legend, .card-title, [data-lavish-title]");
  return String(heading?.textContent || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

// True when the question already has its own multi-line field, so Lavish adds no note of its own.
export function hasOwnNoteField(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return false;
  return [...scope.querySelectorAll("textarea")].some(
    (area) => !area.disabled && area.closest?.("[data-lavish-question]") === scope,
  );
}

// A reviewer's note rides on the prompt it belongs to, with its line breaks kept.
export function appendNote(prompt, note) {
  const text = String(note || "").trim();
  if (!text) return String(prompt || "");
  return `${String(prompt || "")}\n\nNote from the reviewer:\n${text}`;
}

// Plain text of every answer, for the Copy control: what the reviewer pastes into the chat when
// Lavish cannot send. Each question shows its ID and title, its answer lines and its note; the
// note for the whole page comes last.
export function copyAllText(questions, pageNote = "", pageTitle = "") {
  const blocks = (Array.isArray(questions) ? questions : [])
    .filter((question) => (question.lines && question.lines.length) || String(question.note || "").trim())
    .map((question) => {
      const head = question.title ? `${question.key} · ${question.title}` : String(question.key);
      const lines = (question.lines || []).map((line) => "  " + line);
      const note = String(question.note || "").trim();
      if (note) lines.push("  Note: " + note.split("\n").join("\n    "));
      return `${head}\n${lines.join("\n")}`;
    });
  const note = String(pageNote || "").trim();
  if (note) blocks.push(`Note for the whole page:\n  ${note.split("\n").join("\n  ")}`);
  if (!blocks.length) return "";
  const title = String(pageTitle || "").trim();
  return (title ? `Answers: ${title}\n\n` : "") + blocks.join("\n\n");
}
