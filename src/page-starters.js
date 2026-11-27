// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
// Starter pages for `lavish new <type>`: ready-made pages in the Lavish design, wired to the page
// features (questions, storage, ask, download). Each one is a plain HTML file in src/starters/,
// copied to dist/starters/ by the build. Its <head> holds a marker that becomes the design snippet,
// so the CDN versions and the Lavish theme have one source (src/design-reference.js).
import { readFileSync } from "node:fs";

import { DESIGN_CDN_SNIPPET } from "./design-reference.js";

const DESIGN_MARKER = "<!-- lavish:design -->";

/** Every type, with what it is for and the playbook that goes with it. Order is the listing order. */
export const STARTER_TYPES = [
  { type: "decision", purpose: "Get answers to a few questions in one pass.", playbook: "input" },
  { type: "brainstorm", purpose: "Weigh options with the reader, one round at a time.", playbook: "brainstorm" },
  {
    type: "dashboard",
    purpose: "A table the reader adds to and edits, with totals and a CSV download.",
    playbook: "input",
  },
  {
    type: "report",
    purpose: "Say what happened and what it means: summary, numbers, sections, sources.",
    playbook: "explanation",
  },
  { type: "tracker", purpose: "A checklist kept with the page, with a button to ask the agent.", playbook: "input" },
  { type: "slides", purpose: "A short deck, one idea per slide, with keyboard navigation.", playbook: "slides" },
];

export function findStarter(type) {
  return STARTER_TYPES.find((starter) => starter.type === type) || null;
}

/** The page for a type, ready to write to disk. */
export function createStarterPage(type) {
  if (!findStarter(type)) throw new Error(`Unknown page type: ${type}`);
  const html = readFileSync(new URL(`./starters/${type}.html`, import.meta.url), "utf8");
  return html.replace(DESIGN_MARKER, () => DESIGN_CDN_SNIPPET);
}

/** `.lavish/<type>-<YYYY-MM-DD>.html`, dated in local time. */
export function defaultStarterPath(type, date = new Date()) {
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
  return `.lavish/${type}-${day}.html`;
}
