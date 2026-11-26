#!/usr/bin/env node
// Records the README demo: a real Lavish session on demo/release-workflow.html, driven through the
// Chrome DevTools Protocol, then encoded with ffmpeg into demo/lavish-demo.gif and .mp4.
//
//   npm run build && node scripts/record-demo.js
//
// Needs Google Chrome (or CHROME=<path>) and ffmpeg. It runs its own Lavish server on a private
// state directory and port, so it never touches the server your agents use.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "cli.mjs");
const page = path.join(root, "demo", "release-workflow.html");
const outDir = path.join(root, "demo");
const work = mkdtempSync(path.join(tmpdir(), "lavish-demo-"));
const frames = path.join(work, "frames");
mkdirSync(frames);

// The board names the agent it detects; the demo shows a neutral one.
const agentVars = /^(CLAUDECODE|CLAUDE_CODE_|CODEX_|T3CODE_|COPILOT_)/;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !agentVars.test(name))),
  LAVISH_AXI_STATE_DIR: path.join(work, "state"),
  LAVISH_AXI_PORT: "4498",
  LAVISH_AXI_HOST: "127.0.0.1",
  LAVISH_AXI_NO_OPEN: "1",
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lavish(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`lavish ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

// A minimal DevTools Protocol client over one browser connection, with flattened sessions.
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const handler of this.handlers) handler(msg);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(handler) {
    this.handlers.push(handler);
  }
}

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome not found: set CHROME=<path>");
  return found;
}

async function main() {
  lavish("stop", "--force");
  const opened = lavish(page, "--no-open");
  const url = /url: "([^"]+)"/.exec(opened)?.[1];
  if (!url) throw new Error(`no session url in:\n${opened}`);
  // An agent listening, so the board shows it working and then its reply.
  const poll = spawn(process.execPath, [cli, "poll", page], { env, stdio: "ignore" });

  const profile = path.join(work, "chrome");
  const chrome = spawn(
    chromePath(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1280,800",
      "--force-device-scale-factor=1",
      "--hide-scrollbars",
      "--mute-audio",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let portFile = "";
  for (let i = 0; i < 100 && !portFile; i += 1) {
    await sleep(100);
    const file = path.join(profile, "DevToolsActivePort");
    if (existsSync(file)) portFile = readFileSync(file, "utf8");
  }
  const [port, wsPath] = portFile.trim().split("\n");
  const cdp = new Cdp(`ws://127.0.0.1:${port}${wsPath}`);
  await cdp.ready();

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: top } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, top);
  await cdp.send("Runtime.enable", {}, top);
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    top,
  );
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, top);

  // The artifact is an out-of-process frame when Chrome isolates it: catch its session.
  let frameSession = "";
  cdp.on((msg) => {
    if (msg.method === "Target.attachedToTarget" && msg.params.targetInfo.type === "iframe") {
      frameSession = msg.params.sessionId;
      cdp.send("Runtime.runIfWaitingForDebugger", {}, frameSession).catch(() => {});
    }
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, top);

  await cdp.send("Page.navigate", { url }, top);
  await sleep(5000);

  // Evaluate in the artifact frame: its own session when out of process, else an isolated world.
  async function inFrame(expression) {
    if (frameSession) {
      const result = await cdp.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true },
        frameSession,
      );
      return result.result.value;
    }
    const tree = await cdp.send("Page.getFrameTree", {}, top);
    const child = tree.frameTree.childFrames?.[0]?.frame;
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: child.id }, top);
    const result = await cdp.send(
      "Runtime.evaluate",
      { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true },
      top,
    );
    return result.result.value;
  }
  const inTop = async (expression) =>
    (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, top)).result.value;

  // A visible cursor, since headless frames carry none.
  await inTop(`(() => {
    const dot = document.createElement('div');
    dot.id = 'demo-cursor';
    dot.style.cssText = 'position:fixed;z-index:2147483647;left:640px;top:420px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(220,38,38,.85);box-shadow:0 0 0 4px rgba(220,38,38,.25);pointer-events:none;transition:left .45s ease,top .45s ease,transform .15s ease';
    document.body.appendChild(dot);
  })()`);

  // `find` is an expression run in the frame that returns the element to act on.
  async function pointAt(find) {
    await inFrame(`(${find}).scrollIntoView({ block: 'center', behavior: 'smooth' })`);
    await sleep(700);
    const rect = await inFrame(
      `(() => { const r = (${find}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    const frame = await inTop(
      `(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`,
    );
    const x = Math.round(frame.x + rect.x);
    const y = Math.round(frame.y + rect.y);
    await inTop(
      `(() => { const d = document.getElementById('demo-cursor'); d.style.left = '${x}px'; d.style.top = '${y}px'; })()`,
    );
    await sleep(550);
    return { x, y };
  }
  async function click(find) {
    const { x, y } = await pointAt(find);
    await inTop(`document.getElementById('demo-cursor').style.transform = 'scale(.7)'`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, top);
    }
    await sleep(150);
    await inTop(`document.getElementById('demo-cursor').style.transform = ''`);
    await sleep(350);
  }
  async function type(text) {
    for (const char of text) {
      await cdp.send("Input.insertText", { text: char }, top);
      await sleep(28);
    }
    await sleep(400);
  }

  // Record from here: Chrome sends a frame on every paint, each with its timestamp.
  const shots = [];
  cdp.on((msg) => {
    if (msg.method !== "Page.screencastFrame" || msg.sessionId !== top) return;
    const file = path.join(frames, `${String(shots.length).padStart(5, "0")}.jpg`);
    writeFileSync(file, Buffer.from(msg.params.data, "base64"));
    shots.push({ file, time: msg.params.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: msg.params.sessionId }, top).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1280, maxHeight: 800 }, top);
  // A still page sends no frames, so a tiny overlay ticks to keep the clock honest.
  await inTop(
    `(() => { const t = document.createElement('div'); t.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:.01'; document.body.appendChild(t); let on = false; setInterval(() => { on = !on; t.style.background = on ? '#000' : '#fff'; }, 100); })()`,
  );
  await sleep(2200);

  const option = (id, value) =>
    `document.querySelector('[data-lavish-question="${id}"] input[value="${value}"]').closest('label')`;
  const noteToggle = (id) =>
    `document.querySelector('[data-lavish-question="${id}"] [data-lavish-ui="question-note"]').shadowRoot.querySelector('.toggle')`;
  const bar = (act) =>
    `document.querySelector('[data-lavish-ui="queue-all"]').shadowRoot.querySelector('[data-act="${act}"]')`;

  await click(option("O1", "Go"));
  await click(option("O2", "Maybe"));
  await click(noteToggle("O2"));
  await type("Only if the package name is pinned to our scope.");
  await click(option("O3", "No"));
  await click(`document.querySelector('[data-lavish-question="O4-something-else"] textarea')`);
  await type("Also a nightly .tgz from main for testers.");
  await sleep(500);
  await click(bar("send"));
  await sleep(2500);

  // The agent answers in the review's conversation panel.
  await new Promise((resolve) => (poll.exitCode !== null ? resolve() : poll.once("exit", resolve)));
  // Reply and keep listening, as an agent does between rounds.
  const listen = spawn(
    process.execPath,
    [
      cli,
      "poll",
      page,
      "--agent-reply",
      "O1: go. Adding the release workflow and tagging v0.1.98-jadev.2.\nO2: parked, with your condition.\nO3: dropped.\nNightly .tgz noted for round 2.",
    ],
    { env, stdio: "ignore" },
  );
  await sleep(5000);
  listen.kill("SIGKILL");
  await cdp.send("Page.stopScreencast", {}, top);

  chrome.kill("SIGKILL");
  lavish("stop", "--force");

  // Each frame shows until the next one; the last holds for two seconds.
  const list = shots
    .map((shot, i) => {
      const next = shots[i + 1]?.time ?? shot.time + 2;
      return `file '${shot.file}'\nduration ${Math.max(0.01, next - shot.time).toFixed(3)}`;
    })
    .join("\n");
  writeFileSync(path.join(work, "frames.txt"), `${list}\nfile '${shots.at(-1).file}'\n`);
  const mp4 = path.join(outDir, "lavish-demo.mp4");
  const gif = path.join(outDir, "lavish-demo.gif");
  const ffmpeg = (args) => {
    const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
  };
  const input = ["-f", "concat", "-safe", "0", "-i", path.join(work, "frames.txt")];
  ffmpeg([...input, "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", mp4]);
  ffmpeg([
    ...input,
    "-vf",
    "fps=12,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    "-loop",
    "0",
    gif,
  ]);
  rmSync(work, { recursive: true, force: true });
  console.log(`wrote ${path.relative(root, gif)} and ${path.relative(root, mp4)} from ${shots.length} frames`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  try {
    lavish("stop", "--force");
  } catch {
    // The server may not have started.
  }
  process.exit(1);
});
