import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DESIGN_CDN_SNIPPET, DESIGN_PRIORITY_RULE } from "../src/design-reference.js";
import { createStarterPage, defaultStarterPath, findStarter, STARTER_TYPES } from "../src/page-starters.js";
import { findPlaybook } from "../src/playbooks.js";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const TYPES = STARTER_TYPES.map((starter) => starter.type);
// An HTML comment that names a command, such as the diagram slot's `lavish diagram`.
const commentNaming = (command) => new RegExp(`<!--(?:(?!-->)[\\s\\S])*${command}(?:(?!-->)[\\s\\S])*-->`);

function runNew(args, cwd) {
  const result = spawnSync(process.execPath, [CLI, "new", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("every starter file has a type, and every type has a file and a playbook", () => {
  const files = readdirSync(new URL("../src/starters/", import.meta.url)).map((file) => file.replace(/\.html$/, ""));
  assert.deepEqual([...files].sort(), [...TYPES].sort());
  for (const starter of STARTER_TYPES) {
    assert.ok(findPlaybook(starter.playbook), `${starter.type} points at playbook ${starter.playbook}`);
    assert.ok(starter.purpose.length > 0);
  }
  assert.equal(findStarter("nope"), null);
  assert.throws(() => createStarterPage("nope"), /Unknown page type/);
});

test("each starter is a full Lavish page: design snippet, adaptive theme, no hardcoded colors or remote images", () => {
  const cdnUrls = new Set(DESIGN_CDN_SNIPPET.match(/https:\/\/[^"]+/g));
  for (const type of TYPES) {
    const page = createStarterPage(type);
    assert.match(page, /^<!doctype html>\n<html lang="en" data-theme="lavish-auto"/, type);
    assert.ok(page.includes(DESIGN_CDN_SNIPPET), `${type} carries the design snippet`);
    assert.ok(!page.includes("lavish:design"), `${type} has no marker left`);
    assert.ok(page.includes(`lavish new ${type}`), `${type} says where it came from`);
    assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
    const body = page.slice(page.indexOf("</head>"));
    assert.ok(!/[:"]\s*#[0-9a-f]{3,6}\b|rgb\(|oklch\(/i.test(body), `${type} uses theme colors only`);
    const markup = page.replace(/<!--[\s\S]*?-->/g, "");
    assert.ok(!/<img\b/i.test(markup), `${type} has no images`);
    const remote = (page.match(/https?:\/\/[^"'\s)]+/g) || []).filter((url) => !cdnUrls.has(url));
    assert.deepEqual(remote, [], `${type} loads nothing beyond the design snippet`);
  }
});

test("each starter is wired to the feature it shows", () => {
  const page = Object.fromEntries(TYPES.map((type) => [type, createStarterPage(type)]));

  assert.ok((page.decision.match(/data-lavish-question="D\d"/g) || []).length >= 3);
  assert.match(page.decision, /data-lavish-annotate="off"/);
  assert.match(page.decision, /window\.lavish\?\.queuePrompt\(/);
  assert.doesNotMatch(page.decision, /data-lavish-queue-all/, "Lavish adds the Queue all bar");

  assert.match(page.brainstorm, /Round 1/);
  assert.ok(commentNaming("lavish diagram ").test(page.brainstorm), "the diagram slot names the command");
  for (const id of ["O1", "O2", "O3", "something-else"])
    assert.ok(page.brainstorm.includes(`data-lavish-question="${id}"`));
  for (const answer of ["Go", "Maybe", "No"]) assert.ok(page.brainstorm.includes(`value="${answer}"`));
  assert.match(page.brainstorm, /Fit \d+/);

  assert.match(page.dashboard, /store\?\.get\("rows"\)/);
  assert.match(page.dashboard, /store\.set\("rows", rows\)/);
  assert.match(page.dashboard, /window\.lavish\.download\("budget\.csv", csv, "text\/csv"\)/);
  assert.match(page.dashboard, /<table class="table">/);
  // form.elements.item is HTMLFormControlsCollection's item() method, never the field named "item".
  assert.doesNotMatch(page.dashboard, /elements\.item\b/);

  assert.match(page.report, /aria-label="Key numbers"/);
  assert.ok(commentNaming("lavish diagram ").test(page.report), "the diagram slot names the command");
  assert.match(page.report, /Sources:/);

  assert.match(page.tracker, /store\.set\("items", items\)/);
  assert.match(page.tracker, /window\.lavish\.ask\(question, \{ data: \{ open, done \} \}\)/);
  assert.match(page.tracker, /NO_AGENT: "No agent is listening/);

  assert.ok((page.slides.match(/<section\s+data-slide/g) || []).length >= 5);
  assert.match(page.slides, /addEventListener\("keydown"/);
  assert.match(page.slides, /ArrowRight: 1/);
});

test("the default file is .lavish/<type>-<local date>.html", () => {
  assert.equal(defaultStarterPath("report", new Date(2026, 0, 5, 23, 30)), ".lavish/report-2026-01-05.html");
});

test("the design rule names every type, so agents reach lavish new from lavish design", () => {
  for (const type of TYPES) assert.ok(DESIGN_PRIORITY_RULE.includes(type), type);
  assert.match(DESIGN_PRIORITY_RULE, /`lavish new <type>`/);
});

test("lavish new lists the types, writes a page, and never replaces one without --force", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lavish-new-"));
  try {
    const listed = runNew([], dir);
    assert.equal(listed.status, 0, listed.output);
    for (const type of TYPES) assert.match(listed.output, new RegExp(`\\b${type}\\b`));

    const created = runNew(["tracker"], dir);
    assert.equal(created.status, 0, created.output);
    const file = path.join(dir, defaultStarterPath("tracker"));
    assert.equal(await readFile(file, "utf8"), createStarterPage("tracker"));
    assert.match(created.output, /next_step: .*`lavish \.lavish\/tracker-\d{4}-\d{2}-\d{2}\.html`/);

    await writeFile(file, "kept");
    const refused = runNew(["tracker"], dir);
    assert.notEqual(refused.status, 0);
    assert.match(refused.output, /FILE_EXISTS/);
    assert.equal(await readFile(file, "utf8"), "kept");

    const forced = runNew(["tracker", "--force"], dir);
    assert.equal(forced.status, 0, forced.output);
    assert.match(forced.output, /replaced: true/);
    assert.equal(await readFile(file, "utf8"), createStarterPage("tracker"));

    const named = runNew(["slides", "talk.html"], dir);
    assert.equal(named.status, 0, named.output);
    assert.equal(await readFile(path.join(dir, "talk.html"), "utf8"), createStarterPage("slides"));

    assert.match(runNew(["nope"], dir).output, /Unknown page type: nope/);
    assert.match(runNew(["report", "notes.txt"], dir).output, /must end in \.html/);
    assert.match(runNew(["report", "--yes"], dir).output, /Unknown option: --yes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
