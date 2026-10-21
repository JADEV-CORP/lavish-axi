// Copyright (c) 2026 JADEV-CORP. All rights reserved.
// Proprietary and confidential. Unauthorized copying is prohibited.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function bindingPath(stateDir, key) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw new Error("Invalid session key");
  return path.join(stateDir, "agent-bindings", `${key}.json`);
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

/** Binds a local session to its owning T3 thread's webhook. The credential never enters session JSON. */
export async function bindAgentNudge(stateDir, key, webhook) {
  const file = bindingPath(stateDir, key);
  if (webhook === null) {
    await rm(file, { force: true });
    return;
  }
  const url = validateWebhook(webhook);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ webhook: url }), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readBinding(stateDir, key) {
  try {
    const value = JSON.parse(await readFile(bindingPath(stateDir, key), "utf8"));
    return validateWebhook(value.webhook);
  } catch {
    return null;
  }
}

/** Coalesces clicks across tabs. A timeout is ambiguous, so failed attempts also keep a brief cooldown. */
export function createAgentNudger(stateDir, { request = fetch, now = Date.now, cooldownMs = 15_000 } = {}) {
  /** @type {Map<string, Promise<{status: string}>>} */
  const pending = new Map();
  /** @type {Map<string, number>} */
  const recent = new Map();
  return {
    available: async (key) => (await readBinding(stateDir, key)) !== null,
    async send(session) {
      if (pending.has(session.key)) return pending.get(session.key);
      const attempt = (async () => {
        const webhook = await readBinding(stateDir, session.key);
        if (!webhook) return { status: "unavailable" };
        const timestamp = now();
        for (const [key, at] of recent) if (timestamp - at >= cooldownMs) recent.delete(key);
        if (recent.has(session.key)) return { status: "recently-sent" };
        recent.set(session.key, timestamp);
        try {
          const response = await request(webhook, {
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
