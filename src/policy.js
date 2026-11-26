// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
// Machine policy: two switches a company can set once per machine, `share` (publishing pages to
// ht-ml.app) and `updateCheck` (asking npm for a newer Lavish). The file lives in the state
// directory as policy.json. No file means both are allowed. A file that cannot be read means both
// are off: a policy that is there but unreadable must never leave sharing open.
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{ share: boolean, updateCheck: boolean, source: "default" | "file" | "invalid" }} Policy */

// What every surface says when sharing is off, so the CLI, the review window and the docs agree.
export const SHARE_DISABLED_MESSAGE = "Sharing is turned off on this machine (lavish policy).";

const POLICY_FILE = "policy.json";
const SWITCHES = ["share", "updateCheck"];
const OFF_VALUES = new Set(["off", "false", "0"]);
const ON_VALUES = new Set(["on", "true", "1"]);

export function policyFile(stateDir) {
  return path.join(stateDir, POLICY_FILE);
}

/** Turn one stored value into true or false, or null when it means neither. */
function readSwitch(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (OFF_VALUES.has(text)) return false;
    if (ON_VALUES.has(text)) return true;
  }
  return null;
}

/** @type {Policy} */
const INVALID = Object.freeze({ share: false, updateCheck: false, source: "invalid" });

/** @returns {Policy} */
function parsePolicy(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...INVALID };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...INVALID };
  /** @type {Policy} */
  const policy = { share: true, updateCheck: true, source: "file" };
  for (const name of SWITCHES) {
    // A switch that is not in the file stays allowed. One that is there but unreadable fails the file.
    if (!(name in parsed)) continue;
    const value = readSwitch(parsed[name]);
    if (value === null) return { ...INVALID };
    policy[name] = value;
  }
  return policy;
}

/**
 * Read the policy synchronously: the share check and the update checker both run on paths that
 * cannot wait. A missing file is the default; any other failure is "invalid" and closed.
 * @param {string} stateDir
 * @returns {Policy}
 */
export function readPolicy(stateDir) {
  let text;
  try {
    text = readFileSync(policyFile(stateDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
      return { share: true, updateCheck: true, source: "default" };
    return { ...INVALID };
  }
  return parsePolicy(text);
}

/**
 * Change one or both switches and keep the other as it is. The file is written to a temporary name
 * and renamed, so a reader never sees half a file, and it is private to the user (0600).
 * @param {string} stateDir
 * @param {{ share?: boolean, updateCheck?: boolean }} changes
 * @returns {Promise<Policy>}
 */
export async function writePolicy(stateDir, changes) {
  const current = readPolicy(stateDir);
  const next = {
    share: typeof changes.share === "boolean" ? changes.share : current.share,
    updateCheck: typeof changes.updateCheck === "boolean" ? changes.updateCheck : current.updateCheck,
  };
  const file = policyFile(stateDir);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { ...next, source: /** @type {const} */ ("file") };
}
