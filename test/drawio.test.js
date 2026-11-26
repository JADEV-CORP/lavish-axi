import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDiagram,
  diagramPaths,
  drawioArgs,
  drawioCandidates,
  imgSnippet,
  isDiagramSource,
  resolveDrawio,
  svgSize,
} from "../src/drawio.js";

const FLOW = `<mxfile><diagram id="d" name="Flow"><mxGraphModel adaptiveColors="auto"><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="Page" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry width="120" height="48" as="geometry"/></mxCell>
<mxCell id="b" value="Agent" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry width="120" height="48" as="geometry"/></mxCell>
<mxCell id="e" edge="1" source="a" target="b" parent="1" style="edgeStyle=orthogonalEdgeStyle;html=1;"/>
</root></mxGraphModel></diagram></mxfile>`;

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-drawio-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("draw.io is looked up in the override, on PATH, then in the usual install folder", () => {
  const mac = drawioCandidates({ LAVISH_AXI_DRAWIO: "/custom/drawio", PATH: "/a:/b", HOME: "/Users/x" }, "darwin");
  assert.equal(mac[0], "/custom/drawio");
  assert.ok(mac.includes(path.join("/a", "drawio")));
  assert.ok(mac.includes("/Applications/draw.io.app/Contents/MacOS/draw.io"));
  assert.ok(mac.indexOf(path.join("/a", "drawio")) < mac.indexOf("/Applications/draw.io.app/Contents/MacOS/draw.io"));

  const linux = drawioCandidates({ PATH: "" }, "linux");
  assert.ok(linux.includes("/opt/drawio/drawio"));

  const found = resolveDrawio({
    env: { PATH: "" },
    platform: "darwin",
    exists: (file) => file === "/Applications/draw.io.app/Contents/MacOS/draw.io",
  });
  assert.equal(found, "/Applications/draw.io.app/Contents/MacOS/draw.io");
  assert.equal(resolveDrawio({ env: { PATH: "" }, platform: "linux", exists: () => false }), null);
});

test("sources are .drawio, .xml and Mermaid files, never the rendered SVG", () => {
  for (const file of ["a.drawio", "a.XML", "a.mmd", "a.mermaid"]) assert.equal(isDiagramSource(file), true, file);
  for (const file of ["a.drawio.svg", "a.svg", "a.png", "", null])
    assert.equal(isDiagramSource(file), false, String(file));
});

test("outputs sit next to the source; a Mermaid file gets an editable .drawio first", () => {
  // Built with path.join so the expectations hold on Windows as well.
  const source = path.join(path.sep, "w", "flow.drawio");
  const plain = diagramPaths(source, { previewDir: path.join(path.sep, "state", "p") });
  assert.equal(plain.drawio, source);
  assert.equal(plain.svg, path.join(path.sep, "w", "flow.drawio.svg"));
  assert.equal(path.dirname(plain.preview), path.join(path.sep, "state", "p"));
  assert.match(path.basename(plain.preview), /^flow-[0-9a-f]{10}\.png$/);
  assert.equal(plain.isMermaid, false);

  const mermaid = diagramPaths(path.join(path.sep, "w", "seq.mmd"), { out: "/out/x.svg" });
  assert.equal(mermaid.drawio, path.join(path.sep, "w", "seq.drawio"));
  assert.equal(mermaid.svg, path.resolve("/out/x.svg"));
  assert.equal(mermaid.preview, "");
  assert.equal(mermaid.isMermaid, true);
});

test("each step asks draw.io for what the page needs", () => {
  const svg = drawioArgs("svg", { input: "in.drawio", output: "out.svg" });
  for (const flag of ["-e", "-t", "--normalize"]) assert.ok(svg.includes(flag), flag);
  assert.equal(svg[svg.indexOf("--theme") + 1], "auto");
  assert.deepEqual(svg.slice(-3), ["-o", "out.svg", "in.drawio"]);

  const preview = drawioArgs("preview", { input: "in.drawio", output: "p.png", page: 2 });
  assert.equal(preview[preview.indexOf("--theme") + 1], "light");
  assert.equal(preview[preview.indexOf("-p") + 1], "2");

  const source = drawioArgs("source", { input: "in.mmd", output: "in.drawio", layout: "verticalFlow" });
  assert.deepEqual(source.slice(0, 4), ["-x", "-f", "xml", "-u"]);
  assert.equal(source[source.indexOf("--layout") + 1], "verticalFlow");
  assert.equal(drawioArgs("source", { input: "a", output: "b" }).includes("--layout"), false);
  assert.throws(() => drawioArgs("pdf", { input: "a", output: "b" }), /unknown draw.io step/);
});

test("the img tag reserves the diagram's size and escapes what it prints", () => {
  assert.deepEqual(svgSize('<?xml version="1.0"?><svg xmlns="x" width="821px" height="82.4px" viewBox="0 0 821 82">'), {
    width: 821,
    height: 82,
  });
  assert.deepEqual(svgSize("<svg viewBox='0 0 1 1'>"), { width: 0, height: 0 });
  assert.equal(
    imgSnippet("/w/a.drawio.svg", { alt: 'Flow "v2" <draft>', width: 10, height: 5 }),
    '<img src="a.drawio.svg" alt="Flow &quot;v2&quot; &lt;draft>" width="10" height="5" style="max-width:100%;height:auto" loading="lazy">',
  );
});

test("buildDiagram checks its input before it starts draw.io", async (t) => {
  const dir = await tempDir(t);
  const calls = [];
  const run = (bin, args) => {
    calls.push(args);
    return { ok: true, ms: 1 };
  };
  assert.equal(
    buildDiagram({ source: "page.html", previewDir: dir, bin: "x", run, cwd: dir }).code,
    "VALIDATION_ERROR",
  );
  assert.equal(
    buildDiagram({ source: "missing.drawio", previewDir: dir, bin: "x", run, cwd: dir }).code,
    "VALIDATION_ERROR",
  );
  await writeFile(path.join(dir, "flow.drawio"), FLOW);
  assert.match(
    buildDiagram({ source: "flow.drawio", layout: "spiral", previewDir: dir, bin: "x", run, cwd: dir }).error,
    /Unknown layout/,
  );
  const missing = buildDiagram({ source: "flow.drawio", previewDir: dir, bin: null, run, cwd: dir });
  assert.equal(missing.code, "DRAWIO_NOT_FOUND");
  assert.match(missing.help.join(" "), /brew install --cask drawio/);
  assert.equal(calls.length, 0);
});

test("buildDiagram runs layout, SVG and preview in order and reports a draw.io failure", async (t) => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "flow.drawio"), FLOW);
  const steps = [];
  const ok = /** @type {any} */ (
    buildDiagram({
      source: "flow.drawio",
      layout: "horizontalFlow",
      previewDir: dir,
      bin: "drawio",
      cwd: dir,
      run: (bin, args) => {
        steps.push(args[2]);
        return { ok: true, ms: 5 };
      },
    })
  );
  // The fake draw.io writes nothing, so the layout step reports a failure and leaves the source alone.
  assert.equal(ok.code, "DRAWIO_FAILED");
  assert.deepEqual(steps, ["xml"]);
  assert.equal(await readFile(path.join(dir, "flow.drawio"), "utf8"), FLOW);

  steps.length = 0;
  const plain = /** @type {any} */ (
    buildDiagram({
      source: "flow.drawio",
      previewDir: dir,
      bin: "drawio",
      cwd: dir,
      run: (bin, args) => {
        steps.push(args[2]);
        return { ok: true, ms: 5 };
      },
    })
  );
  assert.deepEqual(steps, ["svg", "png"]);
  assert.equal(plain.diagram.ms, 10);
  assert.match(plain.html, /^<img src="flow\.drawio\.svg" alt="flow"/);
  assert.equal(plain.warnings, undefined, "no SVG on disk, so no size and no width warning");
  await writeFile(
    path.join(dir, "flow.drawio.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="1800px" height="200px"></svg>',
  );
  const wide = /** @type {any} */ (
    buildDiagram({
      source: "flow.drawio",
      previewDir: dir,
      bin: "drawio",
      cwd: dir,
      run: () => ({ ok: true, ms: 1 }),
    })
  );
  assert.match(wide.warnings[0], /1800 px wide.*at 50%.*--layout verticalFlow/);

  const failed = buildDiagram({
    source: "flow.drawio",
    previewDir: dir,
    bin: "drawio",
    cwd: dir,
    run: () => ({ ok: false, ms: 1, error: "draw.io exited 1" }),
  });
  assert.equal(failed.code, "DRAWIO_FAILED");
});

// Runs the real draw.io desktop app when it is installed; CI machines without it skip.
test("a real draw.io renders an adaptive SVG with the diagram embedded", { timeout: 120_000 }, async (t) => {
  const bin = resolveDrawio();
  if (!bin || process.env.LAVISH_AXI_SKIP_DRAWIO === "1") {
    t.skip("draw.io desktop is not installed");
    return;
  }
  const dir = await tempDir(t);
  await writeFile(path.join(dir, "flow.drawio"), FLOW);
  const result = buildDiagram({ source: "flow.drawio", layout: "horizontalFlow", previewDir: dir, bin, cwd: dir });
  assert.ok(!("error" in result), JSON.stringify(result));
  const svg = await readFile(result.diagram.svg, "utf8");
  assert.match(svg, /light-dark\(/, "colors follow light and dark mode");
  assert.match(svg, /content="/, "the diagram is embedded for editing");
  assert.ok(result.diagram.width > 0 && result.diagram.height > 0);
  assert.ok(existsSync(result.diagram.preview_png));
  assert.match(await readFile(path.join(dir, "flow.drawio"), "utf8"), /x="\d+/, "the layout is written back");
});
