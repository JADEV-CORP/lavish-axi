// `lavish diagram`: turn a draw.io source into what a Lavish page shows.
//
// The page embeds a static `<name>.drawio.svg`: no script at view time, colors that follow light
// and dark mode (`--theme auto`), and the diagram itself embedded (`-e`), so the same SVG reopens
// in draw.io for editing. A PNG preview goes to the state directory for the agent to look at
// before it serves the page. Rendering uses the open source draw.io desktop app (Apache-2.0)
// already on the machine; Lavish downloads nothing.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export const DRAWIO_LAYOUTS = Object.freeze([
  "horizontalFlow",
  "verticalFlow",
  "horizontalTree",
  "verticalTree",
  "radialTree",
  "organic",
]);

export const DRAWIO_INSTALL_HELP = Object.freeze([
  "Install the draw.io desktop app (open source, Apache-2.0): macOS `brew install --cask drawio`, Windows `winget install JGraph.Draw`, Linux the .deb/.rpm/AppImage from https://github.com/jgraph/drawio-desktop/releases",
  "Or point LAVISH_AXI_DRAWIO at the draw.io executable",
]);

const SOURCE_EXTENSIONS = [".drawio", ".xml", ".mmd", ".mermaid"];
const PAGE_COLUMN_PX = 900;
// Below 85%, 13 px labels drop under 11 px.
const MIN_READABLE_SCALE = 85;

/** Where draw.io usually lives, most specific first. */
export function drawioCandidates(env = process.env, platform = process.platform) {
  const candidates = [];
  if (env.LAVISH_AXI_DRAWIO) candidates.push(env.LAVISH_AXI_DRAWIO);
  const exe = platform === "win32" ? ["drawio.exe", "draw.io.exe"] : ["drawio"];
  for (const dir of String(env.PATH || env.Path || "").split(path.delimiter)) {
    if (dir) for (const name of exe) candidates.push(path.join(dir, name));
  }
  if (platform === "darwin") {
    candidates.push("/Applications/draw.io.app/Contents/MacOS/draw.io");
    if (env.HOME) candidates.push(path.join(env.HOME, "Applications/draw.io.app/Contents/MacOS/draw.io"));
  } else if (platform === "win32") {
    for (const root of [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"),
    ]) {
      if (root) candidates.push(path.join(root, "draw.io", "draw.io.exe"));
    }
  } else {
    candidates.push("/opt/drawio/drawio", "/usr/bin/drawio", "/snap/bin/drawio");
  }
  return candidates;
}

export function resolveDrawio({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  return drawioCandidates(env, platform).find((candidate) => exists(candidate)) || null;
}

export function isDiagramSource(file) {
  const lower = String(file || "").toLowerCase();
  return SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext)) && !lower.endsWith(".drawio.svg");
}

/** `flow.drawio` gives `flow.drawio.svg`; a Mermaid file first becomes an editable `flow.drawio`. */
export function diagramPaths(source, { out = "", previewDir = "" } = {}) {
  const dir = path.dirname(source);
  const base = path.basename(source).replace(/\.(drawio|xml|mmd|mermaid)$/i, "");
  const isMermaid = /\.(mmd|mermaid)$/i.test(source);
  const drawio = isMermaid ? path.join(dir, `${base}.drawio`) : source;
  const svg = out ? path.resolve(out) : path.join(dir, `${base}.drawio.svg`);
  const digest = createHash("sha256").update(path.resolve(source)).digest("hex").slice(0, 10);
  const preview = previewDir ? path.join(previewDir, `${base}-${digest}.png`) : "";
  return { drawio, svg, preview, isMermaid };
}

/** draw.io CLI arguments for each step. Every step repairs the model first and never moves what the author placed. */
export function drawioArgs(step, { input, output, layout = "", page = 0 }) {
  const pageArgs = page > 0 ? ["-p", String(page)] : [];
  if (step === "source") {
    // Mermaid to draw.io, or a layout written back into the source so later hand edits keep it.
    return ["-x", "-f", "xml", "-u", "--normalize", ...(layout ? ["--layout", layout] : []), "-o", output, input];
  }
  if (step === "svg") {
    return [
      "-x",
      "-f",
      "svg",
      "-e",
      "-t",
      "--theme",
      "auto",
      "-b",
      "8",
      "--normalize",
      ...pageArgs,
      "-o",
      output,
      input,
    ];
  }
  if (step === "preview") {
    return [
      "-x",
      "-f",
      "png",
      "--theme",
      "light",
      "-b",
      "16",
      "-s",
      "2",
      "--normalize",
      ...pageArgs,
      "-o",
      output,
      input,
    ];
  }
  throw new Error(`unknown draw.io step: ${step}`);
}

export function runDrawio(bin, args, { timeoutMs = 90_000, spawn = spawnSync } = {}) {
  const started = Date.now();
  const result = spawn(bin, [...args.slice(0, 1), "--timeout", String(Math.ceil(timeoutMs / 1000)), ...args.slice(1)], {
    encoding: "utf8",
    timeout: timeoutMs + 5_000,
    // Electron prints GPU and sandbox chatter on stderr; only the exit status matters.
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const ms = Date.now() - started;
  if (result.error) return { ok: false, ms, error: result.error.message };
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim().split("\n").slice(-3).join(" | ");
    return { ok: false, ms, error: `draw.io exited ${result.status}${detail ? `: ${detail}` : ""}` };
  }
  return { ok: true, ms };
}

/** Width and height from the SVG root, so the page reserves the space before the image loads. */
export function svgSize(svgText) {
  const root = /<svg\b[^>]*>/i.exec(String(svgText || ""))?.[0] || "";
  const number = (name) => {
    const match = new RegExp(`\\b${name}="([0-9.]+)(px)?"`, "i").exec(root);
    return match ? Math.round(Number(match[1])) : 0;
  };
  return { width: number("width"), height: number("height") };
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function imgSnippet(svgPath, { alt = "", width = 0, height = 0 } = {}) {
  const size = width && height ? ` width="${width}" height="${height}"` : "";
  return `<img src="${escapeAttribute(path.basename(svgPath))}" alt="${escapeAttribute(alt)}"${size} style="max-width:100%;height:auto" loading="lazy">`;
}

/**
 * Runs the steps and returns the command output. `run` and `bin` are injectable for tests.
 * @param {{ source: string, layout?: string, out?: string, page?: number, previewDir: string, alt?: string, bin?: string | null, run?: typeof runDrawio, cwd?: string }} options
 */
export function buildDiagram({
  source,
  layout = "",
  out = "",
  page = 0,
  previewDir,
  alt = "",
  bin,
  run = runDrawio,
  cwd = process.cwd(),
}) {
  const absolute = path.resolve(cwd, source);
  if (!isDiagramSource(absolute)) {
    return {
      error: `Not a diagram source: ${source}`,
      code: "VALIDATION_ERROR",
      help: [`Pass a ${SOURCE_EXTENSIONS.join(", ")} file`],
    };
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    return {
      error: `File not found: ${source}`,
      code: "VALIDATION_ERROR",
      help: ["Write the .drawio file first, next to the HTML page"],
    };
  }
  if (layout && !DRAWIO_LAYOUTS.includes(layout)) {
    return {
      error: `Unknown layout: ${layout}`,
      code: "VALIDATION_ERROR",
      help: [`Use one of ${DRAWIO_LAYOUTS.join(", ")}`],
    };
  }
  if (!bin) return { error: "draw.io desktop was not found", code: "DRAWIO_NOT_FOUND", help: [...DRAWIO_INSTALL_HELP] };

  const paths = diagramPaths(absolute, { out: out ? path.resolve(cwd, out) : "", previewDir });
  const steps = [];
  const notes = [];
  // A hand-edited .drawio newer than its .mmd is the real source now: never overwrite it.
  const keepEdited =
    paths.isMermaid && existsSync(paths.drawio) && statSync(paths.drawio).mtimeMs > statSync(absolute).mtimeMs;
  if (keepEdited) {
    notes.push(
      `Rendered ${path.basename(paths.drawio)}, which is newer than ${path.basename(absolute)}; delete it to convert the Mermaid again`,
    );
  } else if (paths.isMermaid || layout) {
    // Written beside the source, then swapped in, so a failed run never leaves a broken source.
    const temp = path.join(path.dirname(paths.drawio), `.${path.basename(paths.drawio)}.${process.pid}.tmp`);
    const step = run(bin, drawioArgs("source", { input: absolute, output: temp, layout }));
    steps.push({ step: paths.isMermaid ? "mermaid to drawio" : `layout ${layout}`, ...step });
    if (!step.ok || !existsSync(temp) || !statSync(temp).size) {
      rmSync(temp, { force: true });
      return {
        error: step.error || "draw.io wrote nothing",
        code: "DRAWIO_FAILED",
        help: ["Open the source in draw.io to see what it cannot read"],
      };
    }
    renameSync(temp, paths.drawio);
  }
  const svgStep = run(bin, drawioArgs("svg", { input: paths.drawio, output: paths.svg, page }));
  steps.push({ step: "svg", ...svgStep });
  if (!svgStep.ok)
    return {
      error: svgStep.error,
      code: "DRAWIO_FAILED",
      help: ["Open the source in draw.io to see what it cannot read"],
    };
  let previewOk = false;
  if (paths.preview) {
    const previewStep = run(bin, drawioArgs("preview", { input: paths.drawio, output: paths.preview, page }));
    steps.push({ step: "preview", ...previewStep });
    previewOk = previewStep.ok;
  }

  const svgText = existsSync(paths.svg) ? readFileSync(paths.svg, "utf8") : "";
  const size = svgSize(svgText);
  // A page column is about 900 px. Much wider, the image scales down until its labels are hard to read.
  const warnings = [];
  const scale = size.width ? Math.round((PAGE_COLUMN_PX / size.width) * 100) : 100;
  if (scale < MIN_READABLE_SCALE) {
    warnings.push(
      `The diagram is ${size.width} px wide, so a ${PAGE_COLUMN_PX} px page column shows it at ${scale}% and its labels get hard to read. Rerun with --layout verticalFlow (or verticalTree), or split it into two diagrams`,
    );
  }
  const label =
    alt ||
    path
      .basename(paths.drawio)
      .replace(/\.drawio$/i, "")
      .replace(/[-_]+/g, " ");
  return {
    diagram: {
      source: paths.drawio,
      svg: paths.svg,
      ...(previewOk ? { preview_png: paths.preview } : {}),
      width: size.width,
      height: size.height,
      ms: steps.reduce((sum, step) => sum + step.ms, 0),
    },
    html: imgSnippet(paths.svg, { alt: label, ...size }),
    ...(warnings.length || notes.length ? { warnings: [...notes, ...warnings] } : {}),
    help: [
      previewOk
        ? `Look at preview_png before serving the page: labels fit, nothing overlaps, arrows read left to right or top to bottom`
        : "No preview was written; open the SVG in a browser to check it before serving the page",
      "Keep the .drawio next to the page: it is the editable source. Rerun `lavish diagram` after every edit",
      "The SVG embeds the diagram, so draw.io (desktop, VS Code extension or app.diagrams.net) opens it for editing too",
    ],
  };
}
