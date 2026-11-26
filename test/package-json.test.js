import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("check script runs all verification commands", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const checkCommands = packageJson.scripts.check.split(" && ");

  assert.deepEqual(checkCommands, [
    "npm run build",
    "npm run lint",
    "npm run format:check",
    "npm run typecheck",
    "npm test",
    "node scripts/build-skill.js --check",
    "node scripts/build-plugin.js --check",
  ]);
});

test("committed skill matches the generator stub", async () => {
  const { createSkillMarkdown } = await import("../src/skill.js");
  const committed = await readFile(new URL("../skills/lavish/SKILL.md", import.meta.url), "utf8");

  assert.equal(committed, createSkillMarkdown(), "run `npm run build:skill` and commit the result");
});

test("published package includes the installable skill", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(packageJson.files.includes("skills/lavish"));
});

test("published package root is a complete Agent Plugin", async () => {
  // The tarball root doubles as the plugin root, so both the manifest and the skills it
  // discovers have to ship; without either, an installed copy is not installable as a plugin.
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(packageJson.files.includes("plugin.json"));
  assert.ok(packageJson.files.includes("skills/lavish"));
});

test("public lavish skill is not marked internal", async () => {
  const skillMd = await readFile(new URL("../skills/lavish/SKILL.md", import.meta.url), "utf8");
  const frontmatter = skillMd.slice(4, skillMd.indexOf("\n---\n", 4));

  assert.doesNotMatch(frontmatter, /^metadata:\n {2}internal: true$/m);
});

test("build copies local design assets for published artifact injection", async () => {
  const buildScript = await readFile(new URL("../scripts/build.js", import.meta.url), "utf8");

  assert.match(buildScript, /daisyui\.css/);
  assert.match(buildScript, /daisyui-themes\.css/);
  assert.match(buildScript, /tailwindcss-browser\.js/);
});

test("package metadata matches the GitHub repository used for npm provenance", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.repository.url, "git+https://github.com/JADEV-CORP/lavish-axi.git");
  assert.equal(packageJson.bugs.url, "https://github.com/JADEV-CORP/lavish-axi/issues");
  assert.equal(packageJson.homepage, "https://github.com/JADEV-CORP/lavish-axi#readme");
});

test("the package publishes as @jadev-corp/lavish with lavish and the lavish-axi alias", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.name, "@jadev-corp/lavish");
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, "our own semver line, no -jadev.N suffix");
  assert.deepEqual(packageJson.bin, { lavish: "dist/cli.mjs", "lavish-axi": "dist/cli.mjs" });
  assert.deepEqual(packageJson.publishConfig, { access: "public" });
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.author.name, "JADEV-CORP");
  assert.ok(packageJson.files.includes("CHANGELOG.md"));
});

test("pnpm lock root importer matches the publish manifest", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const pnpmLock = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");

  for (const [name, specifier] of Object.entries(packageJson.dependencies)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    assert.match(pnpmLock, new RegExp(`["']?${escapedName}["']?:[\\s\\S]*?specifier: ${escapedSpecifier}`));
  }
});

test("only the JADEV workflows remain, and CI runs on every pull request", async () => {
  // Upstream's release-please, no-mistakes and generated-file guards were removed. A sync with
  // upstream can bring them back silently, so the workflow set is pinned here.
  const workflows = (await readdir(new URL("../.github/workflows/", import.meta.url))).sort();
  assert.deepEqual(workflows, ["ci.yml", "jadev-release.yml"]);

  for (const file of ["../release-please-config.json", "../.release-please-manifest.json"]) {
    await assert.rejects(access(new URL(file, import.meta.url)), { code: "ENOENT" });
  }

  const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(ci, /paths-ignore|release-please/);
});
