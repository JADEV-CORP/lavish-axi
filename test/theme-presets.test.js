import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  THEME_PRESET_IDS,
  THEME_PRESETS,
  themePresetCss,
  themePresetSummaries,
  whiteboardPresetId,
  whiteboardThemeCss,
} from "../src/theme-presets.js";
import { createChromeHtml } from "../src/server.js";

test("the presets are the default Lavish palette plus the six from the owner's gallery, ids unique", () => {
  assert.deepEqual(THEME_PRESET_IDS, ["lavish", "t3-code", "t3-chat", "grove", "ocean", "ember", "iris"]);
  assert.equal(new Set(THEME_PRESET_IDS).size, THEME_PRESET_IDS.length);
  for (const preset of THEME_PRESETS) {
    for (const side of ["light", "dark"]) {
      assert.match(preset.orb[side].primary, /^oklch\([0-9. %/]+\)$/, `${preset.id} ${side} accent is plain oklch`);
    }
  }
});

test("the Lavish preset's tokens match what chrome.css declares, so Copy theme CSS tells the truth", async () => {
  const css = await readFile(new URL("../src/chrome.css", import.meta.url), "utf8");
  const lavish = THEME_PRESETS.find((preset) => preset.id === "lavish");
  for (const [name, [light, dark]] of Object.entries(lavish.tokens)) {
    assert.ok(css.includes(`${name}: light-dark(${light}, ${dark});`), `${name} drifted from chrome.css`);
  }
  assert.ok(css.includes(`--primary-foreground: ${lavish.primaryForeground};`));
});

test("every preset but the default becomes a data-preset override, and the bootstrap knows only those ids", () => {
  const css = themePresetCss();
  assert.doesNotMatch(css, /data-preset="lavish"/);
  for (const id of THEME_PRESET_IDS.filter((value) => value !== "lavish")) {
    const block = css.slice(css.indexOf(`:root[data-preset="${id}"] {`));
    assert.ok(block.length < css.length + 1 && css.includes(`:root[data-preset="${id}"] {`), `${id} has an override`);
    assert.ok(block.slice(0, block.indexOf("}")).includes("--primary: light-dark("), `${id} overrides the accent`);
  }
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  assert.match(
    html,
    /localStorage\.getItem\("lavish-axi:theme-preset"\);if\(\["t3-code","t3-chat","grove","ocean","ember","iris"\]\.indexOf\(p\)>=0\)d\.dataset\.preset=p;/,
  );
  assert.match(html, /<button class="menu-item" id="openThemes" type="button">/);
  assert.match(html, /"themePresets":\[\{"id":"lavish","name":"Lavish"/);
  assert.equal(themePresetSummaries().length, THEME_PRESETS.length);
});

test("the whiteboard frame takes the chrome's palette: Lavish on :root, every other preset by data-preset", () => {
  const css = whiteboardThemeCss();
  assert.ok(css.startsWith(":root {\n  --background: light-dark(oklch(1 0 0), oklch(0.145 0.008 326));"));
  assert.ok(css.includes("--primary: light-dark(oklch(0.514 0.222 16.935), oklch(0.455 0.188 13.697));"));
  assert.ok(css.includes("--primary-foreground: oklch(0.969 0.015 12.422);"));
  assert.ok(css.endsWith(themePresetCss()), "the overrides are the chrome's own");
  assert.equal(whiteboardPresetId("ocean"), "ocean");
  assert.equal(whiteboardPresetId("lavish"), "", "the default needs no attribute");
  for (const value of [undefined, "", "unknown", '"] body { color: red } [x="', 42]) {
    assert.equal(whiteboardPresetId(value), "", "only a known preset id reaches the frame's attribute");
  }
});
