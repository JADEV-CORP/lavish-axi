// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
import crypto from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// cross-spawn quotes arguments for cmd.exe, which Windows needs to run T3's `t3.cmd` launcher.
const crossSpawn = createRequire(import.meta.url)("cross-spawn");

// Starting the T3 CLI boots its Electron runtime, which takes about ten seconds on Windows.
export const T3_CLI_TIMEOUT_MS = 30_000;
const T3_CLI_NAMES = new Set(["t3", "t3.cmd", "t3.exe"]);

function bindingPath(stateDir, key) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new Error("Invalid session key");
  return path.join(stateDir, "agent-bindings", `${key}.json`);
}

function ownerPath(stateDir, owner) {
  if (!/^[a-f0-9]{32}$/.test(owner)) throw new Error("Invalid agent owner");
  return path.join(stateDir, "agent-owners", `${owner}.json`);
}

function validateWebhook(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "relay.t3.codes" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/v1/hooks/")
  )
    throw new Error("Use a T3 Connect webhook URL");
  return url.href;
}

/**
 * T3 thread ids are UUIDs, or `thread:delegated-task:...` with percent-encoded parts for child
 * tasks. Anything else is refused, so the id is safe to quote on a cmd.exe command line.
 * @param {unknown} value
 */
export function validateT3Thread(value) {
  const thread = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]*(?:%[0-9A-Fa-f]{2}[A-Za-z0-9:._-]*)*$/.test(thread) || thread.length > 256) {
    throw new Error("Use a T3 Code thread id");
  }
  return thread;
}

/** The T3 CLI path T3 Code exports to the processes it runs. Only an absolute `t3` launcher is accepted. */
export function validateT3Cli(value) {
  const cli = typeof value === "string" ? value.trim() : "";
  if (
    !cli ||
    !path.isAbsolute(cli) ||
    !T3_CLI_NAMES.has(path.basename(cli).toLowerCase()) ||
    /["%^&|<>!\r\n]/.test(cli)
  ) {
    throw new Error("T3CODE_CLI_PATH is not a T3 Code CLI");
  }
  return cli;
}

/**
 * Who is creating sessions: the harness conversation running inside T3 Code. Sessions from the same
 * conversation reuse its thread link; any other caller gets none. Hashed, so the state directory
 * never holds the harness id itself.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null}
 */
export function agentOwnerId(env = process.env) {
  if (!env.T3CODE_CLI_PATH) return null;
  for (const name of ["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID"]) {
    const value = env[name]?.trim();
    if (value) return crypto.createHash("sha256").update(`${name}=${value}`).digest("hex").slice(0, 32);
  }
  return null;
}

/**
 * Runs the T3 CLI with fixed arguments. Any message goes through stdin, never the command line.
 * @param {string} cli
 * @param {string[]} args
 * @param {{ input?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ code: number | null, stdout: string }>}
 */
export function runT3Cli(cli, args, { input = "", timeoutMs = T3_CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = crossSpawn(cli, args, { windowsHide: true });
    let stdout = "";
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.resume();
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function writeJsonAtomic(file, value, { replace = true } = {}) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    if (replace) {
      await rename(temporary, file);
      return true;
    }
    // A hard link fails when the target exists, so two racing creators cannot both claim it.
    try {
      await link(temporary, file);
      return true;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** @typedef {{ transport: "t3-thread", thread: string, cli: string } | { transport: "webhook", webhook: string }} AgentBinding */

/** @returns {AgentBinding | null} */
function parseBinding(value) {
  try {
    if (value?.transport === "t3-thread") {
      return {
        transport: "t3-thread",
        thread: validateT3Thread(value.thread),
        cli: validateT3Cli(value.cli),
      };
    }
    if (typeof value?.webhook === "string") return { transport: "webhook", webhook: validateWebhook(value.webhook) };
  } catch {
    // An unreadable or tampered binding is no binding.
  }
  return null;
}

/** @returns {Promise<AgentBinding | null>} */
export async function readAgentBinding(stateDir, key) {
  return parseBinding(await readJson(bindingPath(stateDir, key)));
}

/**
 * Legacy manual binding to a T3 Connect webhook. The credential never enters session JSON.
 * Lavish cannot delete the webhook task itself; the thread that created it must.
 */
export async function bindAgentNudge(stateDir, key, webhook) {
  const file = bindingPath(stateDir, key);
  if (webhook === null) {
    await releaseAgentLink(stateDir, key);
    return;
  }
  await writeJsonAtomic(file, { webhook: validateWebhook(webhook) });
}

/**
 * Links a session to a T3 thread after `t3 thread show` confirms the thread exists and is not
 * archived. The conversation's thread record lets its later sessions link without asking.
 * @param {string} stateDir
 * @param {string} key
 * @param {{ thread: string, cli: string, owner: string | null, run?: typeof runT3Cli }} options
 * @returns {Promise<{ status: "linked", thread: string } | { status: "failed", reason: string }>}
 */
export async function linkT3Thread(stateDir, key, { thread, cli, owner, run = runT3Cli }) {
  bindingPath(stateDir, key);
  let validThread;
  let validCli;
  try {
    validThread = validateT3Thread(thread);
    validCli = validateT3Cli(cli);
  } catch (error) {
    return { status: "failed", reason: /** @type {Error} */ (error).message };
  }
  if (!(await stat(validCli).catch(() => null))) return { status: "failed", reason: "T3 Code CLI not found" };
  const shown = await run(validCli, ["thread", "show", validThread, "--json", "--messages", "0"]);
  let found;
  try {
    found = shown.code === 0 ? JSON.parse(shown.stdout)?.thread : null;
  } catch {
    found = null;
  }
  if (shown.code === null) return { status: "failed", reason: "T3 Code did not answer" };
  // A non-zero exit is also what a stopped T3 Code gives, so this does not claim the thread is gone.
  if (shown.code !== 0) return { status: "failed", reason: "T3 Code could not show that thread" };
  if (!found || found.threadId !== validThread) return { status: "failed", reason: "T3 Code has no such thread" };
  if (found.archived === true) return { status: "failed", reason: "That T3 Code thread is archived" };
  const binding = { transport: "t3-thread", thread: validThread, cli: validCli };
  await writeJsonAtomic(bindingPath(stateDir, key), binding);
  if (owner) await writeJsonAtomic(ownerPath(stateDir, owner), { thread: validThread, cli: validCli });
  return { status: "linked", thread: validThread };
}

/**
 * Links a new session to its creator's thread when that conversation linked one before. Never
 * replaces an existing binding, which may belong to another conversation.
 * @returns {Promise<{ status: "linked", source: "existing" | "owner" } | null>}
 */
export async function autoLinkSession(stateDir, key, owner) {
  if (await readAgentBinding(stateDir, key)) return { status: "linked", source: "existing" };
  if (!owner) return null;
  const record = await readJson(ownerPath(stateDir, owner));
  const binding = parseBinding({ transport: "t3-thread", thread: record?.thread, cli: record?.cli });
  if (!binding) return null;
  const used = new Date();
  await utimes(ownerPath(stateDir, owner), used, used).catch(() => {});
  if (await writeJsonAtomic(bindingPath(stateDir, key), binding, { replace: false })) {
    return { status: "linked", source: "owner" };
  }
  return (await readAgentBinding(stateDir, key)) ? { status: "linked", source: "existing" } : null;
}

// A conversation's thread record holds no credential and registers nothing in T3 Code, so it
// outlives single reviews. Records nobody used for this long are pruned at server start.
export const OWNER_RECORD_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Removes a session's link. Safe to repeat.
 * @returns {Promise<{ released: "t3-thread" | "webhook" | null }>}
 */
export async function releaseAgentLink(stateDir, key) {
  const file = bindingPath(stateDir, key);
  const binding = await readAgentBinding(stateDir, key);
  await rm(file, { force: true });
  return { released: binding?.transport ?? null };
}

async function listBoundKeys(stateDir) {
  try {
    return (await readdir(path.join(stateDir, "agent-bindings")))
      .filter((name) => /^[a-zA-Z0-9_-]{1,128}\.json$/.test(name))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/**
 * Releases links whose session ended or vanished while no server was running to see it, and
 * prunes thread records unused for {@link OWNER_RECORD_TTL_MS}.
 * @param {(key: string) => Promise<boolean>} isLive
 */
export async function sweepAgentLinks(stateDir, isLive, { now = Date.now } = {}) {
  const released = [];
  for (const key of await listBoundKeys(stateDir)) {
    if (!(await isLive(key))) {
      await releaseAgentLink(stateDir, key);
      released.push(key);
    }
  }
  const ownersDir = path.join(stateDir, "agent-owners");
  const owners = await readdir(ownersDir)
    .then((names) => names.filter((name) => /^[a-f0-9]{32}\.json$/.test(name)))
    .catch(() => []);
  for (const name of owners) {
    const file = path.join(ownersDir, name);
    try {
      if (now() - (await stat(file)).mtimeMs > OWNER_RECORD_TTL_MS) await rm(file, { force: true });
    } catch {
      // Already gone.
    }
  }
  return released;
}

export function nudgeMessage(session) {
  return `Lavish has review feedback waiting for ${session.file}. Run \`lavish poll "${session.file}"\` and apply it within the scope you already have. If another poll is already listening on that review, leave it alone.`;
}

/** Coalesces clicks across tabs. A timeout is ambiguous, so failed attempts also keep a brief cooldown. */
export function createAgentNudger(
  stateDir,
  { request = fetch, run = runT3Cli, now = Date.now, cooldownMs = 15_000 } = {},
) {
  /** @type {Map<string, Promise<{status: string}>>} */
  const pending = new Map();
  /** @type {Map<string, number>} */
  const recent = new Map();
  return {
    available: async (key) => (await readAgentBinding(stateDir, key)) !== null,
    /** @returns {Promise<"t3-thread" | "webhook" | null>} */
    transport: async (key) => (await readAgentBinding(stateDir, key))?.transport ?? null,
    release: (key) => releaseAgentLink(stateDir, key),
    sweep: (isLive) => sweepAgentLinks(stateDir, isLive),
    async send(session) {
      if (pending.has(session.key)) return pending.get(session.key);
      const attempt = (async () => {
        const binding = await readAgentBinding(stateDir, session.key);
        if (!binding) return { status: "unavailable" };
        const timestamp = now();
        for (const [key, at] of recent) if (timestamp - at >= cooldownMs) recent.delete(key);
        if (recent.has(session.key)) return { status: "recently-sent" };
        recent.set(session.key, timestamp);
        if (binding.transport === "t3-thread") {
          const result = await run(binding.cli, ["thread", "send", binding.thread, "-"], {
            input: nudgeMessage(session),
          });
          return { status: result.code === 0 ? "sent" : "failed" };
        }
        try {
          const response = await request(binding.webhook, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ file: session.file, key: session.key }),
          });
          // Do not return the relay body: it can contain credentials or provider internals.
          await response.body?.cancel();
          return { status: response.ok ? "sent" : "failed" };
        } catch {
          return { status: "failed" };
        }
      })();
      pending.set(session.key, attempt);
      try {
        return await attempt;
      } finally {
        pending.delete(session.key);
      }
    },
  };
}
