import { compareSemver, fetchLatestVersion } from "axi-sdk-js";

import { stateDir as defaultStateDir } from "./paths.js";
import { readPolicy } from "./policy.js";

// The npm package this build is published as. `lavish update` (the SDK built-in) reads the same name
// from package.json; test/update-check.test.js keeps the two equal.
export const PACKAGE_NAME = "@jadev-corp/lavish";
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_CHECK_FIRST_MS = 30_000;
const REGISTRY_TIMEOUT_MS = 20_000;

// Plain semver: x.y.z with an optional prerelease. No leading "v" and no build metadata, so a
// version string a server reports either orders cleanly or is treated as unknown.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Orders two versions by semver precedence: numeric parts first, then a release above its own
 * prereleases. 1.0.0 ranks above every 0.1.98-jadev.N the fork shipped before it moved to npm.
 * @returns {-1 | 0 | 1 | null} null when either side is not plain semver
 */
export function compareReleaseVersions(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (!SEMVER.test(left) || !SEMVER.test(right)) return null;
  const order = compareSemver(left, right);
  return order > 0 ? 1 : order < 0 ? -1 : 0;
}

/**
 * The latest version on the npm registry, or "" when it cannot be read: offline, not published
 * yet, or a registry answer that is not plain semver. Only the registry's HTTP endpoint is asked;
 * the server never runs the npm CLI.
 * @param {{ packageName?: string, fetchImpl?: import("axi-sdk-js").FetchLike }} [options]
 */
export async function readLatestPublishedVersion({ packageName = PACKAGE_NAME, fetchImpl } = {}) {
  try {
    const version = await fetchLatestVersion(packageName, {
      ...(fetchImpl ? { fetchImpl } : {}),
      npmView: async () => null,
      fetchTimeoutMs: REGISTRY_TIMEOUT_MS,
    });
    return SEMVER.test(version) ? version : "";
  } catch {
    return "";
  }
}

/**
 * Checks shortly after the server starts and then every few hours, and calls `onChange` with
 * `{ version, current }` when a newer version is published (or `null` once it no longer is).
 * Its timers never keep the server alive.
 * @param {{ currentVersion: string, read: () => Promise<string>, intervalMs?: number, firstCheckMs?: number }} options
 */
export function createUpdateChecker({
  currentVersion,
  read,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
  firstCheckMs = UPDATE_CHECK_FIRST_MS,
}) {
  /** @type {{ version: string, current: string } | null} */
  let available = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let stopped = false;

  async function check(onChange) {
    const latest = await read();
    if (stopped || !latest) return;
    const next =
      compareReleaseVersions(latest, currentVersion) === 1 ? { version: latest, current: currentVersion } : null;
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
export function defaultUpdateChecker({ currentVersion, env = process.env, stateDir = defaultStateDir() }) {
  // The machine policy (lavish policy --update-check off) turns the check off with no variable set.
  if (!readPolicy(stateDir).updateCheck) return null;
  if (["0", "off", "false"].includes(String(env.LAVISH_AXI_UPDATE_CHECK || "").toLowerCase())) return null;
  // A build whose own version is not plain semver has nothing to compare against.
  if (compareReleaseVersions(currentVersion, currentVersion) === null) return null;
  return createUpdateChecker({ currentVersion, read: () => readLatestPublishedVersion() });
}
