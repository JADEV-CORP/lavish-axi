import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Newer Jadev versions (#3788). The fork is installed from its Azure DevOps repository, not npm, so
// the server reads package.json on the fork's main branch: a shallow, blob-less fetch into a small
// bare cache under the state directory, then just that one file. Git's own credential manager
// signs in, so this code never sees a token, and with interactive prompts off a machine that is
// not signed in simply skips the check.
export const JADEV_REPOSITORY = "https://dev.azure.com/jadev-corp/DEV-LAB/_git/lavish-axi";
export const FORK_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FORK_UPDATE_FIRST_CHECK_MS = 30_000;
const GIT_TIMEOUT_MS = 60_000;
const JADEV_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-jadev\.(\d+))?$/;

/**
 * Orders two fork versions, `0.1.83-jadev.12` style. An upstream version without the suffix ranks
 * below its own -jadev.N, the way the fork is built on it. Anything unparseable compares equal, so
 * a malformed version never claims an update.
 * @returns {-1 | 0 | 1}
 */
export function compareJadevVersions(a, b) {
  const left = JADEV_VERSION.exec(String(a || ""));
  const right = JADEV_VERSION.exec(String(b || ""));
  if (!left || !right) return 0;
  for (let index = 1; index <= 4; index += 1) {
    const difference = Number(left[index] || 0) - Number(right[index] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  return 0;
}

/** @param {string[]} args @param {{ cwd?: string, env: NodeJS.ProcessEnv }} options */
function runGit(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
}

/**
 * The version on the fork's main branch, or "" when it cannot be read.
 * @param {{ cacheDir: string, repository?: string, env?: NodeJS.ProcessEnv, git?: typeof runGit }} options
 */
export async function readLatestForkVersion({
  cacheDir,
  repository = JADEV_REPOSITORY,
  env = process.env,
  git = runGit,
}) {
  try {
    if (!existsSync(path.join(cacheDir, "HEAD"))) {
      await mkdir(cacheDir, { recursive: true });
      await git(["init", "--quiet", "--bare", cacheDir], { env });
    }
    await git(["fetch", "--quiet", "--depth=1", "--filter=blob:none", repository, "refs/heads/main"], {
      cwd: cacheDir,
      env,
    });
    const manifest = JSON.parse(await git(["cat-file", "-p", "FETCH_HEAD:package.json"], { cwd: cacheDir, env }));
    const version = String(manifest?.version || "");
    return JADEV_VERSION.test(version) ? version : "";
  } catch {
    return "";
  }
}

/**
 * Checks shortly after the server starts and then every few hours, and calls `onChange` with
 * `{ version, current }` when a newer fork version appears (or `null` once it no longer is).
 * Its timers never keep the server alive.
 * @param {{ currentVersion: string, read: () => Promise<string>, intervalMs?: number, firstCheckMs?: number }} options
 */
export function createForkUpdateChecker({
  currentVersion,
  read,
  intervalMs = FORK_UPDATE_INTERVAL_MS,
  firstCheckMs = FORK_UPDATE_FIRST_CHECK_MS,
}) {
  /** @type {{ version: string, current: string } | null} */
  let available = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let stopped = false;

  async function check(onChange) {
    const latest = await read();
    if (stopped || !latest) return;
    const next = compareJadevVersions(latest, currentVersion) > 0 ? { version: latest, current: currentVersion } : null;
    if (next?.version === available?.version) return;
    available = next;
    onChange(available);
  }

  function schedule(onChange, delay) {
    timer = setTimeout(() => {
      check(onChange).finally(() => {
        if (!stopped) schedule(onChange, intervalMs);
      });
    }, delay);
    timer.unref?.();
  }

  return {
    /** @param {(update: { version: string, current: string } | null) => void} onChange */
    start(onChange) {
      if (!stopped && !timer) schedule(onChange, firstCheckMs);
    },
    current: () => available,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** The checker the `server` command runs, unless LAVISH_AXI_UPDATE_CHECK=0 turns it off. */
export function defaultForkUpdateChecker({ currentVersion, stateDir, env = process.env }) {
  if (["0", "off", "false"].includes(String(env.LAVISH_AXI_UPDATE_CHECK || "").toLowerCase())) return null;
  // Only a fork build checks: an upstream install has no fork to fall behind.
  if (!/-jadev\.\d+$/.test(String(currentVersion || ""))) return null;
  const cacheDir = path.join(stateDir, "update-check.git");
  return createForkUpdateChecker({ currentVersion, read: () => readLatestForkVersion({ cacheDir, env }) });
}
