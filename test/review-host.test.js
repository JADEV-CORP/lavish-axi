import assert from "node:assert/strict";
import test from "node:test";

import { createOpenOutput } from "../src/cli.js";
import { detectReviewHost, hostOpenStep } from "../src/review-host.js";

test("T3 Code and VS Code's agent chat open the review beside the chat; everything else keeps the browser", () => {
  assert.equal(detectReviewHost([], { T3CODE_THREAD_ID: "t-1" })?.id, "t3");
  // Any VS Code terminal sets TERM_PROGRAM, so VS Code keeps the browser unless the panel is asked for.
  assert.equal(detectReviewHost([], { TERM_PROGRAM: "vscode" }), null);
  assert.equal(detectReviewHost([], { TERM_PROGRAM: "vscode", LAVISH_AXI_OPEN: "panel" })?.id, "vscode");
  assert.equal(detectReviewHost([], { TERM_PROGRAM: "iTerm.app", LAVISH_AXI_OPEN: "panel" }), null);
  // Inside T3 Code the preview panel wins, whichever agent runs there.
  assert.equal(detectReviewHost([], { T3CODE_THREAD_ID: "t-1", CLAUDECODE: "1" })?.id, "t3");
  assert.equal(detectReviewHost([], { TERM_PROGRAM: "iTerm.app" }), null);
  assert.equal(detectReviewHost(["--external"], { T3CODE_THREAD_ID: "t-1" }), null);
  assert.equal(detectReviewHost([], { TERM_PROGRAM: "vscode", LAVISH_AXI_OPEN: "external" }), null);
});

test("the open output names the tool, the url, and the way back to the browser", () => {
  const host = detectReviewHost([], { T3CODE_THREAD_ID: "t-1" });
  const output = createOpenOutput({
    file: "/w/page.html",
    url: "http://127.0.0.1:4387/session/abc",
    host,
    status: "ready",
  });
  assert.deepEqual(output.open_in, {
    host: "t3",
    tool: "preview_open (mcp__t3-code__preview_open)",
    url: "http://127.0.0.1:4387/session/abc",
  });
  assert.match(
    output.next_step,
    /^Show the review in this thread's preview panel in T3 Code first: call the preview_open/,
  );
  assert.match(output.next_step, /lavish \/w\/page\.html --external/);
  assert.equal(createOpenOutput({ file: "/w/page.html", url: "u", status: "opened" }).open_in, undefined);
  assert.equal(hostOpenStep(null, "f", "u"), "");
});
