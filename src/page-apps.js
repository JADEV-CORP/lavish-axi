// Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE.
// Page apps: what an artifact can do beyond review. `window.lavish.store` keeps JSON per page,
// `window.lavish.ask` puts a question to the agent and waits for its reply, `window.lavish.files.pick`
// lets the reviewer hand files to the agent, and `window.lavish.download` saves a file.
//
// The artifact SDK inlines this module with serializeModuleHelpers, so every export is a function
// that uses only its own arguments, browser globals, and sibling exports. The server imports the
// same limits and validators, so the frame and the server measure the same way. The chrome is a
// raw file that cannot import modules: it gets the limits through the session JSON and repeats
// its own checks (src/chrome-client.js, handlePageAppRequest).

/**
 * The limits every hop applies. Overrides come from the server (createSdkJs) so the SDK can refuse
 * early what the server would refuse anyway.
 * @param {Record<string, number>} [overrides]
 */
export function pageAppLimits(overrides) {
  const defaults = {
    // Page storage.
    storeKeyMaxChars: 256,
    storeValueMaxBytes: 1024 * 1024,
    storePageMaxBytes: 5 * 1024 * 1024,
    storeMaxKeys: 10000,
    // Ask the agent.
    askQuestionMaxChars: 4000,
    askContextMaxChars: 64 * 1024,
    askDefaultTimeoutMs: 5 * 60 * 1000,
    askMinTimeoutMs: 10 * 1000,
    askMaxTimeoutMs: 30 * 60 * 1000,
    // Files out.
    downloadMaxBytes: 50 * 1024 * 1024,
    downloadNameMaxChars: 200,
    // Files in: the attachment store's own limits, threaded in by the server.
    pickMaxFiles: 20,
    pickMaxBytes: 10 * 1024 * 1024,
  };
  /** @type {Record<string, number>} */
  const limits = { ...defaults };
  for (const name of Object.keys(defaults)) {
    const value = overrides ? Number(overrides[name]) : NaN;
    if (Number.isFinite(value) && value > 0) limits[name] = Math.floor(value);
  }
  return limits;
}

/** An Error a page can show: `code` is stable, `message` is written for a person. */
export function pageAppError(code, message) {
  const error = new Error(String(message || "Lavish could not do that."));
  error.name = "LavishError";
  /** @type {any} */ (error).code = String(code || "FAILED");
  return error;
}

/** UTF-8 length of a string, counted without allocating (the frame may lack TextEncoder). */
export function utf8ByteLength(text) {
  const value = String(text);
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Why a storage key is refused, or "" when it is fine. Keys are non-empty strings without control
 * characters, so `lavish data` prints them as they are.
 * @param {unknown} key
 * @param {Record<string, number>} limits
 */
export function pageStoreKeyError(key, limits) {
  if (typeof key !== "string" || key.length === 0) return "A storage key must be a non-empty string.";
  if (key.length > limits.storeKeyMaxChars) {
    return "A storage key is limited to " + limits.storeKeyMaxChars + " characters.";
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return "A storage key cannot contain control characters.";
  return "";
}

/**
 * The JSON text a value is stored as, or why it cannot be stored.
 * @param {unknown} value
 * @param {Record<string, number>} limits
 * @returns {{ json: string, bytes: number } | { code: string, error: string }}
 */
export function pageStoreValueJson(value, limits) {
  if (value === undefined) {
    return { code: "VALUE_INVALID", error: "A stored value cannot be undefined. Use delete(key) to remove one." };
  }
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return { code: "VALUE_INVALID", error: "The value is not JSON: it is circular or holds a BigInt." };
  }
  if (typeof json !== "string") {
    return { code: "VALUE_INVALID", error: "The value is not JSON: functions and symbols cannot be stored." };
  }
  const bytes = utf8ByteLength(json);
  if (bytes > limits.storeValueMaxBytes) {
    return {
      code: "VALUE_TOO_LARGE",
      error: "One stored value is limited to " + Math.floor(limits.storeValueMaxBytes / 1024) + " KB of JSON.",
    };
  }
  return { json, bytes };
}

/**
 * A file name the browser can save as: path separators and characters Windows refuses become `_`,
 * control characters go, and leading or trailing dots and spaces are trimmed.
 * @param {unknown} name
 * @param {Record<string, number>} limits
 * @returns {{ name: string } | { error: string }}
 */
export function sanitizeDownloadName(name, limits) {
  if (typeof name !== "string") return { error: "A download needs a file name." };
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if (!cleaned) return { error: "A download needs a file name with at least one letter or digit." };
  if (cleaned.length > limits.downloadNameMaxChars) {
    return { error: "A download name is limited to " + limits.downloadNameMaxChars + " characters." };
  }
  return { name: cleaned };
}

/** A MIME type safe to hand to Blob, or the generic binary type. */
export function downloadMimeType(type) {
  const value = typeof type === "string" ? type.trim().toLowerCase() : "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(;\s*charset=[a-z0-9_-]{1,40})?$/.test(
    value,
  )
    ? value
    : "application/octet-stream";
}

/**
 * The `accept` tokens a page passed to files.pick, bounded: MIME types, `type/*`, or `.ext`.
 * @param {unknown} accept
 * @returns {string[]}
 */
export function normalizeAcceptTokens(accept) {
  const raw = typeof accept === "string" ? accept.split(",") : Array.isArray(accept) ? accept : [];
  const tokens = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const token = item.trim().toLowerCase();
    if (!token || token.length > 100) continue;
    if (/^\.[a-z0-9]{1,10}$/.test(token) || /^[a-z]+\/([a-z0-9.+-]+|\*)$/.test(token)) tokens.push(token);
    if (tokens.length >= 20) break;
  }
  return tokens;
}

/**
 * Build `window.lavish.store`, `ask`, `files` and `download` over one request channel to the chrome.
 * Every request carries an id and this document's nonce; the chrome answers with
 * `lavish:pageAppResult`, first `pending` when the work takes a while (an ask waiting for the agent,
 * an open file picker), then once with the result.
 * @param {{ post: (type: string, payload: Record<string, unknown>) => void, nonce: string, limits: Record<string, number>, encodeToon: (value: unknown) => string }} deps
 */
export function createPageApps(deps) {
  const limits = deps.limits;
  const pending = new Map();
  let sequence = 0;
  let askInFlight = false;
  // How long the chrome has to answer before the page hears that Lavish is not there: an older
  // Lavish, or the page opened straight from disk with a copy of the SDK.
  const answerMs = 15000;

  function request(op, payload) {
    return new Promise((resolve, reject) => {
      sequence += 1;
      const id = "r" + sequence;
      /** @type {{ resolve: (value: any) => void, reject: (error: Error) => void, timer: any, arm: (ms: number) => void }} */
      const entry = { resolve, reject, timer: 0, arm: () => {} };
      // (Re)start the wait for the chrome's next word; 0 waits without limit (an open file picker).
      entry.arm = (ms) => {
        clearTimeout(entry.timer);
        entry.timer =
          ms > 0
            ? setTimeout(() => {
                if (!pending.has(id)) return;
                pending.delete(id);
                reject(pageAppError("UNAVAILABLE", "Lavish did not answer. Open this page in Lavish and try again."));
              }, ms)
            : 0;
      };
      pending.set(id, entry);
      entry.arm(answerMs);
      deps.post("lavish:pageApp", { ...payload, id, op, nonce: deps.nonce });
    });
  }

  // Returns true when the message was a page-app result for this document.
  function handleResult(message) {
    if (!message || message.type !== "lavish:pageAppResult") return false;
    if (typeof message.nonce !== "string" || message.nonce !== deps.nonce) return true;
    const entry = pending.get(message.id);
    if (!entry) return true;
    if (message.pending === true) {
      const waitMs = Number(message.wait_ms);
      entry.arm(Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0);
      return true;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok === true) entry.resolve(message.value);
    else entry.reject(pageAppError(message.code, message.error));
    return true;
  }

  function refuse(code, message) {
    return Promise.reject(pageAppError(code, message));
  }

  const store = {
    /** @param {string} key */
    get(key) {
      const error = pageStoreKeyError(key, limits);
      if (error) return refuse("KEY_INVALID", error);
      return request("store.get", { key }).then((result) =>
        result && result.found === true ? result.value : undefined,
      );
    },
    /** @param {string} key @param {unknown} value */
    set(key, value) {
      const error = pageStoreKeyError(key, limits);
      if (error) return refuse("KEY_INVALID", error);
      const stored = pageStoreValueJson(value, limits);
      if ("error" in stored) return refuse(stored.code, stored.error);
      return request("store.set", { key, json: stored.json }).then(() => undefined);
    },
    /** @param {string} key */
    delete(key) {
      const error = pageStoreKeyError(key, limits);
      if (error) return refuse("KEY_INVALID", error);
      return request("store.delete", { key }).then((result) => Boolean(result && result.deleted));
    },
    /** @param {string} [prefix] */
    list(prefix) {
      const text = prefix === undefined || prefix === null ? "" : prefix;
      if (typeof text !== "string" || text.length > limits.storeKeyMaxChars) {
        return refuse("KEY_INVALID", "A list prefix is a string of up to " + limits.storeKeyMaxChars + " characters.");
      }
      return request("store.list", { prefix: text }).then((result) =>
        Array.isArray(result && result.keys) ? result.keys.map(String) : [],
      );
    },
  };

  /**
   * @param {string} question
   * @param {{ data?: unknown, timeoutMs?: number, attachments?: Array<{ id: string, name?: string }> }} [options]
   */
  function ask(question, options) {
    const settings = options || {};
    if (typeof question !== "string" || !question.trim()) return refuse("INVALID", "Ask needs a question.");
    if (question.length > limits.askQuestionMaxChars) {
      return refuse("TOO_LARGE", "A question is limited to " + limits.askQuestionMaxChars + " characters.");
    }
    let context = "";
    if (settings.data !== undefined) {
      try {
        context = deps.encodeToon(settings.data);
      } catch {
        return refuse("INVALID", "The question's data could not be read.");
      }
      if (context.length > limits.askContextMaxChars) {
        return refuse("TOO_LARGE", "The question's data is limited to " + limits.askContextMaxChars + " characters.");
      }
    }
    const requested = Number(settings.timeoutMs);
    const timeoutMs = Number.isFinite(requested)
      ? Math.min(limits.askMaxTimeoutMs, Math.max(limits.askMinTimeoutMs, Math.floor(requested)))
      : limits.askDefaultTimeoutMs;
    const attachments = (Array.isArray(settings.attachments) ? settings.attachments : [])
      .filter((item) => item && typeof item.id === "string" && item.id)
      .map((item) => (typeof item.name === "string" && item.name ? { id: item.id, name: item.name } : { id: item.id }));
    // One question at a time per page: an answer then always belongs to the question in flight.
    if (askInFlight) return refuse("ASK_BUSY", "This page is already waiting for an answer from the agent.");
    askInFlight = true;
    const sent = request("ask", { question, context, timeout_ms: timeoutMs, attachments }).then((value) =>
      String(value === undefined || value === null ? "" : value),
    );
    sent.then(
      () => {
        askInFlight = false;
      },
      () => {
        askInFlight = false;
      },
    );
    return sent;
  }

  const files = {
    /** @param {{ accept?: string | string[], multiple?: boolean }} [options] */
    pick(options) {
      const settings = options || {};
      return request("files.pick", {
        accept: normalizeAcceptTokens(settings.accept),
        multiple: settings.multiple === true,
      }).then((value) =>
        (Array.isArray(value) ? value : []).map((file) => ({
          id: String(file.id),
          name: String(file.name),
          size: Number(file.size) || 0,
          type: String(file.type || ""),
        })),
      );
    },
  };

  /**
   * @param {string} name
   * @param {string | Blob | ArrayBuffer | ArrayBufferView} content
   * @param {string} [type]
   */
  async function download(name, content, type) {
    const checked = sanitizeDownloadName(name, limits);
    if ("error" in checked) throw pageAppError("NAME_INVALID", checked.error);
    let bytes;
    let defaultType = "application/octet-stream";
    if (typeof content === "string") {
      bytes = new TextEncoder().encode(content).buffer;
      defaultType = "text/plain;charset=utf-8";
    } else if (typeof Blob !== "undefined" && content instanceof Blob) {
      if (content.size > limits.downloadMaxBytes) throw downloadTooLarge();
      bytes = await content.arrayBuffer();
      defaultType = content.type || defaultType;
    } else if (content instanceof ArrayBuffer) {
      bytes = content.slice(0);
    } else if (ArrayBuffer.isView(content)) {
      bytes = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    } else {
      throw pageAppError("INVALID", "A download takes a string, a Blob, or bytes.");
    }
    if (bytes.byteLength > limits.downloadMaxBytes) throw downloadTooLarge();
    await request("download", { name: checked.name, type: downloadMimeType(type || defaultType), bytes });
  }

  function downloadTooLarge() {
    return pageAppError(
      "TOO_LARGE",
      "A download is limited to " + Math.floor(limits.downloadMaxBytes / (1024 * 1024)) + " MB.",
    );
  }

  return { api: { store, ask, files, download }, handleResult };
}
