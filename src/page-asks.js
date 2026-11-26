// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
// Ask the agent from the page (`window.lavish.ask`). An ask is a prompt tagged "ask" whose target
// names the ask, plus a small record on the session (`session.asks`) that says how it ended. These
// pure functions decide an ask's state and which ask an agent reply answers; SessionStore applies
// them under its lock.
//
// Life of an ask: pending (its prompt waits in the queue) -> delivered (a poll took it) -> answered
// (an agent reply named it, or was the next reply after delivery). It can also end expired (its
// deadline passed) or superseded (the page asked again). Pending and delivered are derived, not
// stored: a prompt still in `session.prompts` is pending, which keeps a closed-poll restore right
// without any extra bookkeeping.

export const ASK_TARGET_TYPE = "ask";
export const ASK_TAG = "ask";
// Records kept per session, so a late `--ask` names what happened instead of "unknown".
export const MAX_STORED_ASKS = 20;
export const ASK_ID_RE = /^ask-[0-9a-f]{8}$/;

/** @param {string} hex eight lowercase hex digits */
export function askId(hex) {
  return `ask-${String(hex).slice(0, 8)}`;
}

export function isAskPrompt(prompt) {
  return Boolean(prompt && prompt.target && prompt.target.type === ASK_TARGET_TYPE && prompt.target.ask_id);
}

/** The prompt text the agent reads: the question, then the page's data as TOON. */
export function askPromptText(question, context = "") {
  const text = String(question).trim();
  return context ? `${text}\n\nContext data:\n${context}` : text;
}

/**
 * @param {{ id: string, status?: string, expires_at: string }} record
 * @param {any[]} prompts the session's pending prompts
 * @param {number} now
 * @returns {"pending" | "delivered" | "answered" | "expired" | "superseded"}
 */
export function askStatus(record, prompts, now) {
  if (record.status === "answered" || record.status === "superseded") return record.status;
  if (!(Date.parse(record.expires_at) > now)) return "expired";
  const waiting = (Array.isArray(prompts) ? prompts : []).some(
    (prompt) => isAskPrompt(prompt) && prompt.target.ask_id === record.id,
  );
  return waiting ? "pending" : "delivered";
}

export function isOpenAskStatus(status) {
  return status === "pending" || status === "delivered";
}

/**
 * The ask an agent reply answers. With an explicit id, that ask, which must still be open. Without
 * one, the oldest ask the agent has received (delivered) and not answered; a reply written before
 * the agent saw an ask never answers it.
 * @param {any[]} asks
 * @param {any[]} prompts
 * @param {{ askId?: string, now: number }} options
 * @returns {{ ask: any | null } | { error: { code: string, status?: string, message: string } }}
 */
export function replyTargetAsk(asks, prompts, { askId: wanted = "", now }) {
  const records = Array.isArray(asks) ? asks : [];
  if (wanted) {
    const record = records.find((entry) => entry && entry.id === wanted);
    if (!record) {
      return { error: { code: "ASK_NOT_FOUND", message: `This page has no question ${wanted}.` } };
    }
    const status = askStatus(record, prompts, now);
    if (!isOpenAskStatus(status)) {
      return { error: { code: "ASK_CLOSED", status, message: closedAskMessage(record, status) } };
    }
    return { ask: record };
  }
  const delivered = records.find((entry) => entry && askStatus(entry, prompts, now) === "delivered");
  return { ask: delivered || null };
}

function closedAskMessage(record, status) {
  if (status === "answered") return `Question ${record.id} was already answered.`;
  if (status === "superseded") return `Question ${record.id} was replaced by a newer question from the page.`;
  return `Question ${record.id} expired at ${record.expires_at}: the page stopped waiting for it.`;
}

/** Keep the newest records only; an open ask is never dropped. */
export function boundAsks(asks, prompts, now) {
  const records = Array.isArray(asks) ? asks.filter(Boolean) : [];
  if (records.length <= MAX_STORED_ASKS) return records;
  const open = new Set(records.filter((record) => isOpenAskStatus(askStatus(record, prompts, now))));
  const closed = records.filter((record) => !open.has(record));
  const dropCount = records.length - MAX_STORED_ASKS;
  const dropped = new Set(closed.slice(0, dropCount));
  return records.filter((record) => !dropped.has(record));
}
