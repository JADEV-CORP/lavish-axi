import assert from "node:assert/strict";
import test from "node:test";

import { POLL_ROUND_MS, pollExecutionGuidance, pollRoundMs } from "../src/cli.js";

test("a poll returns after 8 minutes unless LAVISH_AXI_POLL_ROUND_MS says otherwise; 0 waits indefinitely", () => {
  assert.equal(POLL_ROUND_MS, 8 * 60_000);
  assert.equal(pollRoundMs({}), POLL_ROUND_MS);
  assert.equal(pollRoundMs({ LAVISH_AXI_POLL_ROUND_MS: "0" }), 0);
  assert.equal(pollRoundMs({ LAVISH_AXI_POLL_ROUND_MS: "90000" }), 90_000);
  assert.equal(pollRoundMs({ LAVISH_AXI_POLL_ROUND_MS: "soon" }), POLL_ROUND_MS);
  assert.equal(pollRoundMs({ LAVISH_AXI_POLL_ROUND_MS: "-5" }), POLL_ROUND_MS);
});

test("the poll guidance tells agents a waiting return means poll again, with room under tool limits", () => {
  const guidance = pollExecutionGuidance();
  assert.match(guidance, /returns on its own after 8 minutes with status waiting/);
  assert.match(guidance, /time limit of at least 9 minutes/);
});
