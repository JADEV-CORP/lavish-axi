import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DESIGN_CDN_SNIPPET, LAVISH_THEME_CSS } from "../src/design-reference.js";
import { PAGE_TEMPLATE } from "../src/page-template.js";
import { artifactThemeColors, THEME_PRESETS } from "../src/theme-presets.js";

const OKLCH = /^oklch\([0-9. %/]+\)$/;

test("the page template is one adaptive Lavish page with the full design snippet", () => {
  assert.match(PAGE_TEMPLATE, /^<!doctype html>\n<html lang="en" data-theme="lavish-auto">/);
  assert.ok(PAGE_TEMPLATE.includes(DESIGN_CDN_SNIPPET));
  assert.match(PAGE_TEMPLATE, /<body class="min-h-screen bg-base-100 text-base-content/);
  for (const part of ["<header", "<section", 'data-lavish-question="decision"', "<footer"]) {
    assert.ok(PAGE_TEMPLATE.includes(part), `the template has ${part}`);
  }
  const body = PAGE_TEMPLATE.slice(PAGE_TEMPLATE.indexOf("</head>"));
  assert.doesNotMatch(body, /[:"]\s*#[0-9a-f]{3,6}\b|rgb\(|oklch\(/i, "no hardcoded colors outside the theme");
});

test("lavish-auto holds both sides in light-dark(); lavish and lavish-dark keep their single side", () => {
  const auto = LAVISH_THEME_CSS.slice(LAVISH_THEME_CSS.indexOf('[data-theme="lavish-auto"] {'));
  assert.match(auto, /color-scheme: light dark;/);
  assert.match(auto, /--color-primary: light-dark\(oklch\(0\.514 0\.222 16\.935\), oklch\(0\.455 0\.188 13\.697\)\);/);
  assert.match(
    LAVISH_THEME_CSS,
    /\[data-theme="lavish"\] \{\n {4}color-scheme: light;\n {4}--color-base-100: oklch\(1 0 0\);/,
  );
  assert.match(
    LAVISH_THEME_CSS,
    /\[data-theme="lavish-dark"\] \{\n {4}color-scheme: dark;\n {4}--color-base-100: oklch\(0\.145 0\.008 326\);/,
  );
  assert.match(
    LAVISH_THEME_CSS,
    /:is\(\[data-theme="lavish"\], \[data-theme="lavish-dark"\], \[data-theme="lavish-auto"\]\) \{/,
  );
});

test("each preset but Lavish gives lavish-auto pages a light and a dark oklch for every color it sets", () => {
  for (const preset of THEME_PRESETS) {
    const colors = artifactThemeColors(preset);
    if (preset.builtIn) {
      assert.equal(colors, null);
      continue;
    }
    for (const name of [
      "--color-base-100",
      "--color-base-200",
      "--color-base-300",
      "--color-base-content",
      "--color-primary",
      "--color-primary-content",
    ]) {
      const [light, dark] = colors[name];
      assert.match(light, OKLCH, `${preset.id} ${name} light`);
      assert.match(dark, OKLCH, `${preset.id} ${name} dark`);
      assert.doesNotMatch(`${light}${dark}`, /\//, `${preset.id} ${name} is opaque`);
    }
  }
});

test("lavish-axi design --template prints the template as plain HTML", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), "design", "--template"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), PAGE_TEMPLATE.trim());
});
