/* global document, location, window */

const sessionDataElement = document.getElementById("lavish-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const filePath = String(sessionData.file || "");
const queueStorageKey = "lavish-axi:queued:" + key;
const terminalStorageKey = "lavish-axi:terminal:" + key;
// Review-chrome state that must survive a browser refresh. Keyed per session so one review's
// triage can never leak into another artifact's.
const warningSelectionStorageKey = "lavish-axi:warning-selection:" + key;
// Unsent annotation-card text lives only in the sandboxed iframe, so a full page reload would
// destroy it unless the chrome persists what the SDK reports. Keyed per session like the queue,
// so a draft can never reappear over a different artifact.
const reviewStateStorageKey = "lavish-axi:review-state:" + key;
// Drafts Lavish could not replay. The text outlives the draft that carried it, so the user can
// still read and copy it after the anchor it was written against is gone for good.
const retiredDraftStorageKey = "lavish-axi:retired-drafts:" + key;
/** @type {any[]} */
const retiredDraftNodes = [];
const internalQueueKeyField = "_lavishQueueKey";
const promptIdentityField = "prompt_id";
const PROMPT_IDENTITY_MAX = 128;
const PROMPT_IDENTITY_RE = /^[A-Za-z0-9_-]+$/;
const initialChat = Array.isArray(sessionData.initialChat) ? sessionData.initialChat : [];
const initialChatAckIds = Array.isArray(sessionData.initialChatAckIds) ? sessionData.initialChatAckIds : [];
const initialChatRevision = parseChatRevision(sessionData.initialChatRevision) || 0;
const MODE_TOGGLE_HOTKEY_KEY = String(sessionData.modeToggleHotkeyKey || "").toLowerCase();
const attachmentMaxBytes = Number(sessionData.attachmentMaxBytes) || 0;
const attachmentMaxCount = Number(sessionData.attachmentMaxCount) || 4;
// Threaded from the server's single accepted-image list, which also drives the
// file picker's accept attribute, so the two can never disagree. An unwired
// list falls back to the same defaults as the SDK's acceptedImageTypes - an
// empty Set would refuse every image while the card in the same session
// accepts them, the exact divergence the single list exists to prevent.
const CHAT_ATTACHMENT_MIME = new Set(
  (Array.isArray(sessionData.attachmentAcceptedMime) && sessionData.attachmentAcceptedMime.length
    ? sessionData.attachmentAcceptedMime
    : ["image/png", "image/jpeg", "image/webp"]
  ).map(String),
);
// Named in the rejection copy, so the message can never tell the user to use a
// format this build does not accept.
const CHAT_ATTACHMENT_LABELS = (() => {
  const labels = [...CHAT_ATTACHMENT_MIME].map((mime) => mime.replace(/^image\//, "").toUpperCase());
  if (labels.length < 2) return labels.join("");
  return labels.slice(0, -1).join(", ") + (labels.length > 2 ? ", or " : " or ") + labels[labels.length - 1];
})();

// The chrome is the only path from the sandboxed (opaque-origin) artifact iframe to
// the loopback server, so it is the sole place a same-origin confused-deputy can be
// mediated: the frame's postMessage source check proves a message came from the
// artifact frame but NOT that a user gesture (paste/drop/pick) drove it, so hostile
// artifact script could otherwise drive unbounded uploads. Bound both the rate and
// the cumulative bytes per chrome session here; the server keeps a bounded disk
// quota as the durable backstop.
const UPLOAD_RATE_WINDOW_MS = 60_000;
const UPLOAD_RATE_MAX = 30;
const UPLOAD_SESSION_BYTE_QUOTA = 256 * 1024 * 1024; // 256 MiB per chrome session
// The rate and cumulative-byte guards bound uploads over time, but not how many run
// AT ONCE: each accepted message starts fetch() immediately, so a hostile artifact
// could post ~30 large bodies in one tick and hold hundreds of MiB of structured
// clones + server body buffers concurrently before the cumulative quota trips (D8).
// Cap the number in flight; the over-cap ones are refused with a retry hint (like the
// rate guard) and a freed slot admits the next.
const UPLOAD_MAX_IN_FLIGHT = 4;
const uploadTimestamps = [];
let uploadedBytesTotal = 0;
let uploadsInFlight = 0;

function formatByteLimit(bytes) {
  if (bytes >= 1024 * 1024) return Math.round(bytes / (1024 * 1024)) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " bytes";
}

// Turn the server's atomic-reject detail (C4) into one human line naming the cap
// that was hit, so the user knows what to fix. Nothing was delivered - the queue is
// preserved - so the wording is about correcting, not about a partial send.
function describeAttachmentRejection(rejected, caps) {
  const reasons = new Set(rejected.map((ref) => ref && ref.reason));
  const parts = [];
  if (reasons.has("prompt-bytes-exceeded") && caps && caps.maxPromptBytes) {
    parts.push("images exceed the " + formatByteLimit(caps.maxPromptBytes) + " per-prompt limit");
  }
  if (reasons.has("too-many") && caps && caps.maxPerPrompt) {
    parts.push("more than " + caps.maxPerPrompt + " images on one prompt");
  }
  if (reasons.has("too-many-in-request")) {
    parts.push("too many images queued at once");
  }
  if (reasons.has("malformed")) {
    parts.push("an image attachment was malformed");
  }
  if (reasons.has("not-found")) {
    parts.push("an image is no longer available");
  }
  const detail = parts.length ? parts.join("; ") : "some attachments could not be delivered";
  return "Not sent — " + detail + ". Remove or fix the image, then send again.";
}

function isModeToggleHotkeyEvent(event) {
  if (event.shiftKey || event.altKey) return false;
  return Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === MODE_TOGGLE_HOTKEY_KEY;
}

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const panelScroll = /** @type {HTMLDivElement} */ (document.getElementById("panelScroll"));
const queuedLog = /** @type {HTMLDivElement} */ (document.getElementById("queuedLog"));
const chatLog = /** @type {HTMLDivElement} */ (document.getElementById("chatLog"));
const chatComposer = /** @type {HTMLDivElement} */ (document.getElementById("chatComposer"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const chatAttachments = /** @type {HTMLDivElement} */ (document.getElementById("chatAttachments"));
const messageMarks = /** @type {HTMLDivElement} */ (document.getElementById("messageMarks"));
const chatAttachButton = /** @type {HTMLButtonElement} */ (document.getElementById("chatAttach"));
const chatAttachInput = /** @type {HTMLInputElement} */ (document.getElementById("chatAttachInput"));
const chatAttachmentNotice = /** @type {HTMLSpanElement} */ (document.getElementById("chatAttachmentNotice"));
const panel = /** @type {HTMLElement} */ (document.getElementById("panel"));
const panelHead = /** @type {HTMLDivElement} */ (document.getElementById("panelHead"));
const panelSummary = /** @type {HTMLSpanElement} */ (document.getElementById("panelSummary"));
const panelToggle = /** @type {HTMLButtonElement} */ (document.getElementById("panelToggle"));
const panelToggleIcon = /** @type {HTMLSpanElement} */ (document.getElementById("panelToggleIcon"));
const panelScrim = /** @type {HTMLDivElement} */ (document.getElementById("panelScrim"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const sendAndEndButton = /** @type {HTMLButtonElement} */ (document.getElementById("sendAndEnd"));
const annotationSwitch = /** @type {HTMLButtonElement} */ (document.getElementById("annotation"));
const modeInteractButton = /** @type {HTMLButtonElement} */ (document.getElementById("modeInteract"));
const railAnnotateButton = /** @type {HTMLButtonElement} */ (document.getElementById("railAnnotate"));
const moreWrap = /** @type {HTMLDivElement} */ (document.getElementById("moreWrap"));
const moreButton = /** @type {HTMLButtonElement} */ (document.getElementById("moreButton"));
const moreMenu = /** @type {HTMLDivElement} */ (document.getElementById("moreMenu"));
const reloadArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("reloadArtifact"));
const copySnapshotButton = /** @type {HTMLButtonElement} */ (document.getElementById("copySnapshot"));
const exportArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("exportArtifact"));
const shareArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("shareArtifact"));
const shareDialog = /** @type {HTMLDivElement} */ (document.getElementById("shareDialog"));
const shareForm = /** @type {HTMLFormElement} */ (document.getElementById("shareForm"));
const shareCloseButton = /** @type {HTMLButtonElement} */ (document.getElementById("shareClose"));
const shareCancelButton = /** @type {HTMLButtonElement} */ (document.getElementById("shareCancel"));
const sharePublishButton = /** @type {HTMLButtonElement} */ (document.getElementById("sharePublish"));
const sharePasswordInput = /** @type {HTMLInputElement} */ (document.getElementById("sharePassword"));
const shareStatus = /** @type {HTMLDivElement} */ (document.getElementById("shareStatus"));
const shareResult = /** @type {HTMLDivElement} */ (document.getElementById("shareResult"));
const shareUrlInput = /** @type {HTMLInputElement} */ (document.getElementById("shareUrl"));
const shareUpdateKeyInput = /** @type {HTMLInputElement} */ (document.getElementById("shareUpdateKey"));
const shareGenerateInput = /** @type {HTMLInputElement} */ (document.getElementById("shareGenerate"));
const sharePasswordResult = /** @type {HTMLLabelElement} */ (document.getElementById("sharePasswordResult"));
const shareUrlResult = /** @type {HTMLLabelElement} */ (document.getElementById("shareUrlResult"));
const shareUpdateKeyResult = /** @type {HTMLLabelElement} */ (document.getElementById("shareUpdateKeyResult"));
const shareUpdateKeyNote = /** @type {HTMLParagraphElement} */ (document.getElementById("shareUpdateKeyNote"));
const shareSiteIdResult = /** @type {HTMLLabelElement} */ (document.getElementById("shareSiteIdResult"));
const shareSiteIdInput = /** @type {HTMLInputElement} */ (document.getElementById("shareSiteId"));
const sharePasswordOutput = /** @type {HTMLInputElement} */ (document.getElementById("sharePasswordOut"));
const copySharePasswordButton = /** @type {HTMLButtonElement} */ (document.getElementById("copySharePassword"));
const copyShareUrlButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyShareUrl"));
const copyUpdateKeyButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyUpdateKey"));
const copyShareSiteIdButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyShareSiteId"));
const endButton = /** @type {HTMLButtonElement} */ (document.getElementById("end"));
const copyPathButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyPath"));
const copyHint = /** @type {HTMLSpanElement} */ (document.getElementById("copyHint"));
const copyHintText = /** @type {HTMLSpanElement} */ (document.getElementById("copyHintText"));
const presenceBanner = /** @type {HTMLDivElement} */ (document.getElementById("presenceBanner"));
const agentStatus = /** @type {HTMLSpanElement} */ (document.getElementById("agentStatus"));
const agentStatusText = /** @type {HTMLSpanElement} */ (document.getElementById("agentStatusText"));
const chatSuggestions = /** @type {HTMLDivElement} */ (document.getElementById("chatSuggestions"));
const handoffBanner = /** @type {HTMLDivElement} */ (document.getElementById("handoffBanner"));
const handoffTakeoverButton = /** @type {HTMLButtonElement} */ (document.getElementById("handoffTakeover"));
const outdatedBanner = /** @type {HTMLDivElement} */ (document.getElementById("outdatedBanner"));
const outdatedText = /** @type {HTMLSpanElement} */ (document.getElementById("outdatedText"));
const outdatedReloadButton = /** @type {HTMLButtonElement} */ (document.getElementById("outdatedReload"));
const outdatedDismissButton = /** @type {HTMLButtonElement} */ (document.getElementById("outdatedDismiss"));
const endedOverlay = /** @type {HTMLDivElement} */ (document.getElementById("endedOverlay"));
const layoutGateOverlay = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateOverlay"));
const layoutGateTitle = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateTitle"));
const layoutGateCopy = /** @type {HTMLParagraphElement} */ (document.getElementById("layoutGateCopy"));
const layoutGateAction = /** @type {HTMLButtonElement} */ (document.getElementById("layoutGateAction"));
const layoutGateBypass = /** @type {HTMLButtonElement} */ (document.getElementById("layoutGateBypass"));
const layoutGateEscape = /** @type {any} */ (window).__lavishLayoutGateEscape;
const warningsWrap = /** @type {HTMLDivElement} */ (document.getElementById("warningsWrap"));
const warningsButton = /** @type {HTMLButtonElement} */ (document.getElementById("warningsButton"));
const warningsCount = /** @type {HTMLSpanElement} */ (document.getElementById("warningsCount"));
const warningsDrawer = /** @type {HTMLDivElement} */ (document.getElementById("warningsDrawer"));
const warningsSummary = /** @type {HTMLParagraphElement} */ (document.getElementById("warningsSummary"));
const warningsSelectAll = /** @type {HTMLInputElement} */ (document.getElementById("warningsSelectAll"));
const warningsSelected = /** @type {HTMLSpanElement} */ (document.getElementById("warningsSelected"));
const warningsList = /** @type {HTMLDivElement} */ (document.getElementById("warningsList"));
const warningsQueueButton = /** @type {HTMLButtonElement} */ (document.getElementById("warningsQueueButton"));
const revisionsWrap = /** @type {HTMLDivElement} */ (document.getElementById("revisionsWrap"));
const revisionsButton = /** @type {HTMLButtonElement} */ (document.getElementById("revisionsButton"));
const revisionsCount = /** @type {HTMLSpanElement} */ (document.getElementById("revisionsCount"));
const revisionsLatest = /** @type {HTMLSpanElement} */ (document.getElementById("revisionsLatest"));
const revisionsDrawer = /** @type {HTMLDivElement} */ (document.getElementById("revisionsDrawer"));
const revisionsSummary = /** @type {HTMLParagraphElement} */ (document.getElementById("revisionsSummary"));
const revisionsList = /** @type {HTMLDivElement} */ (document.getElementById("revisionsList"));
const sendHint = /** @type {HTMLDivElement} */ (document.getElementById("sendHint"));
const queuePanel = /** @type {HTMLDivElement} */ (document.getElementById("queuePanel"));
const queueToggle = /** @type {HTMLButtonElement} */ (document.getElementById("queueToggle"));
const queueCount = /** @type {HTMLSpanElement} */ (document.getElementById("queueCount"));
const editBar = /** @type {HTMLDivElement} */ (document.getElementById("editBar"));
const editBarText = /** @type {HTMLSpanElement} */ (document.getElementById("editBarText"));
const COMPOSER_PLACEHOLDER = "Ask for a change, or annotate the artifact";
const promptInput = /** @type {HTMLDivElement} */ (document.getElementById("promptInput"));
const whiteboardOverlay = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardOverlay"));
const whiteboardFrame = /** @type {HTMLIFrameElement} */ (document.getElementById("whiteboardFrame"));
const whiteboardCloseButton = /** @type {HTMLButtonElement} */ (document.getElementById("whiteboardClose"));
const whiteboardError = /** @type {HTMLDivElement} */ (document.getElementById("whiteboardError"));
const artifactSrc = frame.dataset.artifactSrc || frame.getAttribute?.("data-artifact-src") || frame.src || "";

const queued = loadQueuedPrompts();
// Marked blocks waiting in the message box as numbered chips. They leave with the next message.
/** @type {Array<Record<string, any>>} */
const marks = [];
let renderedMarks = "";
let annotation = true;
let ended = false;
let agentPresence = "waiting";
const layoutGateEnabled = sessionData.layoutGateEnabled !== false;
const configuredLayoutGateMaxHoldMs = Number(sessionData.layoutGateMaxHoldMs);
const layoutGateMaxHoldMs =
  Number.isFinite(configuredLayoutGateMaxHoldMs) && configuredLayoutGateMaxHoldMs > 0
    ? Math.min(configuredLayoutGateMaxHoldMs, 60_000)
    : 12_000;
let chromeOutdatedReason = "";
let chromeOutdatedGeneration = 0;
let outdatedReloadInFlight = false;
// The live-event socket reconnects forever on a 5s cap. Silence there is indistinguishable from a
// healthy idle stream, so a page whose server has gone away keeps rendering its last state and
// tells the user nothing until they reload into a connection error. Past this many consecutive
// failures the banner says so, with the health-probed reload the banner already offers.
const LIVE_EVENT_UNREACHABLE_FAILURES = 5;
let liveEventFailures = 0;
// Only a banner this path raised may be hidden by this path: a `chrome-outdated` event means the
// server was replaced, which a reconnect does not disprove.
let unreachableBannerOwned = false;
let unreachableDismissed = false;
/** @type {{ selector: string, revision: number } | null} */
let unrestorableDraftMiss = null;
let retiredDrafts = loadRetiredDrafts();
let layoutGateVisible = false;
let layoutGateManuallyBypassed = !layoutGateEnabled;
let layoutGateFailureActive = false;
// A failure only the user can retire. The artifact-load card clears itself once a load succeeds;
// the server-replacement card must not, because the page is still running the pre-upgrade client
// against the replacement server and nothing else would tell the user that.
let layoutGateFailureSticky = false;
let layoutGateCycle = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let layoutGateTimer;
// The warning inbox is server-owned review state. The chrome renders it and posts triage
// actions; it never decides on its own that a warning went away.
let layoutWarnings = Array.isArray(sessionData.initialLayoutWarnings) ? sessionData.initialLayoutWarnings : [];
const selectedWarningIds = new Set(loadJsonState(warningSelectionStorageKey, []));
let warningsDrawerOpen = false;
/** @typedef {{ done: Promise<boolean>, finish: (succeeded: boolean) => void }} FeedbackPreparation */
/** @typedef {{ prompts: any[], inFlight: boolean, order: number }} TerminalSubmission */
/** @type {Map<string, { action: "copy" | "submit", prompts?: any[], chatAtRequest?: any[], endAfter?: boolean, terminal?: TerminalSubmission | null, acknowledgement?: object, order?: number, timeout?: ReturnType<typeof setTimeout> }>} */
const snapshotRequests = new Map();
let nextSnapshotRequestId = 0;
let nextSendOperationOrder = 0;
let workingBubble = null;
// The shadcn/ui Spinner: lucide's loader-circle, rotating. An open arc is a circle in its own right,
// so it never depends on the chrome's radius tokens (Lyra's square corners turned a border ring
// into a spinning square).
const SPINNER_SVG =
  '<svg class="spinner" role="status" aria-label="Loading" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
let displayedChat = initialChat.slice();
let chatRevision = initialChatRevision;
// Settlement is by per-submission identity, not displayed content: two tabs can queue notes
// whose chat projection is identical (same selected text under one container, different range
// boundaries) without settling each other, and a reload after a lost POST response still
// recognizes an already-accepted note.
let submitQueuedPromise = null;
const pendingSubmissions = [];
/** @type {{ prompts?: any[] } | null} */
let activeSubmission = null;
const deliveredPrompts = new WeakSet();
const pendingAcknowledgements = new Set();
/** @type {Set<FeedbackPreparation>} */
const feedbackPreparations = new Set();
/** @type {TerminalSubmission | null} */
let terminalSubmission =
  loadJsonState(terminalStorageKey, false) === true
    ? { prompts: queued.slice(), inFlight: false, order: ++nextSendOperationOrder }
    : null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendAcknowledgementTimer;
let lastScroll = { x: 0, y: 0 };
// The queued note open for editing in the panel, by prompt identity, and its unsaved words.
let editingPromptId = "";
let editingDraft = "";
let editFocusPending = false;
// The selectors and pins last told to the artifact, so a render that changes nothing stays quiet.
let postedQueuedAnchors = "[[],[]]";
// In-iframe review context (an open annotation card's unsent text, Lavish-owned question
// answers). The sandbox means the chrome cannot read it back after a reload, so the SDK reports
// it as it changes and the chrome replays it once the new document is up. It is persisted per
// session so a full page reload replays it too.
let lastReviewState = loadJsonState(reviewStateStorageKey, null);
if (lastReviewState && typeof lastReviewState !== "object") lastReviewState = null;
const ARTIFACT_SILENCE_PROBE_MS = 8000;
const ARTIFACT_LOAD_BEGIN_RETRY_DELAYS_MS = [100, 300];
// Backoff for retrying a whole begin-load attempt after its in-call retries ran out. The
// in-call retries span 400ms, which only covers a slow response - not the multi-second window
// where the server is being replaced (a version-driven restart, or another `lavish-axi <file>`
// invocation restarting the shared server). Without these the chrome abandons the artifact for
// good: the frame is never navigated, `artifact_revision` never advances, and the page sits on
// the layout gate and then on an empty frame with nothing to click.
const ARTIFACT_LOAD_RECOVERY_DELAYS_MS = [1000, 3000, 8000, 20000];
// How long a chrome told to reload after a server restart keeps probing /health before giving
// up, and how long it waits for an outage to appear at all before treating a healthy answer as
// "the server never went away".
const CHROME_RESTART_SETTLE_MS = 5000;
const CHROME_RESTART_WAIT_MS = 60000;
// Probe fast while the replacement is expected to bind, then back off: a server that never comes
// back would otherwise spend the whole wait filling the network log with refused connections.
const CHROME_RESTART_PROBE_MS = 100;
const CHROME_RESTART_SLOW_PROBE_MS = 500;
// A probe must always settle, so the control that is waiting on it always comes back.
const HEALTH_PROBE_TIMEOUT_MS = 4000;
// A send starts before the artifact snapshot arrives and ends only when /prompts acknowledges the
// batch. Bound that whole wait so a missing SDK response or a browser/network stall can never look
// like a dead button while the user's queue remains safely stored in this tab.
const SEND_ACKNOWLEDGEMENT_WARNING_MS = 10_000;
const TERMINAL_PREPARATION_TIMEOUT_MS = 5000;
// A DOM snapshot adds useful context, but the reviewer's own words are the payload.
// If the artifact frame navigated away from the injected SDK (or otherwise stopped
// answering), deliver those words without a snapshot instead of waiting forever.
const SNAPSHOT_REQUEST_TIMEOUT_MS = 5000;
const SEND_STALLED_COPY =
  "Still trying to send. Your feedback is saved in this tab. Keep this tab open while Lavish catches up, and check that the server is running.";
const SEND_FAILED_COPY =
  "Could not send. Your feedback is still queued in this tab. Check that Lavish is running, then click Send to Agent to retry.";
const TERMINAL_SEND_FAILED_COPY =
  "Could not send. Your terminal feedback is still queued in this tab. Check that Lavish is running, then click Send & End to retry the same batch.";
const HEALTH_NO_ANSWER_TITLE = "Lavish did not answer.";
const HEALTH_NO_ANSWER_COPY =
  "Lavish did not answer the check, so this page cannot tell whether it is running. Try again in a moment.";
let artifactLoadToken = "";
let artifactLoadRevision = Number(sessionData.initialArtifactRevision) || 0;
let artifactLoadRequestSequence = Number(sessionData.initialArtifactLoadSequence) || 0;
let chromeLoadToken = String(sessionData.chromeLoadToken || "");
artifactLoadToken = String(sessionData.initialArtifactLoadToken || "");
let artifactSpokeToken = "";
let artifactMessageSequence = 0;
let layoutDiagnosticSequence = 0;
let artifactLoadRecoveryAttempt = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let artifactLoadRecoveryTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let artifactSilenceTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let copyHintTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendHintTimer;
let sendShakeTimer;
let sendHintPersistent = false;
/** @type {{ kind: "preparation" | "submission" | "terminal", operation: object, preparationType?: string } | null} */
let sendFailureOwner = null;
let sendAcknowledgementWarningVisible = false;

function artifactFrameSrcForLoad(load) {
  const separator = artifactSrc.includes("?") ? "&" : "?";
  return (
    artifactSrc +
    separator +
    "artifact_revision=" +
    encodeURIComponent(load.revision) +
    "&artifact_load_token=" +
    encodeURIComponent(load.token)
  );
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function loadJsonState(storageKey, fallback) {
  try {
    const raw = sessionStorage.getItem(storageKey);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJsonState(storageKey, value) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(value));
    return true;
  } catch {
    // The in-memory state still works if browser storage is unavailable.
    return false;
  }
}

// A queued prompt is authored by the untrusted artifact iframe, so its attachment
// refs are validated at the single boundary every prompt crosses before it is
// persisted or rendered. Anything that is not a well-formed `{id}` object is
// dropped: the queue is written to sessionStorage BEFORE it renders, so one bad
// entry would throw out of render(), stay on disk, and throw again on every
// reload - wedging the tab permanently instead of failing once. The card's own
// flow only ever produces `{id, name}`, so a malformed entry is fabricated and
// there is no user image to preserve. The server re-validates independently.
// Each surviving ref is PROJECTED onto a fresh primitives-only object rather than
// kept by reference: postMessage delivers a structured clone, which faithfully
// preserves BigInt values and cycles that `JSON.stringify` then refuses. Passing
// the artifact's own object through would carry that junk into sessionStorage and
// the POST body, where the throw makes the queue unsendable - the same wedge as a
// poisoned entry, just one step later.
function sanitizeAttachmentRefs(value) {
  if (!Array.isArray(value)) return [];
  const refs = [];
  for (const ref of value) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) continue;
    if (typeof ref.id !== "string" || !ref.id) continue;
    const projected = { id: ref.id };
    if (typeof ref.name === "string" && ref.name) projected.name = ref.name;
    refs.push(projected);
  }
  return refs;
}

function isPromptIdentity(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PROMPT_IDENTITY_MAX &&
    PROMPT_IDENTITY_RE.test(value)
  );
}

function promptIdentity(value) {
  return isPromptIdentity(value?.[promptIdentityField]) ? value[promptIdentityField] : "";
}

const chatAckIds = new Set();
function rememberChatAckIds(ids) {
  if (!Array.isArray(ids)) return;
  for (const value of ids) {
    if (isPromptIdentity(value)) chatAckIds.add(value);
  }
}
rememberChatAckIds(initialChatAckIds);

function createPromptIdentity() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

function assignPromptIdentity(prompt, keepExisting) {
  if (keepExisting && promptIdentity(prompt)) return prompt;
  prompt[promptIdentityField] = createPromptIdentity();
  return prompt;
}

function adoptQueuedPrompt(rawPrompt, keepIdentity) {
  const prompt = sanitizeQueuedPrompt(rawPrompt);
  if (!prompt) return null;
  if (!keepIdentity) delete prompt[promptIdentityField];
  assignPromptIdentity(prompt, true);
  return prompt;
}

function sanitizeQueuedPrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return null;
  if (!("attachments" in prompt)) return prompt;
  const clean = { ...prompt };
  const refs = sanitizeAttachmentRefs(clean.attachments);
  if (refs.length) clean.attachments = refs;
  else delete clean.attachments;
  return clean;
}

function loadQueuedPrompts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(queueStorageKey) || "[]");
    // Also sanitize on restore: a tab poisoned before this guard existed still has
    // the bad prompt on disk and would otherwise stay wedged after an upgrade.
    // Keep a stored identity so a reload can settle an already-accepted note; mint
    // one only when the restored prompt predates identity.
    return Array.isArray(parsed) ? parsed.map((item) => adoptQueuedPrompt(item, true)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function persistQueuedPrompts() {
  try {
    if (queued.length) {
      sessionStorage.setItem(queueStorageKey, JSON.stringify(queued));
    } else {
      sessionStorage.removeItem(queueStorageKey);
    }
  } catch {
    // The in-memory queue still works if browser storage is unavailable.
  }
}

function persistTerminalReservation(reserved) {
  try {
    if (reserved) sessionStorage.setItem(terminalStorageKey, "true");
    else sessionStorage.removeItem(terminalStorageKey);
  } catch {
    // Session storage can be unavailable; the in-memory reservation still protects this page.
  }
}

const REMOVE_ICON_SVG =
  '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ANCHOR_EXCERPT_MAX = 120;
const ANCHOR_SELECTOR_MAX = 512;
const ANCHOR_LABEL_MAX = 40;

function boundAnchorText(value, max) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

// What a queued note is attached to, in the annotation card's own words. This is the same rule
// as the server's `chatEntryForPrompt` (src/chat-messages.js), which derives the anchor for the
// note once it is sent: a queued prompt has not reached the server yet and this file cannot
// import modules, so the rule is duplicated here and test/chrome-client-queue.test.js pins the
// two against the same fixtures. A bubble must not change its anchor when it settles.
function promptAnchor(prompt) {
  const tag = String(prompt?.tag || "");
  if (tag === "message") return null;
  const target = prompt?.target && typeof prompt.target === "object" ? prompt.target : null;
  const selector = boundAnchorText(prompt?.selector, ANCHOR_SELECTOR_MAX);
  const withSelector = (anchor) => (selector ? { ...anchor, selector } : anchor);
  if (tag === "whiteboard") {
    const index = Number(target?.diagramIndex);
    const excerpt = Number.isInteger(index) && index >= 0 ? "Diagram " + (index + 1) : prompt.text;
    return { kind: "whiteboard", label: "whiteboard", excerpt: boundAnchorText(excerpt, ANCHOR_EXCERPT_MAX) };
  }
  if (tag === "layout-warnings") {
    const count = Array.isArray(target?.warnings) ? target.warnings.length : 0;
    const excerpt = count > 0 ? count + (count === 1 ? " issue" : " issues") : prompt.text;
    return { kind: "layout", label: "layout", excerpt: boundAnchorText(excerpt, ANCHOR_EXCERPT_MAX) };
  }
  const type = String(target?.type || "");
  if (type === "text-range") {
    return withSelector({
      kind: "text",
      label: "text",
      excerpt: boundAnchorText(target.text || prompt.text, ANCHOR_EXCERPT_MAX),
    });
  }
  if (type === "table-cell") {
    const semantic = [target.rowLabel, target.columnLabel]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" \u2192 ");
    if (semantic)
      return withSelector({ kind: "cell", label: "cell", excerpt: boundAnchorText(semantic, ANCHOR_EXCERPT_MAX) });
  }
  if (type === "mermaid-node") {
    return withSelector({
      kind: "node",
      label: "node",
      excerpt: boundAnchorText(target.label || prompt.text, ANCHOR_EXCERPT_MAX),
    });
  }
  const elementTag = tag.trim();
  if (!elementTag) return null;
  return withSelector({
    kind: "element",
    label: boundAnchorText("<" + elementTag + ">", ANCHOR_LABEL_MAX),
    excerpt: boundAnchorText(prompt.text, ANCHOR_EXCERPT_MAX),
  });
}

// The anchor line: a mono chip naming the kind (`<h2>`, `text`, `cell`, ...) and a quoted
// excerpt, with the full excerpt and selector on hover.
function anchorHtml(anchor, pin = 0) {
  if (!anchor || typeof anchor !== "object") return "";
  const excerpt = String(anchor.excerpt || "");
  const title = [excerpt, anchor.selector].filter(Boolean).join("\n");
  return (
    '<div class="anchor" title="' +
    escapeHtml(title) +
    '">' +
    (pin ? '<span class="anchor-pin" aria-label="Pin ' + pin + '">' + pin + "</span>" : "") +
    '<span class="anchor-kind">' +
    escapeHtml(anchor.label || "") +
    "</span>" +
    (excerpt
      ? '<span class="anchor-excerpt' +
        (anchor.kind === "text" ? " text" : "") +
        '">\u201C' +
        escapeHtml(excerpt) +
        "\u201D</span>"
      : "") +
    "</div>"
  );
}

// What a note with images and no words says for itself. A queued prompt keeps its words in
// `prompt` (`text` is the element's excerpt); a transcript entry keeps them in `text`.
function attachmentOnlyText(entry) {
  if (!attachmentCount(entry)) return "";
  return entry.tag === "message" || entry.kind === "message" ? "Image message" : "Image annotation";
}

function userBubbleTextHtml(entry, text) {
  const displayText = String(text || attachmentOnlyText(entry));
  return displayText ? '<div class="bubble-text">' + escapeHtml(displayText) + "</div>" : "";
}

// A queued note is a row in the Queue list above the message box (the prototype's AI Elements
// Queue): its pin, what it points at, its words, and a remove control. Clicking the row opens the
// note in the message box for editing; while its batch is in flight it reads Sending and can no
// longer be edited or removed. It becomes a sent bubble in the conversation once the server's
// transcript carries it.
function queuedBubbleHtml(prompt, index) {
  const sending = isPromptSending(prompt);
  const editing = !sending && Boolean(editingPromptId) && promptIdentity(prompt) === editingPromptId;
  const words = String(prompt.prompt || "").trim() || attachmentOnlyText(prompt);
  return (
    '<li class="queue-item' +
    (editing ? " is-editing" : "") +
    (sending ? " is-sending" : "") +
    '" data-index="' +
    index +
    '"><div class="queue-main">' +
    anchorHtml(promptAnchor(prompt), queuedPinNumber(prompt)) +
    '<button class="queued-edit queue-text" type="button" aria-label="Edit queued prompt" data-index="' +
    index +
    '">' +
    escapeHtml(words) +
    "</button>" +
    bubbleAttachmentsHtml(prompt) +
    "</div>" +
    '<span class="queue-state">' +
    (sending ? "Sending…" : editing ? "Editing" : "Queued") +
    "</span>" +
    '<button class="queued-remove" type="button" aria-label="Remove queued prompt" data-index="' +
    index +
    '">' +
    REMOVE_ICON_SVG +
    "</button></li>"
  );
}

// Whether a queued prompt is committed to a send that has not been answered yet: waiting for its
// snapshot, queued behind another submission, in flight, or held by the terminal reservation.
// Derived from the existing send bookkeeping rather than tracked separately, so no failure path
// can strand a note labelled Sending with its remove control disabled.
function isPromptSending(prompt) {
  if (terminalSubmission?.inFlight && terminalSubmission.prompts.includes(prompt)) return true;
  for (const request of snapshotRequests.values()) {
    if (request.action === "submit" && Array.isArray(request.prompts) && request.prompts.includes(prompt)) return true;
  }
  for (const submission of pendingSubmissions) {
    if (Array.isArray(submission.prompts) && submission.prompts.includes(prompt)) return true;
  }
  return Boolean(
    activeSubmission && Array.isArray(activeSubmission.prompts) && activeSubmission.prompts.includes(prompt),
  );
}

function render() {
  const editing = editingPromptId ? queued.find((prompt) => promptIdentity(prompt) === editingPromptId) : null;
  // A note that left the queue or started sending takes its editor with it.
  if (editingPromptId && (!editing || !isPromptEditable(editing))) endQueuedEdit();
  queuedLog.innerHTML = queued.map((prompt, index) => queuedBubbleHtml(prompt, index)).join("");

  for (const button of queuedLog.querySelectorAll(".queued-remove")) {
    const removeButton = /** @type {HTMLButtonElement} */ (button);
    const prompt = queued[Number(removeButton.dataset.index)];
    removeButton.disabled = terminalSubmission !== null || isPromptSending(prompt);
    removeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(removeButton.dataset.index), event));
  }
  for (const button of queuedLog.querySelectorAll(".queued-edit")) {
    const editButton = /** @type {HTMLButtonElement} */ (button);
    editButton.disabled = !isPromptEditable(queued[Number(editButton.dataset.index)]);
  }
  queuePanel.hidden = queued.length === 0;
  setCount(queueCount, queued.length);
  const editIndex = editingPromptId ? queued.findIndex((prompt) => promptIdentity(prompt) === editingPromptId) : -1;
  editBar.hidden = editIndex === -1;
  if (editIndex !== -1) editBarText.textContent = "Editing queued note " + (editIndex + 1);
  renderMarks();
  chatInput.placeholder =
    editIndex !== -1
      ? "Edit the queued note"
      : marks.length
        ? "Say what to change. Call the marks " +
          marks
            .slice(0, 2)
            .map((_, index) => "[" + markNumber(index) + "]")
            .join(", ") +
          (marks.length > 2 ? "..." : "")
        : COMPOSER_PLACEHOLDER;
  if (editFocusPending) {
    editFocusPending = false;
    chatInput.focus();
    chatInput.setSelectionRange?.(chatInput.value.length, chatInput.value.length);
  }
  renderSendLabel();
  postQueuedAnchors();
  renderQueuedBadge();
  updateSendState();
  scrollPanelToBottom();
  renderSheetSummary();
}

// How many notes wait to be sent, on the dock's chevron (Peek and the phone): the notification
// badge recipe, so it pops in with the first and out with the last.
const panelQueued = /** @type {HTMLSpanElement} */ (document.getElementById("panelQueued"));
const panelQueuedCount = /** @type {HTMLSpanElement} */ (document.getElementById("panelQueuedCount"));
function renderQueuedBadge() {
  if (queued.length) panelQueuedCount.textContent = String(queued.length);
  panelQueued.dataset.open = String(queued.length > 0);
}

function updateSendState() {
  const terminalReserved = terminalSubmission !== null;
  // A terminal send owns the exact review batch, so freeze interactions inside the
  // artifact without disabling annotation mode. Disabling annotation mode closes the
  // SDK card and destroys an unsent draft before delivery has actually succeeded.
  frame.inert = ended || terminalReserved;
  sendButton.disabled = ended || terminalReserved;
  sendAndEndButton.disabled = ended || Boolean(terminalSubmission?.inFlight);
  annotationSwitch.disabled = ended || terminalReserved;
  modeInteractButton.disabled = annotationSwitch.disabled;
  railAnnotateButton.disabled = annotationSwitch.disabled;
  chatInput.disabled = ended || terminalReserved;
  chatAttachButton.disabled = ended || terminalReserved;
  endButton.disabled = ended || terminalReserved;
  if (warningsQueueButton) updateWarningSelectionState();
}

function attachmentCount(prompt) {
  return Array.isArray(prompt.attachments) ? prompt.attachments.length : 0;
}

// How many thumbnails a bubble shows before the rest collapse into a badge.
const BUBBLE_THUMBNAIL_LIMIT = 4;

// Thumbnails for a note's images, served straight from the same-origin attachment endpoint (the
// ids are already server-vetted at upload time). The bubble has room for only a few, but the
// per-prompt cap is configurable (LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT), so a note can
// legitimately carry more than fit: the remainder collapses into a +N badge rather than being
// dropped from the preview, which would make the queue look like it lost the extra images (W-A).
function bubbleAttachmentsHtml(entry) {
  const count = attachmentCount(entry);
  if (!count) return "";
  const hidden = count - BUBBLE_THUMBNAIL_LIMIT;
  return (
    '<span class="bubble-attachments">' +
    entry.attachments
      .slice(0, BUBBLE_THUMBNAIL_LIMIT)
      .map((attachment) => {
        const alt = escapeHtml(attachment.name || "image");
        return (
          '<img class="bubble-attachment" src="/api/' +
          encodeURIComponent(key) +
          "/attachments/" +
          encodeURIComponent(attachment.id) +
          '" alt="' +
          alt +
          '" title="' +
          alt +
          '">'
        );
      })
      .join("") +
    (hidden > 0
      ? '<span class="bubble-attachment-more" title="' +
        hidden +
        " more image" +
        (hidden === 1 ? "" : "s") +
        '">+' +
        hidden +
        "</span>"
      : "") +
    "</span>"
  );
}

function replaceExpiredThumbnail(event) {
  const image = event.target;
  if (
    String(image?.tagName || "").toUpperCase() !== "IMG" ||
    !String(image.className || "")
      .split(/\s+/)
      .includes("bubble-attachment")
  )
    return;
  const expired = document.createElement("span");
  expired.className = "bubble-attachment bubble-attachment-expired";
  expired.textContent = "Image expired";
  expired.title = String(image.alt || "image");
  image.replaceWith(expired);
}

chatLog.addEventListener("error", replaceExpiredThumbnail, true);

// Jump to revision: the server stamps an agent reply with the newest revision the artifact
// declared when the agent replied. The button stays hidden until the legend of the artifact on
// screen has that round with blocks to show, and steps through them like the legend's Reveal.
function replyRevisionHtml(revisionId) {
  const id = typeof revisionId === "string" ? revisionId : "";
  if (!id || id.length > REVISION_LIMITS.id || /\s/.test(id)) return "";
  return (
    '<button class="reply-revision" type="button" data-revision="' +
    escapeHtml(id) +
    '" aria-label="Show the blocks changed in ' +
    escapeHtml(id) +
    '" hidden>View ' +
    escapeHtml(id) +
    "</button>"
  );
}

function syncReplyRevisionButtons() {
  for (const node of chatLog.querySelectorAll(".reply-revision")) {
    const button = /** @type {HTMLButtonElement} */ (node);
    const entry = revisionEntries.find((candidate) => candidate.id === button.dataset.revision);
    button.hidden = !entry || entry.marks.length === 0;
  }
}

/** @type {WeakMap<Element, string>} */
const replyTexts = new WeakMap();
// When each entry last animated in. The transcript sync that follows a live reply rebuilds the log
// within milliseconds; an entry that entered moments ago keeps its motion through that rebuild.
/** @type {Map<string, number>} */
const enteredAt = new Map();

chatLog.addEventListener("click", (event) => {
  const target = /** @type {Element | null} */ (event.target);
  if (!target || typeof target.closest !== "function") return;
  const button = target.closest(".reply-revision");
  if (button) revealNextRevisionMark(String(/** @type {HTMLElement} */ (button).dataset.revision || ""));
  const copy = target.closest(".msg-copy");
  if (copy) void copyReply(copy);
});

async function copyReply(button) {
  const bubble = button.closest(".bubble");
  const text = bubble ? replyTexts.get(bubble) : "";
  if (!text || !(await copyText(text))) return;
  const swap = button.querySelector(".t-icon-swap");
  if (!swap) return;
  swap.dataset.state = "b";
  button.setAttribute("aria-label", "Copied");
  setTimeout(() => {
    swap.dataset.state = "a";
    button.setAttribute("aria-label", "Copy reply");
  }, 1500);
}

const DEFAULT_SEND_HINT = "Write a message or annotate an element first.";

function showSendHint(message = DEFAULT_SEND_HINT, holdMs = 2600, focusInput = true) {
  sendHint.textContent = message;
  sendHint.hidden = false;
  clearTimeout(sendHintTimer);
  sendHintPersistent = holdMs === null;
  sendHint.classList.toggle("persistent", sendHintPersistent);
  if (sendHintPersistent) {
    sendHintTimer = undefined;
    if (focusInput) chatInput.focus();
    return;
  }
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
    sendHint.textContent = DEFAULT_SEND_HINT;
    sendHintPersistent = false;
    promptInput.classList.remove("is-error");
  }, holdMs);
  if (focusInput) chatInput.focus();
}

// Error state shake: an empty send shakes the prompt box and reddens its border for as long as the
// hint explains why.
function rejectEmptySend() {
  showSendHint();
  promptInput.classList.add("is-error");
  promptInput.classList.remove("is-shaking");
  void promptInput.offsetWidth;
  promptInput.classList.add("is-shaking");
  clearTimeout(sendShakeTimer);
  const shakeMs = motionMs("--shake-dur-a", 80) * 2 + motionMs("--shake-dur-b", 60) * 2;
  sendShakeTimer = setTimeout(() => promptInput.classList.remove("is-shaking"), shakeMs + 20);
}

function hideSendHint(force = false) {
  if (sendHintPersistent && force !== true) return;
  clearTimeout(sendHintTimer);
  sendHint.hidden = true;
  sendHint.textContent = DEFAULT_SEND_HINT;
  sendHint.classList.remove("persistent");
  promptInput.classList.remove("is-error");
  sendHintPersistent = false;
  sendAcknowledgementWarningVisible = false;
}

function armSendAcknowledgementWarning() {
  if (sendAcknowledgementTimer || pendingAcknowledgements.size === 0) return;
  sendAcknowledgementTimer = setTimeout(() => {
    sendAcknowledgementTimer = undefined;
    if (pendingAcknowledgements.size > 0 && !sendFailureOwner) {
      sendAcknowledgementWarningVisible = true;
      showSendHint(SEND_STALLED_COPY, null, false);
    }
  }, SEND_ACKNOWLEDGEMENT_WARNING_MS);
}

function clearSendAcknowledgementWarning() {
  clearTimeout(sendAcknowledgementTimer);
  sendAcknowledgementTimer = undefined;
  sendAcknowledgementWarningVisible = false;
}

function showQueuedSendFailure(message = SEND_FAILED_COPY, owner = null) {
  showPersistentSendFailure(message, true, owner);
}

function showPersistentSendFailure(message, requireQueuedFeedback = false, owner = null) {
  clearSendAcknowledgementWarning();
  if (requireQueuedFeedback && !queued.length) return;
  if (sendFailureOwner?.kind === "preparation") return;
  const currentOrder = Number(sendFailureOwner?.operation?.order) || 0;
  const nextOrder = Number(owner?.operation?.order) || 0;
  if (owner?.kind !== "preparation" && currentOrder > nextOrder) return;
  sendFailureOwner = owner;
  showSendHint(message, null, false);
}

function clearPersistentSendFailure() {
  sendFailureOwner = null;
  hideSendHint(true);
}

function clearPreparationFailure(preparationType) {
  if (sendFailureOwner?.kind !== "preparation" || sendFailureOwner.preparationType !== preparationType) return;
  clearPersistentSendFailure();
}

// ---- Motion: drives the transitions.dev recipes in the "Motion" section of chrome.css. State
// still lives on `hidden`, aria-*, and textContent, and each changes at once as it always did; these
// helpers only add the classes that animate between states, and under prefers-reduced-motion they
// jump straight to the end state. ----

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// A recipe duration token such as --dropdown-close-dur, in milliseconds.
function motionMs(token, fallback) {
  const root = document.documentElement;
  if (typeof window.getComputedStyle !== "function" || !root) return fallback;
  const value = parseFloat(window.getComputedStyle(root).getPropertyValue(token));
  return Number.isFinite(value) ? value : fallback;
}

/** @type {WeakMap<Element, ReturnType<typeof setTimeout>>} */
const layerCloseTimers = new WeakMap();

// Opens or closes a menu or dialog. `hidden` flips immediately, so every check of it and the
// accessibility tree see the new state at once; on close, `is-closing` keeps the layer painted
// (the `.is-closing[hidden]` rules) until its exit transition ends. A dialog passes its card as
// `surface` so the card scales while the layer behind it fades.
function setLayerOpen(layer, open, { surface = null, closeToken = "--dropdown-close-dur" } = {}) {
  const parts = surface ? [layer, surface] : [layer];
  // Closing a closed layer is a no-op, so a second close cannot cut short an exit already running.
  if (!open && layer.hidden) return;
  clearTimeout(layerCloseTimers.get(layer));
  layerCloseTimers.delete(layer);
  if (open) {
    const wasHidden = layer.hidden;
    layer.hidden = false;
    for (const part of parts) part.classList.remove("is-closing");
    // Lay out the closed pose first so the open transition has somewhere to start from.
    if (wasHidden) void layer.offsetWidth;
    for (const part of parts) part.classList.add("is-open");
    return;
  }
  layer.hidden = true;
  for (const part of parts) part.classList.remove("is-open");
  if (prefersReducedMotion()) {
    for (const part of parts) part.classList.remove("is-closing");
    return;
  }
  for (const part of parts) part.classList.add("is-closing");
  layerCloseTimers.set(
    layer,
    setTimeout(
      () => {
        layerCloseTimers.delete(layer);
        for (const part of parts) part.classList.remove("is-closing");
      },
      motionMs(closeToken, 150),
    ),
  );
}

/** @type {WeakMap<Element, { timer: ReturnType<typeof setTimeout>, text: string }>} */
const pendingTextSwaps = new WeakMap();

// Text states swap: the old text leaves upward, the new one rises in. A label shown for the first
// time just appears.
function swapText(node, text) {
  const pending = pendingTextSwaps.get(node);
  if (pending) {
    if (pending.text === text) return;
    clearTimeout(pending.timer);
    pendingTextSwaps.delete(node);
  }
  if (node.textContent === text) {
    node.classList.remove("is-exit");
    return;
  }
  if (!node.textContent || prefersReducedMotion()) {
    node.classList.remove("is-exit", "is-enter-start");
    node.textContent = text;
    return;
  }
  node.classList.remove("is-enter-start");
  node.classList.add("is-exit");
  const timer = setTimeout(
    () => {
      pendingTextSwaps.delete(node);
      node.textContent = text;
      node.classList.remove("is-exit");
      node.classList.add("is-enter-start");
      void node.offsetWidth;
      node.classList.remove("is-enter-start");
    },
    motionMs("--text-swap-dur", 200),
  );
  pendingTextSwaps.set(node, { timer, text });
}

// Number pop-in: each digit rises into place, the last two a beat apart.
function setCount(node, count) {
  const text = String(count);
  if (node.textContent === text) return;
  if (prefersReducedMotion()) {
    node.textContent = text;
    return;
  }
  node.classList.remove("is-animating");
  const digits = [...text].map((character, index) => {
    const digit = document.createElement("span");
    digit.className = "t-digit";
    digit.textContent = character;
    if (text.length > 1 && index === text.length - 2) digit.dataset.stagger = "1";
    if (text.length > 1 && index === text.length - 1) digit.dataset.stagger = "2";
    return digit;
  });
  node.replaceChildren(...digits);
  void node.offsetWidth;
  node.classList.add("is-animating");
}

function setMenuOpen(button, menu, open) {
  setLayerOpen(menu, open);
  button.setAttribute("aria-expanded", String(open));
}

function closeMenus() {
  setMenuOpen(moreButton, moreMenu, false);
}

function toggleMenu(button, menu) {
  const open = menu.hidden;
  closeMenus();
  setMenuOpen(button, menu, open);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea-based fallback below.
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
  return true;
}

// One transcript entry, as the server serialized it (src/chat-messages.js). An agent entry's
// `html` is the server's rendering of the agent's text and is the only html ever set here; a
// user entry is always escaped text, with its anchor line and thumbnails when it carries them.
function chatBubbleHtml(entry) {
  if (entry.role === "agent") {
    return agentHeaderHtml(entry.at) + agentBodyHtml(entry) + agentActionsHtml(entry);
  }
  return (
    "<small>You</small>" +
    anchorHtml(entry.anchor) +
    userBubbleTextHtml(entry, entry.text) +
    bubbleAttachmentsHtml(entry) +
    receiptHtml(entry)
  );
}

// The prototype's message header (AI Elements Message): who is speaking and when, so a long review
// reads as a conversation with timestamps rather than a stack of paragraphs.
const SPARKLES_SVG =
  '<svg class="msg-who-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>';
const COPY_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

function messageTime(at) {
  const ms = Date.parse(String(at || ""));
  if (!Number.isFinite(ms)) return "";
  const label = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(ms);
  return '<time datetime="' + escapeHtml(String(at)) + '">' + escapeHtml(label) + "</time>";
}

function agentHeaderHtml(at) {
  return '<div class="msg-who">' + SPARKLES_SVG + "<span>Agent</span>" + messageTime(at) + "</div>";
}

// AI Elements Actions: shown on hover or focus, always on touch. Copy takes the agent's own text,
// so a pasted reply keeps its Markdown; View rN is the jump-to-revision button.
function agentActionsHtml(entry) {
  return (
    '<div class="msg-actions"><button class="msg-action msg-copy" type="button" aria-label="Copy reply" title="Copy"><span class="t-icon-swap" data-state="a"><span class="t-icon" data-icon="a">' +
    COPY_SVG +
    '</span><span class="t-icon" data-icon="b">' +
    CHECK_SVG +
    "</span></span></button>" +
    replyRevisionHtml(entry.revision_id) +
    "</div>"
  );
}

function agentBodyHtml(entry) {
  const parts = replyPartsHtml(entry.parts);
  // A reply that is only sections has no prose of its own; the raw text would repeat them.
  const body =
    typeof entry.html === "string" && entry.html
      ? '<div class="chat-md">' + entry.html + "</div>"
      : parts
        ? ""
        : '<div class="bubble-text">' + escapeHtml(entry.text) + "</div>";
  return body + parts;
}

// Structured reply parts (src/chat-messages.js `splitReplyParts`): each section the agent wrote
// under a reply becomes a closed disclosure. Titles come from this fixed map, never from the
// payload, and a kind outside it is dropped; the html is the server's render, like the reply's.
const REPLY_PART_TITLES = new Map([
  ["changes", "What I changed"],
  ["files", "Files touched"],
  ["reasoning", "Reasoning"],
]);

function replyPartsHtml(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part && REPLY_PART_TITLES.has(part.kind) && typeof part.html === "string" && part.html)
    .map(
      (part) =>
        '<details class="reply-part reply-part-' +
        part.kind +
        '"><summary>' +
        REPLY_PART_TITLES.get(part.kind) +
        '</summary><div class="chat-md">' +
        part.html +
        "</div></details>",
    )
    .join("");
}

// Delivery receipt (docs/delivery-acks.md): the per-note view of what the server observed. Seen,
// Working, and Done are stamps on the entry, so the row is derived from it on every render and
// never tracked here. Before Seen, the row says why, from the presence the live stream reports.
// The three steps mirror the Telegram ack protocol (seen, working, done), drawn as Lucide icons
// (eye, wrench, check) like the rest of the chrome (#3246). A step that has not happened is the same
// icon dimmed, and every step carries its label and time as `title` and `aria-label`, so hover and
// screen readers both say the word.
const RECEIPT_ICON_PATHS = {
  Seen: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  Working:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  Done: '<path d="M20 6 9 17l-5-5"/>',
};
function receiptIcon(label) {
  return (
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    RECEIPT_ICON_PATHS[label] +
    "</svg>"
  );
}

function receiptTime(at) {
  const date = new Date(String(at));
  return Number.isNaN(date.getTime())
    ? String(at)
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function receiptStepHtml(label, at) {
  const ticked = Boolean(at);
  const text = ticked ? label + " " + receiptTime(at) : label + ": not yet";
  return (
    '<span class="receipt-step' +
    (ticked ? " is-done" : "") +
    '" role="img" aria-label="' +
    escapeHtml(text) +
    '" title="' +
    escapeHtml(text) +
    '">' +
    receiptIcon(label) +
    "</span>"
  );
}

// Every branch must be true where it is shown: `waiting` is no poll at all, `listening` is a poll
// that will take the note within milliseconds, and `working` or an external listener is an agent
// whose next poll will take it.
function receiptNoteText() {
  if (agentPresence === "waiting") return "No agent is listening";
  if (agentPresence === "listening") return "Delivering";
  return "Agent is busy; delivered on its next poll";
}

// A transcript entry from before receipts existed (`receipt: "none"`, marked by the server once at
// load) gets no row: nothing was ever observed about it, and an empty row would read as "never seen".
function hasReceipt(entry) {
  return Boolean(entry) && entry.receipt !== "none";
}

function receiptHtml(entry) {
  if (!hasReceipt(entry)) return "";
  return (
    '<div class="receipt">' +
    receiptStepHtml("Seen", entry.delivered_at) +
    receiptStepHtml("Working", entry.working_at) +
    receiptStepHtml("Done", entry.done_at) +
    (entry.delivered_at ? "" : '<span class="receipt-note">' + escapeHtml(receiptNoteText()) + "</span>") +
    "</div>"
  );
}

// Only the pre-Seen line names the live presence, so a presence change rewrites that line alone.
// Rebuilding the bubble would also rebuild its thumbnails and undo an "Image expired" placeholder.
function refreshUnseenReceipts() {
  for (const note of chatLog.querySelectorAll(".receipt-note")) note.textContent = receiptNoteText();
}

function addChat(entry, shouldScroll = true, { enter = false } = {}) {
  if (!entry || typeof entry !== "object") return;
  const role = entry.role === "agent" ? "agent" : "user";
  const text = String(entry.text || "");
  if (!text && !(role === "agent" ? entry.html : attachmentCount(entry) || entry.anchor)) return;

  const el = document.createElement("div");
  el.className = "bubble " + role;
  el.innerHTML = chatBubbleHtml({ ...entry, role, text });
  if (role === "agent") replyTexts.set(el, text);
  // A new reply reveals and a new message of yours slides up (transitions-polish tokens). Only
  // entries that just arrived move; a transcript rebuild never replays them.
  if (enter && !prefersReducedMotion()) {
    el.classList.add(role === "agent" ? "msg-reveal" : "msg-send");
    enteredAt.set(chatEntryDisplayKey(entry), Date.now());
  }
  chatLog.appendChild(el);
  if (role === "agent" && entry.revision_id) syncReplyRevisionButtons();
  if (shouldScroll) scrollElementIntoView(el);
  return el;
}

function chatEntryDisplayKey(entry) {
  return JSON.stringify({
    role: entry?.role === "agent" ? "agent" : "user",
    kind: entry?.kind,
    text: String(entry?.text || ""),
    anchor: entry?.anchor,
    attachments: Array.isArray(entry?.attachments) ? entry.attachments.map((item) => String(item?.id || "")) : [],
  });
}

function chatEntriesMatch(left, right) {
  if (chatEntryDisplayKey(left) !== chatEntryDisplayKey(right)) return false;
  const leftAt = String(left?.at || "");
  const rightAt = String(right?.at || "");
  return !leftAt || !rightAt || leftAt === rightAt;
}

function parseChatRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function chatContainsEntries(candidate, entries) {
  if (!Array.isArray(candidate) || !Array.isArray(entries)) return false;
  if (entries.length === 0) return true;
  // A size-bound transcript may drop a prefix of what this tab already showed. The remaining
  // displayed suffix must still appear in order; a stale sync that is missing a newer tail
  // (including an empty wipe) is rejected.
  for (let start = 0; start < entries.length; start += 1) {
    const suffix = entries.slice(start);
    let matched = 0;
    for (const entry of candidate) {
      if (matched < suffix.length && chatEntriesMatch(entry, suffix[matched])) matched += 1;
    }
    if (matched === suffix.length) return true;
  }
  return false;
}

function chatStartsWith(candidate, prefix) {
  return (
    Array.isArray(candidate) &&
    Array.isArray(prefix) &&
    candidate.length >= prefix.length &&
    prefix.every((entry, index) => chatEntriesMatch(candidate[index], entry))
  );
}

function mergeAcceptedChat(accepted, chatAtRequest) {
  if (!Array.isArray(accepted) || !Array.isArray(chatAtRequest)) return null;
  if (!chatStartsWith(displayedChat, chatAtRequest)) return null;
  let requestOffset = chatAtRequest.length;
  for (let i = 0; i <= chatAtRequest.length; i += 1) {
    if (chatStartsWith(accepted, chatAtRequest.slice(i))) {
      requestOffset = i;
      break;
    }
  }
  const displayedTail = displayedChat.slice(chatAtRequest.length);
  const unmatchedDisplayed = [];
  let acceptedIndex = chatAtRequest.length - requestOffset;
  for (const displayedEntry of displayedTail) {
    while (acceptedIndex < accepted.length && !chatEntriesMatch(accepted[acceptedIndex], displayedEntry)) {
      acceptedIndex += 1;
    }
    if (acceptedIndex < accepted.length) {
      acceptedIndex += 1;
    } else {
      unmatchedDisplayed.push(displayedEntry);
    }
  }
  return accepted.concat(unmatchedDisplayed);
}

function queuedPromptMatchesEntry(prompt, entry) {
  const id = promptIdentity(prompt);
  return Boolean(id) && entry?.role === "user" && promptIdentity(entry) === id;
}

function promptAcknowledgedInChat(prompt, chat) {
  const id = promptIdentity(prompt);
  if (!id) return false;
  if (chatAckIds.has(id)) return true;
  if (!Array.isArray(chat)) return false;
  return chat.some((entry) => queuedPromptMatchesEntry(prompt, entry));
}

function settleQueuedFromTranscript(chat, shouldRender = true) {
  if (!Array.isArray(chat) || !queued.length) return false;
  // Match by the per-submission identity only. Displayed content is not identity: two tabs
  // can send the same selected text under one container with different range boundaries,
  // and each note must settle exactly once against its own acknowledgement.
  const settledPrompts = new Set();
  for (const prompt of queued) {
    if (!promptAcknowledgedInChat(prompt, chat)) continue;
    settledPrompts.add(prompt);
    deliveredPrompts.add(prompt);
  }
  if (!settledPrompts.size) return false;
  for (let i = queued.length - 1; i >= 0; i -= 1) {
    if (settledPrompts.has(queued[i])) queued.splice(i, 1);
  }
  persistQueuedPrompts();
  if (shouldRender) render();
  return true;
}

function syncChat(chat, revision) {
  const nextChat = Array.isArray(chat) ? chat : [];
  settleQueuedFromTranscript(nextChat);
  const nextRevision = parseChatRevision(revision);
  if (nextRevision !== null && nextRevision < chatRevision) return false;
  if (nextRevision === null || nextRevision === chatRevision) {
    if (!chatContainsEntries(nextChat, displayedChat)) return false;
  }
  if (nextRevision !== null) chatRevision = nextRevision;
  const shownBefore = new Set(displayedChat.map(chatEntryDisplayKey));
  displayedChat = nextChat.slice();
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working)")]) {
    el.remove();
  }

  let lastChatBubble = null;
  for (const item of nextChat) {
    const key = chatEntryDisplayKey(item);
    const enter = !shownBefore.has(key) || Date.now() - (enteredAt.get(key) || 0) < 400;
    lastChatBubble = addChat(item, false, { enter }) || lastChatBubble;
  }
  if (workingBubble) chatLog.appendChild(workingBubble);
  // Handed-back drafts were written at the end of the conversation, and a rebuild re-appends the
  // whole transcript - so without this they end up above it, where the scroll below would leave
  // them off-screen. They are the one thing here the user cannot recover anywhere else.
  for (const note of retiredDraftNodes) chatLog.appendChild(note);
  const anchor = retiredDraftNodes[retiredDraftNodes.length - 1] || workingBubble || lastChatBubble;
  if (anchor) scrollElementIntoView(anchor);
  return true;
}

// The top bar's one-word answer to "will my send reach anyone right now?". The dock summary and the
// presence banner say more; this stays visible whatever the panel is doing.
const AGENT_STATUS_TEXT = {
  listening: "Agent listening",
  working: "Agent working",
  external: "External listener",
  waiting: "Agent not listening",
};

function renderAgentStatus() {
  agentStatus.dataset.state = ended ? "ended" : agentPresence;
  swapText(agentStatusText, ended ? "Session ended" : AGENT_STATUS_TEXT[agentPresence] || AGENT_STATUS_TEXT.waiting);
}

function setAgentPresence(state) {
  agentPresence = state === "listening" || state === "external" || state === "working" ? state : "waiting";
  renderAgentStatus();
  updateSendState();
  renderSheetSummary();
  refreshUnseenReceipts();
  if (presenceBanner) presenceBanner.hidden = ended || agentPresence !== "waiting";

  // A supervisor-owned process-only listener is busy on the agent's behalf. It must not make the
  // composer look like an idle captain turn while the owning agent is offline.
  if (agentPresence !== "working" && agentPresence !== "external") {
    if (workingBubble) workingBubble.remove();
    workingBubble = null;
    return;
  }

  if (!workingBubble) {
    workingBubble = document.createElement("div");
    workingBubble.className = "bubble agent agent-working";
    workingBubble.innerHTML = SPINNER_SVG + "<span>Working...</span>";
    chatLog.appendChild(workingBubble);
  }
  scrollElementIntoView(workingBubble);
}

function setHandoffSuperseded(visible) {
  if (handoffBanner) handoffBanner.hidden = ended || !visible;
}

// The server this page was connected to went away. What is true beyond that depends on why, so
// the shutdown names its reason and each one gets its own line - a page told "Lavish was updated"
// after a deliberate stop is being told something false. An unnamed reason (SIGTERM, or any
// caller that names none) claims neither.
function chromeOutdatedCopy(reason) {
  if (reason === "upgrade") return "Lavish was updated. This page is running the previous version.";
  if (reason === "local-build") {
    return "Lavish was restarted to pick up a local build. This page is running the copy the previous server sent.";
  }
  if (reason === "stop") return "Lavish was stopped. Reload after you start it again.";
  return "The Lavish server this page was connected to is no longer running. Reloading will work once it is running again.";
}

// Say so where the user can dismiss it, and never reload on their behalf - a forced reload
// interrupts whatever they were reading or writing.
function setChromeOutdated(visible, reason = chromeOutdatedReason) {
  chromeOutdatedReason = String(reason || "");
  chromeOutdatedGeneration += 1;
  if (outdatedText) outdatedText.textContent = chromeOutdatedCopy(chromeOutdatedReason);
  outdatedReloadInFlight = false;
  if (outdatedReloadButton) outdatedReloadButton.disabled = false;
  if (outdatedBanner) outdatedBanner.hidden = ended || !visible;
}

function setReviewState(state) {
  lastReviewState = state;
  // The artifact reported a card, so its anchor exists: whatever miss was recorded is answered.
  if (state?.card) unrestorableDraftMiss = null;
  if (!state || (!state.card && !(Array.isArray(state.fields) && state.fields.length))) {
    try {
      sessionStorage.removeItem(reviewStateStorageKey);
    } catch {
      // The in-memory state still works if browser storage is unavailable.
    }
    return;
  }
  saveJsonState(reviewStateStorageKey, state);
}

function hasUnsentDraft() {
  if (editingPromptId) return true;
  return Boolean(lastReviewState && lastReviewState.card && String(lastReviewState.card.text || "").trim());
}

// The SDK looked for this draft's anchor in a loaded artifact and did not find it. Retiring a
// draft is itself data loss - the user may still be typing while the agent rewrites the element
// they anchored to - so one miss only records the answer. The draft is retired only when a
// SECOND artifact revision reports the same anchor missing: an element that is merely being
// rewritten comes back, and a report on the revision already recorded is the same answer twice,
// not two answers. Any report for a different draft, or for a draft that is no longer stored,
// leaves the stored text alone.
function discardUnrestorableDraft(selector) {
  if (!selector || !lastReviewState || !lastReviewState.card) return;
  if (String(lastReviewState.card.selector || "") !== selector) return;
  const revision = artifactLoadRevision;
  if (unrestorableDraftMiss?.selector !== selector) {
    unrestorableDraftMiss = { selector, revision };
    return;
  }
  if (unrestorableDraftMiss.revision === revision) return;
  unrestorableDraftMiss = null;
  keepRetiredDraft(String(lastReviewState.card.text || ""));
  setReviewState({ ...lastReviewState, card: null });
}

// Retiring a draft ends Lavish's ability to replay it, so the text itself is handed back to the
// user before it goes: it is written to the conversation panel verbatim, where it is selectable,
// nothing overwrites what they may already be typing, and no control can discard it by accident.
// It is persisted per session so a reload does not take the last copy with it.
function loadRetiredDrafts() {
  const stored = loadJsonState(retiredDraftStorageKey, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry) => typeof entry === "string" && entry.trim());
}

// No entry already handed back is ever dropped to make room for a new one. When browser storage
// refuses the write, the note says so on the spot instead of an older one quietly disappearing at
// the next page load - the text the user wrote is the thing being protected here.
function keepRetiredDraft(text) {
  if (!text.trim()) return;
  retiredDrafts = [...retiredDrafts, text];
  renderRetiredDraft(text, saveJsonState(retiredDraftStorageKey, retiredDrafts));
}

function renderRetiredDraft(text, stored = true) {
  if (!chatLog) return;
  const el = document.createElement("div");
  el.className = "bubble note";
  el.innerHTML =
    "<small>Unsent annotation</small><div>The artifact removed or replaced what this note was attached to, so Lavish could not keep it open. Your text is kept here:</div>" +
    '<div class="note-draft">' +
    escapeHtml(text) +
    "</div>" +
    (stored
      ? ""
      : '<div class="note-warning">This browser refused to store it, so copy it before you reload this page.</div>');
  retiredDraftNodes.push(el);
  chatLog.appendChild(el);
  scrollElementIntoView(el);
}

async function refreshChromeLoadHandoff(requestSequence) {
  const response = await fetch("/api/" + key + "/chrome-loads/begin", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const data = await response.json().catch(() => ({}));
  const token = String(data?.chrome_load_token || "");
  if (!response.ok || !token) throw new Error("failed to refresh chrome handoff");
  if (requestSequence !== artifactLoadRequestSequence || ended) return false;
  chromeLoadToken = token;
  const revision = Number(data?.artifact_revision);
  const loadToken = String(data?.artifact_load_token || "");
  if (Number.isSafeInteger(revision) && revision >= 0) artifactLoadRevision = revision;
  if (loadToken) artifactLoadToken = loadToken;
  return true;
}

function scrollPanelToBottom() {
  panelScroll.scrollTop = panelScroll.scrollHeight;
}

// AI Elements Conversation: once the reader scrolls up, a button at the bottom of the conversation
// brings them back to the newest message. It uses the dropdown recipe so it eases in and out.
const scrollLatestButton = /** @type {HTMLButtonElement} */ (document.getElementById("scrollLatest"));
function syncScrollLatest() {
  const distance = Number(panelScroll.scrollHeight) - Number(panelScroll.scrollTop) - Number(panelScroll.clientHeight);
  setLayerOpen(scrollLatestButton, distance > 80);
}
panelScroll.addEventListener("scroll", syncScrollLatest, { passive: true });
scrollLatestButton.addEventListener("click", () => {
  if (typeof panelScroll.scrollTo === "function") {
    panelScroll.scrollTo({ top: panelScroll.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  } else scrollPanelToBottom();
});

// ---- Suggested replies ----
// The artifact declares them (window.lavish.suggest in the SDK) because only it knows what a sensible
// one-click answer is: a plan offers "Approve", a comparison offers each option. They are untrusted
// artifact input, so they are bounded, deduplicated, and always rendered as text. A click fills the
// composer and never sends; the row steps aside while the reviewer has a draft.
const SUGGESTION_LIMITS = { count: 6, length: 80 };
/** @type {string[]} */
let suggestions = [];

function setSuggestions(items) {
  /** @type {string[]} */
  const next = [];
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item !== "string") continue;
      const text = item.trim().replace(/\s+/g, " ");
      if (!text || text.length > SUGGESTION_LIMITS.length || next.includes(text)) continue;
      next.push(text);
      if (next.length >= SUGGESTION_LIMITS.count) break;
    }
  }
  suggestions = next;
  renderSuggestions();
}

function renderSuggestions() {
  const show = suggestions.length > 0 && !ended && !chatInput.value.trim();
  chatSuggestions.hidden = !show;
  chatSuggestions.innerHTML = show
    ? suggestions
        .map(
          (text, index) =>
            '<button class="chat-suggestion" type="button" data-suggestion-index="' +
            index +
            '">' +
            escapeHtml(text) +
            "</button>",
        )
        .join("")
    : "";
}

chatSuggestions.addEventListener("click", (event) => {
  const target = /** @type {any} */ (event && event.target);
  const button = target && typeof target.closest === "function" ? target.closest("[data-suggestion-index]") : null;
  const text = button ? suggestions[Number(button.dataset.suggestionIndex)] : undefined;
  if (typeof text !== "string" || ended) return;
  chatInput.value = text;
  chatInput.focus();
  hideSendHint();
  renderSuggestions();
});

// ---- Theme ----
// Light or dark follows the OS until the reviewer picks one with the toggle. The choice is a
// personal preference, not session state, so it lives in localStorage across every session. The
// head bootstrap in server.js applies a stored choice before first paint; this controller owns the
// toggle, the "Follow system theme" item, OS changes, and telling the artifact SDK.
const THEME_STORAGE_KEY = "lavish-axi:theme";
const themeToggle = /** @type {HTMLButtonElement} */ (document.getElementById("themeToggle"));
const themeIconSwap = /** @type {HTMLSpanElement} */ (document.getElementById("themeIconSwap"));
const followSystemThemeItem = /** @type {HTMLButtonElement} */ (document.getElementById("followSystemTheme"));
const systemDarkMedia =
  typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
// Fallback for a page whose storage is unavailable: the choice holds for this tab only.
/** @type {"light" | "dark" | null} */
let sessionThemeChoice = null;

/** @returns {"light" | "dark" | null} */
function storedThemeChoice() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return sessionThemeChoice;
  }
}

/** @returns {"light" | "dark"} */
function effectiveTheme() {
  return storedThemeChoice() || (systemDarkMedia && systemDarkMedia.matches ? "dark" : "light");
}

// The frame learns the theme on every load (the frame "load" handler), so the boot call skips it.
function applyTheme({ notifyFrame = true } = {}) {
  const choice = storedThemeChoice();
  const root = document.documentElement;
  if (root) {
    if (choice) root.dataset.theme = choice;
    else delete root.dataset.theme;
  }
  const dark = effectiveTheme() === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  themeToggle.setAttribute("aria-pressed", String(dark));
  themeIconSwap.dataset.state = dark ? "b" : "a";
  themeToggle.setAttribute("aria-label", label);
  themeToggle.setAttribute("title", label);
  followSystemThemeItem.setAttribute("aria-checked", String(!choice));
  if (notifyFrame) postToFrame({ type: "lavish:theme", theme: effectiveTheme() });
}

/** @param {"light" | "dark" | null} choice */
function setThemeChoice(choice) {
  sessionThemeChoice = choice;
  try {
    if (choice) localStorage.setItem(THEME_STORAGE_KEY, choice);
    else localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Storage refused: sessionThemeChoice carries the choice for this tab.
  }
  applyTheme();
}

themeToggle.addEventListener("click", () => setThemeChoice(effectiveTheme() === "dark" ? "light" : "dark"));
followSystemThemeItem.addEventListener("click", () => {
  setThemeChoice(null);
  closeMenus();
});
if (systemDarkMedia && typeof systemDarkMedia.addEventListener === "function") {
  systemDarkMedia.addEventListener("change", () => {
    if (!storedThemeChoice()) applyTheme();
  });
}
// Another Lavish tab changed the choice.
window.addEventListener("storage", (event) => {
  if (event && event.key === THEME_STORAGE_KEY) applyTheme();
});
applyTheme({ notifyFrame: false });

// ---- Phone-width conversation sheet ----
// Below this width chrome.css turns the conversation panel into a dock the user raises as a
// bottom sheet over the artifact. This controller owns intent, accessibility state, gestures,
// visual-viewport measurements, and the dock summary; CSS owns the geometry. The query must match
// the one chrome.css lays the sheet out under.
const MOBILE_SHEET_MEDIA = "(max-width: 860px)";
// How far a drag on the dock must travel before it counts as a gesture rather than a tap.
const SHEET_DRAG_THRESHOLD_PX = 48;
const sheetStorageKey = "lavish-axi:sheet-open:" + key;
const sheetMedia = typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_SHEET_MEDIA) : null;
// The user's intent, kept across a chrome reload so a live-reload or server upgrade does not drop
// them back onto a closed dock mid-conversation.
let sheetOpen = readSheetOpen();
// The latest agent reply that landed while the sheet was closed: the dock previews it until the
// user opens the sheet, so a reply never arrives silently behind the artifact.
let unreadAgentReply = "";
/** @type {{ pointerId: any, startY: number, moved: boolean } | null} */
let sheetDrag = null;
let suppressSheetClick = false;

function readSheetOpen() {
  try {
    return sessionStorage.getItem(sheetStorageKey) === "1";
  } catch {
    return false;
  }
}

function isMobileSheet() {
  return Boolean(sheetMedia && sheetMedia.matches);
}

// Desktop Peek is the phone dock's geometry floated over the artifact, so it shares the dock's
// open intent, summary, and unread preview. The phone layout always wins over a stored desktop mode.
function isPeekLayout() {
  return !isMobileSheet() && chatLayout.mode === "peek";
}

function isRailLayout() {
  return !isMobileSheet() && chatLayout.mode === "rail";
}

function isDockLayout() {
  return isMobileSheet() || isPeekLayout();
}

function setSheetOpen(open) {
  const next = Boolean(open);
  const changed = next !== sheetOpen;
  sheetOpen = next;
  try {
    if (sheetOpen) sessionStorage.setItem(sheetStorageKey, "1");
    else sessionStorage.removeItem(sheetStorageKey);
  } catch {
    // Storage refused is not worth a broken sheet: the state just stops surviving a reload.
  }
  if (sheetOpen) unreadAgentReply = "";
  applySheetState();
  if (!changed || !isDockLayout()) return;
  if (sheetOpen) scrollPanelToBottom();
}

// Re-derives every sheet attribute from the phone layout, sheet-open, and session-ended state so a
// viewport crossing the breakpoint in either direction cannot make an ended panel interactive or
// leave a closed dock trapping focus.
function applySheetState() {
  const mobile = isMobileSheet();
  const peek = isPeekLayout();
  const rail = isRailLayout();
  const open = (mobile || peek) && sheetOpen;
  document.body.classList.toggle("sheet-open", mobile && open);
  document.body.classList.toggle("peek-open", peek && open);
  const docked = (mobile || peek) && !open;
  // A collapsed Peek keeps its composer live: typing a quick note should not need the transcript.
  panelScroll.inert = ended || docked || rail;
  chatComposer.inert = ended || (mobile && !open) || rail;
  const activeElement = document.activeElement;
  if (
    (docked || rail) &&
    activeElement &&
    (panelScroll.contains(activeElement) || (chatComposer.inert && chatComposer.contains(activeElement)))
  ) {
    (rail ? railOpenButton : panelToggle).focus();
  }
  panelToggle.setAttribute("aria-expanded", open ? "true" : "false");
  panelToggleIcon.dataset.state = open ? "b" : "a";
  panelToggle.setAttribute("aria-label", open ? "Hide conversation" : "Show conversation");
  renderSheetSummary();
}

// What the closed dock says. One line, most actionable state first: work the user has queued,
// then a reply they have not seen, then whether the agent is there to receive a send.
function sheetSummary() {
  if (ended) return { text: "Session ended", accent: false, unread: false };
  if (queued.length > 0) {
    return { text: queued.length === 1 ? "1 queued" : queued.length + " queued", accent: true, unread: false };
  }
  if (unreadAgentReply) return { text: unreadAgentReply, accent: false, unread: true };
  if (agentPresence === "working") return { text: "Agent is working…", accent: false, unread: false };
  if (agentPresence === "external") return { text: "External listener active", accent: false, unread: false };
  if (agentPresence === "listening") return { text: "Agent listening", accent: false, unread: false };
  return { text: "Agent not listening", accent: false, unread: false };
}

function renderSheetSummary() {
  const summary = sheetSummary();
  swapText(panelSummary, summary.text);
  panelSummary.classList.toggle("is-accent", summary.accent);
  panelSummary.classList.toggle("is-unread", summary.unread);
}

// A brief pulse on the dock when something the user should notice lands while the sheet is
// closed: a prompt they queued from the artifact, or an agent reply.
function pulseSheetDock() {
  if (!isDockLayout() || sheetOpen) return;
  panelHead.classList.remove("is-fresh");
  // Restart the animation even when the previous pulse is still running.
  void panelHead.offsetWidth;
  panelHead.classList.add("is-fresh");
}

function noteAgentReply(text) {
  if (isRailLayout()) {
    railHasUnread = true;
    railUnread.dataset.open = "true";
  }
  if (!isDockLayout() || sheetOpen) return;
  unreadAgentReply = String(text || "");
  renderSheetSummary();
  pulseSheetDock();
}

// The phone keyboard shrinks the visual viewport without touching the layout viewport on iOS, so
// the sheet reads its height and offset from here; chrome.css consumes these only under the phone
// breakpoint. Android reports the same numbers through the layout viewport thanks to the
// `interactive-widget=resizes-content` viewport meta, which makes this a no-op there.
function syncVisualViewport() {
  const root = document.documentElement;
  if (!root || !root.style || typeof root.style.setProperty !== "function") return;
  const viewport = window.visualViewport;
  const height = viewport ? viewport.height : window.innerHeight;
  const top = viewport ? viewport.offsetTop : 0;
  if (!(height > 0)) return;
  root.style.setProperty("--vv-height", Math.round(height) + "px");
  root.style.setProperty("--vv-top", Math.round(Math.max(0, top || 0)) + "px");
}

function sheetDragOffset(event) {
  return sheetDrag ? Number(event.clientY) - sheetDrag.startY : 0;
}

function clearSheetDrag() {
  sheetDrag = null;
  panel.classList.remove("is-dragging");
  panel.style.transform = "";
}

function finishSheetDrag(event) {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  const offset = sheetDragOffset(event);
  const moved = sheetDrag.moved;
  clearSheetDrag();
  if (!moved) return;
  // The click that follows a completed drag must not undo what the drag decided.
  suppressSheetClick = true;
  if (sheetOpen && offset > SHEET_DRAG_THRESHOLD_PX) setSheetOpen(false);
  else if (!sheetOpen && offset < -SHEET_DRAG_THRESHOLD_PX) setSheetOpen(true);
}

// The header's own tools (side switch, rail, back to the sidebar) keep their clicks to themselves.
function isPanelHeadTool(target) {
  return Boolean(target && typeof target.closest === "function" && target.closest(".panel-head-tools"));
}

panelHead.addEventListener("click", (event) => {
  if (!isDockLayout() || isPanelHeadTool(event?.target)) return;
  if (suppressSheetClick) {
    suppressSheetClick = false;
    return;
  }
  setSheetOpen(!sheetOpen);
});
panelScrim.addEventListener("click", () => setSheetOpen(false));
panelHead.addEventListener("pointerdown", (event) => {
  if (event.button || isPanelHeadTool(event.target)) return;
  if (isPeekLayout()) {
    peekDrag = {
      pointerId: event.pointerId,
      startY: Number(event.clientY),
      startHeight: chatLayout.peekHeight,
      moved: false,
    };
    if (typeof panelHead.setPointerCapture === "function") panelHead.setPointerCapture(event.pointerId);
    return;
  }
  if (!isMobileSheet()) return;
  sheetDrag = { pointerId: event.pointerId, startY: Number(event.clientY), moved: false };
  if (typeof panelHead.setPointerCapture === "function") panelHead.setPointerCapture(event.pointerId);
});
panelHead.addEventListener("pointermove", (event) => {
  if (peekDrag && event.pointerId === peekDrag.pointerId) {
    const offset = Number(event.clientY) - peekDrag.startY;
    if (Math.abs(offset) > 6) peekDrag.moved = true;
    if (peekDrag.moved) document.body.classList.add("is-resizing-peek");
    if (peekDrag.moved && sheetOpen) setPeekHeight(peekDrag.startHeight - offset, { save: false });
    return;
  }
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  const offset = sheetDragOffset(event);
  if (Math.abs(offset) > 6) sheetDrag.moved = true;
  if (!sheetDrag.moved) return;
  panel.classList.add("is-dragging");
  // Follow the finger: an open sheet only moves down, a closed dock only up.
  panel.style.transform = sheetOpen
    ? "translateY(" + Math.max(0, offset) + "px)"
    : "translateY(calc(100% - var(--dock-h) - env(safe-area-inset-bottom, 0px) + " + Math.min(0, offset) + "px))";
});
panelHead.addEventListener("pointerup", (event) => {
  if (peekDrag && event.pointerId === peekDrag.pointerId) {
    const offset = Number(event.clientY) - peekDrag.startY;
    const moved = peekDrag.moved;
    peekDrag = null;
    document.body.classList.remove("is-resizing-peek");
    if (!moved) return;
    suppressSheetClick = true;
    if (sheetOpen) saveChatLayout();
    else if (offset < -SHEET_DRAG_THRESHOLD_PX) setSheetOpen(true);
    return;
  }
  finishSheetDrag(event);
});
panelHead.addEventListener("pointercancel", (event) => {
  if (peekDrag && event.pointerId === peekDrag.pointerId) {
    peekDrag = null;
    document.body.classList.remove("is-resizing-peek");
    suppressSheetClick = false;
    return;
  }
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  clearSheetDrag();
  suppressSheetClick = false;
});
if (sheetMedia && typeof sheetMedia.addEventListener === "function") {
  sheetMedia.addEventListener("change", (event) => {
    if (!event.matches) {
      sheetOpen = false;
      try {
        sessionStorage.removeItem(sheetStorageKey);
      } catch {
        // Storage refusal only prevents persistence; the in-memory state is already reset.
      }
    }
    applySheetState();
  });
}
if (window.visualViewport && typeof window.visualViewport.addEventListener === "function") {
  window.visualViewport.addEventListener("resize", syncVisualViewport);
  window.visualViewport.addEventListener("scroll", syncVisualViewport);
}
window.addEventListener("resize", syncVisualViewport);
syncVisualViewport();

// ---- Desktop conversation layout: side, width, rail, Peek ----
// Layout is a personal preference, not session state, so it lives in one localStorage key across
// every session. The head bootstrap in server.js applies a stored layout before first paint with
// the same key and bounds; this controller owns the switch, the resize handle, the rail, and
// Peek's height. Under the phone breakpoint none of it applies: the sheet owns the panel there.
const LAYOUT_STORAGE_KEY = "lavish-axi:layout";
const PANEL_WIDTH_MIN = 280;
const PANEL_WIDTH_MAX = 560;
const PANEL_WIDTH_DEFAULT = 360;
// Never let the conversation take more than this share of the window from the artifact.
const PANEL_WIDTH_WINDOW_SHARE = 0.6;
const PANEL_WIDTH_KEY_STEP = 16;
const PEEK_HEIGHT_MIN = 200;
const PEEK_HEIGHT_DEFAULT = 440;
const PEEK_EDGE_GAP = 32;
const layoutRoot = /** @type {HTMLDivElement} */ (document.getElementById("layout"));
const panelResizer = /** @type {HTMLDivElement} */ (document.getElementById("panelResizer"));
const railOpenButton = /** @type {HTMLButtonElement} */ (document.getElementById("railOpen"));
const railPeekButton = /** @type {HTMLButtonElement} */ (document.getElementById("railPeek"));
const railUnread = /** @type {HTMLSpanElement} */ (document.getElementById("railUnread"));
const panelSeeThrough = /** @type {HTMLButtonElement} */ (document.getElementById("panelSeeThrough"));
const layoutOptionButtons = /** @type {Record<string, HTMLElement>} */ ({
  left: document.getElementById("layoutLeft"),
  right: document.getElementById("layoutRight"),
  rail: document.getElementById("layoutRail"),
  peek: document.getElementById("layoutPeek"),
});
/** @type {{ side: "left" | "right", mode: "sidebar" | "rail" | "peek", width: number, peekHeight: number }} */
let chatLayout = readChatLayout();
let railHasUnread = false;
/** @type {{ pointerId: any } | null} */
let panelResize = null;
/** @type {{ pointerId: any, startY: number, startHeight: number, moved: boolean } | null} */
let peekDrag = null;

function readChatLayout() {
  const layout = { side: "left", mode: "sidebar", width: PANEL_WIDTH_DEFAULT, peekHeight: PEEK_HEIGHT_DEFAULT };
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || "null");
    if (stored && typeof stored === "object") {
      if (stored.side === "right") layout.side = "right";
      if (stored.mode === "rail" || stored.mode === "peek") layout.mode = stored.mode;
      const width = Number(stored.width);
      if (width >= PANEL_WIDTH_MIN && width <= PANEL_WIDTH_MAX) layout.width = Math.round(width);
      const peekHeight = Number(stored.peekHeight);
      if (peekHeight >= PEEK_HEIGHT_MIN && peekHeight <= 2000) layout.peekHeight = Math.round(peekHeight);
    }
  } catch {
    // No storage or a corrupt value: the defaults stand, and this tab keeps its changes in memory.
  }
  return /** @type {any} */ (layout);
}

function saveChatLayout() {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(chatLayout));
  } catch {
    // Storage refused: the layout holds for this tab only.
  }
}

function layoutRect() {
  return layoutRoot && typeof layoutRoot.getBoundingClientRect === "function"
    ? layoutRoot.getBoundingClientRect()
    : null;
}

function clampPanelWidth(width) {
  const rect = layoutRect();
  const share = rect && rect.width > 0 ? Math.floor(rect.width * PANEL_WIDTH_WINDOW_SHARE) : PANEL_WIDTH_MAX;
  const max = Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, share));
  return Math.round(Math.min(max, Math.max(PANEL_WIDTH_MIN, Number(width) || PANEL_WIDTH_DEFAULT)));
}

function clampPeekHeight(height) {
  const rect = layoutRect();
  const max =
    rect && rect.bottom - rect.top > 0 ? Math.max(PEEK_HEIGHT_MIN, rect.bottom - rect.top - PEEK_EDGE_GAP) : 2000;
  return Math.round(Math.min(max, Math.max(PEEK_HEIGHT_MIN, Number(height) || PEEK_HEIGHT_DEFAULT)));
}

function applyChatLayout() {
  const root = document.documentElement;
  if (root) {
    root.dataset.panelSide = chatLayout.side;
    root.dataset.chatLayout = chatLayout.mode;
    if (root.style && typeof root.style.setProperty === "function") {
      root.style.setProperty("--panel-w", chatLayout.width + "px");
      root.style.setProperty("--peek-h", chatLayout.peekHeight + "px");
    }
  }
  for (const [option, button] of Object.entries(layoutOptionButtons)) {
    const pressed = option === chatLayout.mode || (chatLayout.mode === "sidebar" && option === chatLayout.side);
    button.setAttribute("aria-pressed", String(pressed));
  }
  panelResizer.setAttribute("aria-valuenow", String(chatLayout.width));
  if (chatLayout.mode !== "rail") railHasUnread = false;
  railUnread.dataset.open = String(railHasUnread);
  applySheetState();
}

/** @param {Partial<typeof chatLayout>} change */
/** @type {HTMLButtonElement} */ (document.getElementById("panelSwapSide")).onclick = () =>
  setChatLayout({ side: chatLayout.side === "left" ? "right" : "left", mode: "sidebar" });
/** @type {HTMLButtonElement} */ (document.getElementById("panelToRail")).onclick = () =>
  setChatLayout({ mode: "rail" });
/** @type {HTMLButtonElement} */ (document.getElementById("peekToSidebar")).onclick = () =>
  setChatLayout({ mode: "sidebar" });

function setChatLayout(change) {
  const enteringPeek = chatLayout.mode !== "peek" && change.mode === "peek";
  // A side flip swaps the grid's column order; tweening the tracks across that would stretch the
  // panel over the artifact, so the flip lands without the card-resize transition.
  const flippingSide = change.side !== undefined && change.side !== chatLayout.side;
  if (flippingSide) document.body.classList.add("is-flipping-side");
  chatLayout = { ...chatLayout, ...change };
  applyChatLayout();
  saveChatLayout();
  if (flippingSide) {
    void panel.offsetWidth;
    document.body.classList.remove("is-flipping-side");
  }
  if (enteringPeek) revealPeek();
}

let peekRevealTimer;

// Panel reveal: Peek rises into place when the user switches to it, not on a reload that restores it.
function revealPeek() {
  if (!isPeekLayout() || prefersReducedMotion()) return;
  clearTimeout(peekRevealTimer);
  panel.classList.remove("is-revealing");
  void panel.offsetWidth;
  panel.classList.add("is-revealing");
  peekRevealTimer = setTimeout(() => panel.classList.remove("is-revealing"), motionMs("--panel-open-dur", 400));
}

function setPanelWidth(width, { save = true } = {}) {
  chatLayout.width = clampPanelWidth(width);
  applyChatLayout();
  if (save) saveChatLayout();
}

function setPeekHeight(height, { save = true } = {}) {
  chatLayout.peekHeight = clampPeekHeight(height);
  applyChatLayout();
  if (save) saveChatLayout();
}

layoutOptionButtons.left.addEventListener("click", () => setChatLayout({ side: "left", mode: "sidebar" }));
layoutOptionButtons.right.addEventListener("click", () => setChatLayout({ side: "right", mode: "sidebar" }));
layoutOptionButtons.rail.addEventListener("click", () => setChatLayout({ mode: "rail" }));
layoutOptionButtons.peek.addEventListener("click", () => setChatLayout({ mode: "peek" }));
railOpenButton.addEventListener("click", () => setChatLayout({ mode: "sidebar" }));
railPeekButton.addEventListener("click", () => setChatLayout({ mode: "peek" }));

// The handle sits on the panel's inner edge, so which way is "wider" depends on the side.
panelResizer.addEventListener("pointerdown", (event) => {
  if (event.button) return;
  event.preventDefault();
  panelResize = { pointerId: event.pointerId };
  if (typeof panelResizer.setPointerCapture === "function") panelResizer.setPointerCapture(event.pointerId);
  // The artifact iframe would swallow the drag the moment the pointer crossed into it.
  document.body.classList.add("is-resizing-panel");
});
panelResizer.addEventListener("pointermove", (event) => {
  if (!panelResize || event.pointerId !== panelResize.pointerId) return;
  const rect = layoutRect();
  if (!rect) return;
  const x = Number(event.clientX);
  setPanelWidth(chatLayout.side === "right" ? rect.right - x : x - rect.left, { save: false });
});
function finishPanelResize(event) {
  if (!panelResize || event.pointerId !== panelResize.pointerId) return;
  panelResize = null;
  document.body.classList.remove("is-resizing-panel");
  saveChatLayout();
}
panelResizer.addEventListener("pointerup", finishPanelResize);
panelResizer.addEventListener("pointercancel", finishPanelResize);
panelResizer.addEventListener("dblclick", () => setPanelWidth(PANEL_WIDTH_DEFAULT));
panelResizer.addEventListener("keydown", (event) => {
  const grow = chatLayout.side === "right" ? "ArrowLeft" : "ArrowRight";
  const shrink = chatLayout.side === "right" ? "ArrowRight" : "ArrowLeft";
  let width = null;
  if (event.key === grow) width = chatLayout.width + PANEL_WIDTH_KEY_STEP;
  else if (event.key === shrink) width = chatLayout.width - PANEL_WIDTH_KEY_STEP;
  else if (event.key === "Home") width = PANEL_WIDTH_MIN;
  else if (event.key === "End") width = PANEL_WIDTH_MAX;
  if (width === null) return;
  event.preventDefault();
  setPanelWidth(width);
});

// Peek: hold the eye to fade the panel and read what is under it. The button lives in the dock
// head, whose click toggles the panel, so its own click must not reach the head.
function setSeeThrough(on) {
  document.body.classList.toggle("peek-see-through", Boolean(on) && isPeekLayout());
}
panelSeeThrough.addEventListener("pointerdown", () => setSeeThrough(true));
for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
  panelSeeThrough.addEventListener(type, () => setSeeThrough(false));
}
panelSeeThrough.addEventListener("click", (event) => {
  if (event && typeof event.stopPropagation === "function") event.stopPropagation();
});

function scrollElementIntoView(el) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function isPromptEditable(prompt) {
  return Boolean(prompt) && !terminalSubmission && !isPromptSending(prompt);
}

// Editing happens in the message box: whatever was being typed there steps aside until the edit
// ends, and comes back then.
let composerStash = null;

function editQueuedPrompt(index, { reveal = true } = {}) {
  const prompt = queued[index];
  if (ended || !isPromptEditable(prompt)) return;
  const id = promptIdentity(prompt);
  if (!id || id === editingPromptId) return;
  // Moving to another note keeps what was typed into the first, the way leaving a field does.
  commitQueuedEdit();
  composerStash = chatInput.value;
  editingPromptId = id;
  editingDraft = String(prompt.prompt || "");
  chatInput.value = editingDraft;
  editFocusPending = true;
  if (isDockLayout()) setSheetOpen(true);
  render();
  if (reveal && prompt.selector) postToFrame({ type: "lavish:revealElement", selector: String(prompt.selector) });
}

function endQueuedEdit() {
  const wasEditing = Boolean(editingPromptId);
  editingPromptId = "";
  editingDraft = "";
  if (wasEditing && composerStash !== null) chatInput.value = composerStash;
  composerStash = null;
}

// Writes the open edit into its note without rendering. Returns whether the queue changed. A note
// cleared of words and images is removed, as if its remove control had been used.
function commitQueuedEdit() {
  if (!editingPromptId) return false;
  const index = queued.findIndex((prompt) => promptIdentity(prompt) === editingPromptId);
  const text = editingDraft.trim();
  endQueuedEdit();
  const prompt = queued[index];
  if (!isPromptEditable(prompt)) return false;
  if (!text && !attachmentCount(prompt)) {
    queued.splice(index, 1);
    afterQueuedPromptRemoved();
  } else {
    // In place, not replaced: the send bookkeeping tracks notes by object identity.
    prompt.prompt = text;
    persistQueuedPrompts();
  }
  return true;
}

function saveQueuedEdit() {
  commitQueuedEdit();
  render();
}

function cancelQueuedEdit() {
  endQueuedEdit();
  render();
}

// A click on an element the artifact knows carries a queued note. The artifact names only the
// selector, so the most a forged message can do is open one of the user's own notes for editing.
function editQueuedAnchor(selector) {
  if (!selector) return;
  for (let index = queued.length - 1; index >= 0; index--) {
    if (isElementAnchoredPrompt(queued[index]) && queuedAnchorSelectorsOf(queued[index]).includes(selector)) {
      if (isPromptEditable(queued[index])) {
        editQueuedPrompt(index, { reveal: false });
        return;
      }
      break;
    }
  }
  // The note is already on its way, or gone: the click still deserves the card it would have had.
  postToFrame({ type: "lavish:annotateElement", selector });
}

// Notes that point at a whole element, cell, or diagram node, which a later click on that same
// target can find again. A text selection's note is about the words, not the element around them.
function isElementAnchoredPrompt(prompt) {
  const kind = promptAnchor(prompt)?.kind;
  return Boolean(prompt.selector) && (kind === "element" || kind === "cell" || kind === "node");
}

// A diagram node is one target however deep the click lands, so its note answers to the node's
// own selector as well as the clicked element's. Other notes name only the exact element.
function queuedAnchorSelectorsOf(prompt) {
  const target = prompt.target && typeof prompt.target === "object" ? prompt.target : null;
  const whole = target?.type === "mermaid-node" ? String(target.selector || "") : "";
  return whole ? [String(prompt.selector), whole] : [String(prompt.selector)];
}

// Element-anchored queued notes are numbered 1, 2, 3 in queue order. The same number labels the
// note's anchor in the panel and its pin on the artifact, which is how the reader matches them.
function queuedPinNumber(prompt) {
  if (!isElementAnchoredPrompt(prompt)) return 0;
  return queued.filter((candidate) => isElementAnchoredPrompt(candidate)).indexOf(prompt) + 1;
}

// Tells the artifact which element selectors carry a queued note, and where each note's pin goes.
// Only selectors and pin numbers cross into the frame: the artifact is agent-authored, and the
// note text stays in the chrome.
function postQueuedAnchors(force = false) {
  const anchored = queued.filter((prompt) => isElementAnchoredPrompt(prompt));
  const selectors = [...new Set(anchored.flatMap(queuedAnchorSelectorsOf))];
  const pins = anchored.map((prompt, index) => ({ selector: String(prompt.selector), number: index + 1 }));
  marks.forEach((mark, index) => {
    if (isElementAnchoredPrompt(mark)) pins.push({ selector: String(mark.selector), number: markNumber(index) });
  });
  const signature = JSON.stringify([selectors, pins]);
  if (!force && signature === postedQueuedAnchors) return;
  postedQueuedAnchors = signature;
  postToFrame({ type: "lavish:queuedAnchors", selectors, pins });
}

// Pointing at a queued note lights its pin and block in the artifact. This only outlines; the
// artifact scrolls when the note is opened for editing, not on a passing hover.
let hotPinSelector = "";
function setHotPin(selector) {
  if (selector === hotPinSelector) return;
  hotPinSelector = selector;
  postToFrame({ type: "lavish:hotPin", selector });
}

queuedLog.addEventListener("mouseover", (event) => {
  const target = /** @type {Element | null} */ (event.target);
  const bubble = target && typeof target.closest === "function" ? target.closest(".queue-item") : null;
  const prompt = bubble ? queued[Number(/** @type {HTMLElement} */ (bubble).dataset.index)] : null;
  setHotPin(prompt && isElementAnchoredPrompt(prompt) ? String(prompt.selector) : "");
});
queuedLog.addEventListener("mouseleave", () => setHotPin(""));

queuedLog.addEventListener("click", (event) => {
  const target = /** @type {Element | null} */ (event.target);
  if (!target || typeof target.closest !== "function") return;
  // The remove control owns its own click.
  if (target.closest(".queued-remove")) return;
  const row = /** @type {HTMLElement | null} */ (target.closest(".queued-edit") || target.closest(".queue-item"));
  if (row) editQueuedPrompt(Number(row.dataset.index));
});

/** @type {HTMLButtonElement} */ (document.getElementById("editCancel")).onclick = () => cancelQueuedEdit();
queueToggle.onclick = () => {
  const open = queueToggle.getAttribute("aria-expanded") !== "false";
  queueToggle.setAttribute("aria-expanded", String(!open));
  queuePanel.classList.toggle("is-collapsed", open);
};

// A mark's number carries on from the queued notes' pins, so the chip in the box, the pin on the
// artifact, and the [n] the reviewer types all agree.
function markNumber(index) {
  return queued.filter((prompt) => isElementAnchoredPrompt(prompt)).length + index + 1;
}

function addMark(rawPrompt) {
  if (ended || terminalSubmission) return;
  const mark = adoptQueuedPrompt(rawPrompt, false);
  if (!mark || !mark.selector) return;
  delete mark[internalQueueKeyField];
  const note = String(mark.prompt || "").trim();
  // Marking the same block twice without a word adds nothing. A note on it is worth keeping.
  const bare = (item) => !String(item.prompt || "").trim() && !attachmentCount(item);
  if (bare(mark) && marks.some((item) => item.selector === mark.selector && bare(item))) return;
  marks.push(mark);
  editFocusPending = !editingPromptId && !note;
  render();
  pulseSheetDock();
}

function removeMark(index) {
  if (!marks[index]) return;
  marks.splice(index, 1);
  setHotPin("");
  render();
}

function markChipHtml(mark, index) {
  const anchor = promptAnchor(mark);
  const number = markNumber(index);
  const note = String(mark.prompt || "").trim();
  const title = [note, anchor?.excerpt, mark.selector].filter(Boolean).join("\n");
  return (
    '<span class="mark-chip" data-index="' +
    index +
    '" title="' +
    escapeHtml(title) +
    '"><span class="anchor-pin">' +
    number +
    '</span><span class="anchor-kind">' +
    escapeHtml(anchor?.label || "") +
    "</span>" +
    (anchor?.excerpt ? '<span class="mark-chip-excerpt">' + escapeHtml(anchor.excerpt) + "</span>" : "") +
    (note || attachmentCount(mark) ? '<span class="mark-chip-note" title="Has its own note">+ note</span>' : "") +
    '<button class="mark-chip-remove" type="button" aria-label="Remove mark ' +
    number +
    '" data-index="' +
    index +
    '">' +
    REMOVE_ICON_SVG +
    "</button></span>"
  );
}

function renderMarks() {
  const html = marks.map(markChipHtml).join("");
  messageMarks.hidden = marks.length === 0;
  if (html === renderedMarks) return;
  renderedMarks = html;
  messageMarks.innerHTML = html;
}

// The marks become notes of their own, numbered as the chips were, ahead of the message that
// talks about them. A mark with no words still goes: its number is what the message refers to.
function takeMarks() {
  const numbers = marks.map((_, index) => markNumber(index));
  const taken = marks.splice(0).map((mark, index) => {
    const note = String(mark.prompt || "").trim();
    const prompt = { ...mark, prompt: "[" + numbers[index] + "]" + (note ? " " + note : "") };
    assignPromptIdentity(prompt, false);
    return prompt;
  });
  setHotPin("");
  return taken;
}

messageMarks.addEventListener("click", (event) => {
  const target = /** @type {Element | null} */ (event.target);
  const remove = target && typeof target.closest === "function" ? target.closest(".mark-chip-remove") : null;
  if (remove) removeMark(Number(/** @type {HTMLElement} */ (remove).dataset.index));
});
messageMarks.addEventListener("mouseover", (event) => {
  const target = /** @type {Element | null} */ (event.target);
  const chip = target && typeof target.closest === "function" ? target.closest(".mark-chip") : null;
  const mark = chip ? marks[Number(/** @type {HTMLElement} */ (chip).dataset.index)] : null;
  setHotPin(mark && isElementAnchoredPrompt(mark) ? String(mark.selector) : "");
});
messageMarks.addEventListener("mouseleave", () => setHotPin(""));

// Queue for later (Ctrl+Q, or the Queue button): the message joins the queue without sending, so
// several thoughts can go out as one batch.
function queueComposerDraft() {
  if (ended || terminalSubmission) return;
  if (editingPromptId) {
    saveQueuedEdit();
    return;
  }
  const blocked = chatAttachmentController.hasPending() || chatAttachmentController.hasErrors();
  if (blocked) {
    chatAttachmentController.noteSendBlocked();
    return;
  }
  const text = chatInput.value.trim();
  const attachments = chatAttachmentController.collectReady();
  if (!text && !attachments.length && !marks.length) {
    rejectEmptySend();
    return;
  }
  queued.push(...takeMarks());
  if (text || attachments.length) {
    const prompt = { uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" };
    if (attachments.length) prompt.attachments = attachments;
    assignPromptIdentity(prompt, false);
    queued.push(prompt);
  }
  persistQueuedPrompts();
  render();
  chatInput.value = "";
  chatAttachmentController.reset();
  hideSendHint();
  renderSuggestions();
  renderSendLabel();
}
/** @type {HTMLButtonElement} */ (document.getElementById("queueLater")).onclick = queueComposerDraft;

// The send button counts what it will deliver once there is more than one thing: "Send 3 to Agent".
const sendLabel = /** @type {HTMLSpanElement} */ (document.getElementById("sendLabel"));
function renderSendLabel() {
  const draft = !editingPromptId && Boolean(chatInput.value.trim());
  const pending = queued.length + marks.length + (draft ? 1 : 0);
  swapText(sendLabel, pending > 1 ? "Send " + pending + " to Agent" : "Send to Agent");
}

function removeQueuedPrompt(index, event) {
  if (event) event.stopPropagation();
  if (terminalSubmission || isPromptSending(queued[index])) return;
  queued.splice(index, 1);
  afterQueuedPromptRemoved();
  render();
}

function afterQueuedPromptRemoved() {
  persistQueuedPrompts();
  if (!queued.length) {
    clearSendAcknowledgementWarning();
    if (sendFailureOwner?.kind !== "preparation") clearPersistentSendFailure();
  }
}

function promptQueueKey(prompt) {
  return prompt && typeof prompt[internalQueueKeyField] === "string" ? prompt[internalQueueKeyField].trim() : "";
}

function beginFeedbackPreparation() {
  if (ended || terminalSubmission) return null;
  /** @type {(succeeded: boolean) => void} */
  let finishPromise = () => {};
  const done = new Promise((resolve) => {
    finishPromise = resolve;
  });
  const preparation = {
    done,
    finish(succeeded) {
      if (!feedbackPreparations.delete(preparation)) return;
      finishPromise(succeeded);
    },
  };
  feedbackPreparations.add(preparation);
  return preparation;
}

function enqueuePrompt(rawPrompt, /** @type {FeedbackPreparation | null} */ preparation = null) {
  if ((preparation && !feedbackPreparations.has(preparation)) || (terminalSubmission && !preparation)) return false;
  // The sandboxed iframe is untrusted: never accept a caller-supplied settlement identity.
  const prompt = adoptQueuedPrompt(rawPrompt, false);
  if (!prompt) return false;

  const queueKey = promptQueueKey(prompt);
  if (queueKey) {
    const index = queued.findIndex((item) => promptQueueKey(item) === queueKey);
    if (index !== -1) {
      // The replacement is the artifact's newer answer. Words typed against the old answer never
      // move onto it; they are handed back to the reviewer instead.
      if (editingPromptId && promptIdentity(queued[index]) === editingPromptId) {
        const draft = editingDraft.trim();
        endQueuedEdit();
        if (draft !== String(queued[index].prompt || "").trim()) keepRetiredDraft(draft);
      }
      queued[index] = prompt;
    } else {
      queued.push(prompt);
    }
  } else {
    queued.push(prompt);
  }
  persistQueuedPrompts();
  render();
  return true;
}

function stripInternalPromptFields(prompt) {
  if (!prompt || typeof prompt !== "object") return prompt;
  const clean = { ...prompt };
  delete clean[internalQueueKeyField];
  return clean;
}

function postToFrame(message) {
  if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
}

function requestSnapshot(action, prompts = [], endAfter = false, terminal = null) {
  const requestId = "snapshot-" + ++nextSnapshotRequestId;
  const request =
    action === "submit"
      ? {
          action,
          prompts,
          chatAtRequest: displayedChat.slice(),
          endAfter,
          terminal,
          order: terminal?.order || ++nextSendOperationOrder,
        }
      : { action };
  snapshotRequests.set(requestId, request);
  if (action === "submit") {
    request.acknowledgement = {};
    pendingAcknowledgements.add(request.acknowledgement);
    armSendAcknowledgementWarning();
    request.timeout = setTimeout(() => completeSnapshotRequest(requestId, ""), SNAPSHOT_REQUEST_TIMEOUT_MS);
  }
  postToFrame({ type: "lavish:requestSnapshot", snapshot_request_id: requestId });
}

function takeSnapshotRequest(requestId) {
  if (typeof requestId !== "string" || !requestId || !snapshotRequests.has(requestId)) return null;
  const request = snapshotRequests.get(requestId);
  snapshotRequests.delete(requestId);
  if (request?.timeout) clearTimeout(request.timeout);
  return request || null;
}

function completeSnapshotRequest(requestId, snapshot) {
  const request = takeSnapshotRequest(requestId);
  if (!request) return;
  if (request.action === "copy") {
    copyText(snapshot || "");
    return;
  }

  submitQueued({
    prompts: request.prompts || [],
    chatAtRequest: request.chatAtRequest || [],
    domSnapshot: snapshot || "",
    endAfter: request.endAfter === true,
    terminal: request.terminal || null,
    acknowledgement: request.acknowledgement || null,
    order: request.order || 0,
  }).catch(() => {});
}

function createChatAttachmentsController() {
  const items = [];
  let nextId = 0;
  let capRejected = false;
  let sendBlocked = false;

  function currentImageCount() {
    return items.filter((item) => item.file && CHAT_ATTACHMENT_MIME.has(item.file.type)).length;
  }

  function renderAttachments() {
    chatAttachments.innerHTML = items
      .map((item) => {
        const status = item.status === "uploading" ? "Uploading…" : item.status === "error" ? item.error : "";
        const preview = item.preview
          ? '<img class="chat-attachment-thumb" src="' +
            escapeHtml(item.preview) +
            '" alt="' +
            escapeHtml(item.name || "") +
            '">'
          : "";
        const retry =
          item.status === "error" && item.file
            ? '<button type="button" aria-label="Retry ' +
              escapeHtml(item.name) +
              '" data-chat-attachment-retry="' +
              item.localId +
              '">Retry</button>'
            : "";
        const errorData = item.errorCode ? ' data-error="' + escapeHtml(item.errorCode) + '"' : "";
        return (
          '<div class="chat-attachment-chip chat-attachment-' +
          item.status +
          '"' +
          errorData +
          ">" +
          preview +
          '<span class="chat-attachment-copy"><strong>' +
          escapeHtml(item.name) +
          "</strong>" +
          (status ? '<span class="chat-attachment-status" aria-live="polite">' + escapeHtml(status) + "</span>" : "") +
          "</span>" +
          retry +
          '<button type="button" aria-label="Remove ' +
          escapeHtml(item.name) +
          '" title="Remove ' +
          escapeHtml(item.name) +
          '" data-chat-attachment-remove="' +
          item.localId +
          '">×</button></div>'
        );
      })
      .join("");
    syncNotice();
  }

  // The notice is DERIVED from the current item states on every render, never
  // written imperatively by a caller: a blocked send that only stamped a string
  // went stale the moment the pending upload it described failed, leaving the
  // user waiting on an upload that was already over.
  function syncNotice() {
    if (currentImageCount() < attachmentMaxCount) capRejected = false;
    const pending = items.some((item) => item.status === "uploading");
    const errored = items.some((item) => item.status === "error");
    if (!pending && !errored) sendBlocked = false;
    chatAttachmentNotice.textContent =
      sendBlocked && pending
        ? "Waiting for an image to finish uploading…"
        : sendBlocked && errored
          ? "An image couldn't be attached. Retry or remove it before sending."
          : capRejected
            ? "You can attach up to " + attachmentMaxCount + " image" + (attachmentMaxCount === 1 ? "" : "s") + "."
            : "";
  }

  async function startUpload(item) {
    const abortController = new AbortController();
    item.abortController = abortController;
    item.status = "uploading";
    item.error = "";
    renderAttachments();
    try {
      const bytes = await item.file.arrayBuffer();
      if (!items.includes(item)) return;
      await uploadAttachment(
        { localId: item.localId, bytes, mime: item.file.type },
        (result) => {
          if (!items.includes(item)) return;
          if (result.ok && result.id) {
            item.status = "ready";
            item.id = result.id;
          } else {
            item.status = "error";
            item.error = String(result.error || "Upload failed");
          }
          renderAttachments();
        },
        abortController.signal,
      );
    } catch (error) {
      if (!items.includes(item)) return;
      item.status = "error";
      item.error = error instanceof Error ? error.message : String(error);
      renderAttachments();
    }
  }

  function addFiles(files) {
    let added = false;
    let imageCount = currentImageCount();
    for (const file of Array.from(files || [])) {
      if (!CHAT_ATTACHMENT_MIME.has(String(file.type || ""))) continue;
      const tooLarge = attachmentMaxBytes > 0 && Number(file.size) > attachmentMaxBytes;
      // The cap counts only chips that can upload, mirroring currentImageCount:
      // if a size-refused chip (file: null) consumed a slot here, syncNotice
      // would clear the cap notice on the same render tick and a valid image
      // later in the batch would vanish with no chip and no explanation.
      if (!tooLarge && imageCount >= attachmentMaxCount) {
        capRejected = true;
        continue;
      }
      const localId = String(nextId++);
      const item = {
        localId,
        file: tooLarge ? null : file,
        name: String(file.name || "image"),
        preview: tooLarge ? "" : URL.createObjectURL(file),
        status: tooLarge ? "error" : "uploading",
        error: tooLarge ? "Image is larger than the " + formatByteLimit(attachmentMaxBytes) + " limit" : "",
        errorCode: "",
        id: "",
        abortController: /** @type {AbortController | null} */ (null),
      };
      items.push(item);
      if (!tooLarge) imageCount += 1;
      added = true;
      if (!tooLarge) startUpload(item);
    }
    renderAttachments();
    return added;
  }

  function rejectUnsupported(files) {
    for (const file of Array.from(files || [])) {
      if (CHAT_ATTACHMENT_MIME.has(String(file.type || ""))) continue;
      items.push({
        localId: String(nextId++),
        file: null,
        name: String(file.name || "file"),
        preview: "",
        status: "error",
        error: "Unsupported file type. Use " + CHAT_ATTACHMENT_LABELS + ".",
        errorCode: "UNSUPPORTED_TYPE",
        id: "",
        abortController: /** @type {AbortController | null} */ (null),
      });
    }
    renderAttachments();
  }

  function remove(localId) {
    const index = items.findIndex((item) => item.localId === localId);
    if (index < 0) return;
    const [item] = items.splice(index, 1);
    item.abortController?.abort();
    if (item.preview) URL.revokeObjectURL(item.preview);
    renderAttachments();
  }

  function reset() {
    for (const item of items) {
      item.abortController?.abort();
      if (item.preview) URL.revokeObjectURL(item.preview);
    }
    items.length = 0;
    capRejected = false;
    sendBlocked = false;
    renderAttachments();
  }

  return {
    addFiles,
    rejectUnsupported,
    remove,
    retry(localId) {
      const item = items.find((candidate) => candidate.localId === localId);
      if (item?.file) startUpload(item);
    },
    hasPending: () => items.some((item) => item.status === "uploading"),
    hasErrors: () => items.some((item) => item.status === "error"),
    noteSendBlocked() {
      sendBlocked = true;
      syncNotice();
    },
    collectReady: () =>
      items.filter((item) => item.status === "ready").map((item) => ({ id: item.id, name: item.name })),
    reset,
  };
}

const chatAttachmentController = createChatAttachmentsController();

function sendQueued(endAfter) {
  if (ended) return;
  if (terminalSubmission) {
    if (endAfter && !terminalSubmission.inFlight) retryTerminalSubmission();
    return;
  }
  closeMenus();
  // Send delivers what the panel shows, so an open edit is kept rather than sent stale.
  if (commitQueuedEdit()) render();

  // A pending or failed chip holds back only the COMPOSER message (and an
  // explicit end, which would strand the chips) - queued annotation prompts
  // still deliver, mirroring how the annotation card holds only its own card
  // open. Gating the whole pipeline here made Send and Send & End silently
  // deliver nothing while the only signal sat in the composer toolbar.
  const chipsBlocked = chatAttachmentController.hasPending() || chatAttachmentController.hasErrors();
  if (chipsBlocked) chatAttachmentController.noteSendBlocked();

  if (!chipsBlocked) {
    const text = chatInput.value.trim();
    const attachments = chatAttachmentController.collectReady();
    if (text || attachments.length || marks.length) {
      queued.push(...takeMarks());
      if (text || attachments.length) {
        const prompt = { uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" };
        if (attachments.length) prompt.attachments = attachments;
        assignPromptIdentity(prompt, false);
        queued.push(prompt);
      }
      persistQueuedPrompts();
      // Render the durable queued bubble before clearing the editor. If anything after this point
      // fails, the user's words are already both stored and visibly recoverable in the tab. It
      // becomes a sent bubble only when the server's transcript carries it (see submitQueuedOnce).
      render();
      chatInput.value = "";
      chatAttachmentController.reset();
    }
  }
  const shouldEnd = Boolean(endAfter && !chipsBlocked);
  const preparations = shouldEnd ? [...feedbackPreparations] : [];
  if (!queued.length && preparations.length === 0) {
    if (!chipsBlocked && !sendFailureOwner) rejectEmptySend();
    return;
  }
  if (!sendFailureOwner) hideSendHint(true);
  if (shouldEnd) {
    const terminal = {
      prompts: [],
      inFlight: true,
      order: ++nextSendOperationOrder,
    };
    terminalSubmission = terminal;
    updateSendState();
    finishTerminalPreparation(terminal, preparations);
    return;
  }
  requestSnapshot("submit", queued.slice(), false, null);
  render();
}

function finishTerminalPreparation(terminal, preparations) {
  if (preparations.length === 0) {
    completeTerminalPreparation(terminal, []);
    return;
  }
  const timeout = setTimeout(() => {
    if (terminalSubmission !== terminal || ended) return;
    for (const preparation of preparations) preparation.finish(false);
    showPersistentSendFailure(
      "Could not finish preparing all feedback within 5 seconds. This review remains open, and existing queued feedback is still editable.",
      false,
      { kind: "preparation", operation: terminal, preparationType: "terminal" },
    );
    releaseTerminalSubmission(terminal);
  }, TERMINAL_PREPARATION_TIMEOUT_MS);
  Promise.all(preparations.map((preparation) => preparation.done)).then((results) => {
    clearTimeout(timeout);
    completeTerminalPreparation(terminal, results);
  });
}

function completeTerminalPreparation(terminal, results) {
  if (terminalSubmission !== terminal || ended) return;
  if (results.some((succeeded) => !succeeded)) {
    releaseTerminalSubmission(terminal);
    return;
  }
  terminal.prompts = queued.slice();
  clearPreparationFailure("terminal");
  if (!terminal.prompts.length) {
    releaseTerminalSubmission(terminal);
    if (!sendFailureOwner) rejectEmptySend();
    return;
  }
  // Only make the reservation durable once every preparation has joined the exact
  // batch. A reload before this point must restore an ordinary editable queue, not
  // an incomplete terminal submission.
  persistTerminalReservation(true);
  requestSnapshot("submit", terminal.prompts, true, terminal);
  render();
}

function retryTerminalSubmission() {
  if (!terminalSubmission || terminalSubmission.inFlight || ended) return;
  terminalSubmission.inFlight = true;
  updateSendState();
  requestSnapshot("submit", terminalSubmission.prompts, true, terminalSubmission);
  render();
}

function markTerminalSubmissionFailed(submission) {
  if (!terminalSubmission || submission.terminal !== terminalSubmission || ended) return;
  terminalSubmission.inFlight = false;
  updateSendState();
}

function releaseTerminalSubmission(terminal) {
  if (terminalSubmission !== terminal || ended) return;
  terminalSubmission = null;
  persistTerminalReservation(false);
  render();
}

async function submitQueued(submission) {
  if (!Array.isArray(submission.chatAtRequest)) submission.chatAtRequest = displayedChat.slice();
  pendingSubmissions.push(submission);
  if (submitQueuedPromise) {
    return submitQueuedPromise;
  }

  submitQueuedPromise = (async () => {
    /** @type {unknown} */
    let firstError = null;
    while (pendingSubmissions.length && !ended) {
      const next = pendingSubmissions.shift();
      if (!next) continue;
      activeSubmission = next;
      try {
        const result = await submitQueuedOnce(next, firstError !== null);
        if (result === false) markTerminalSubmissionFailed(next);
      } catch (error) {
        markTerminalSubmissionFailed(next);
        if (firstError === null) firstError = error;
      } finally {
        if (next.acknowledgement) pendingAcknowledgements.delete(next.acknowledgement);
        activeSubmission = null;
        // Whatever happened, the batch is no longer in flight: a failed note reads Queued again
        // with its remove control back.
        render();
      }
    }
    if (firstError !== null) throw firstError;
  })();
  try {
    return await submitQueuedPromise;
  } finally {
    submitQueuedPromise = null;
  }
}

async function submitQueuedOnce(submission, preserveFailureState = false) {
  settleQueuedFromTranscript(displayedChat);
  const prompts = submission.prompts.filter(
    (prompt) => !deliveredPrompts.has(prompt) && !promptAcknowledgedInChat(prompt, displayedChat),
  );
  const shouldEndSession = submission.endAfter;
  if (!prompts.length) {
    if (shouldEndSession && !ended) {
      try {
        await endSession(submission.terminal);
      } catch (error) {
        showPersistentSendFailure(TERMINAL_SEND_FAILED_COPY, false, {
          kind: "terminal",
          operation: submission.terminal,
        });
        throw error;
      }
    }
    settleAcknowledgementGuidance(submission, preserveFailureState);
    return;
  }
  const body = { prompts: prompts.map(stripInternalPromptFields), domSnapshot: submission.domSnapshot };
  if (shouldEndSession) body.endSession = true;
  let response;
  try {
    response = await fetch("/api/" + key + "/prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    // The DOM snapshot is optional context and can be the difference between a
    // useful terminal batch and Express' request-size limit. Retry exactly once
    // without it; never mutate or split the user's exact feedback batch.
    if (response.status === 413 && body.domSnapshot) {
      body.domSnapshot = "";
      response = await fetch("/api/" + key + "/prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
  } catch (error) {
    showQueuedSendFailure(submission.terminal ? TERMINAL_SEND_FAILED_COPY : SEND_FAILED_COPY, {
      kind: submission.terminal ? "terminal" : "submission",
      operation: submission.terminal || submission,
    });
    throw error;
  }
  if (!response.ok) {
    if (response.status === 413) {
      showQueuedSendFailure(
        "Could not send because this feedback is too large. It is still queued. Remove some feedback or attachments, then try again.",
        { kind: "submission", operation: submission },
      );
      if (submission.terminal) releaseTerminalSubmission(submission.terminal);
      throw new Error("queued feedback exceeds the request size limit");
    }
    if (response.status === 409) {
      const data = await response.json().catch(() => null);
      // The session already ended before this batch arrived - most likely this chrome missed the
      // live `ended` event (a dropped connection). Go read-only now instead of leaving Send enabled
      // for another attempt that will be refused the same way.
      if (data?.status === "ended") {
        clearSendAcknowledgementWarning();
        markSessionEnded();
        return false;
      }
      if (Array.isArray(data?.warnings)) setLayoutWarnings(data.warnings);
      showQueuedSendFailure(
        "Could not send because the layout issue selection changed. Your feedback is still queued. Review the current issues, then click Send to Agent to retry.",
        { kind: "submission", operation: submission },
      );
      if (submission.terminal) releaseTerminalSubmission(submission.terminal);
      return;
    }
    // C4: the server persisted nothing (atomic reject) - the queue below is left
    // intact because the splice only runs on success. Surface exactly what failed
    // so the user can fix the offending attachment(s) rather than losing them.
    if (response.status === 400) {
      const detail = await response.json().catch(() => ({}));
      if (Array.isArray(detail.rejected) && detail.rejected.length) {
        showQueuedSendFailure(describeAttachmentRejection(detail.rejected, detail.caps), {
          kind: "submission",
          operation: submission,
        });
        if (submission.terminal) releaseTerminalSubmission(submission.terminal);
      } else {
        showQueuedSendFailure(submission.terminal ? TERMINAL_SEND_FAILED_COPY : SEND_FAILED_COPY, {
          kind: submission.terminal ? "terminal" : "submission",
          operation: submission.terminal || submission,
        });
      }
    } else {
      showQueuedSendFailure(submission.terminal ? TERMINAL_SEND_FAILED_COPY : SEND_FAILED_COPY, {
        kind: submission.terminal ? "terminal" : "submission",
        operation: submission.terminal || submission,
      });
    }
    throw new Error("failed to submit queued prompts");
  }
  const accepted = typeof response.json === "function" ? await response.json().catch(() => null) : null;
  rememberChatAckIds(accepted?.ack_ids);
  const acceptedChat = Array.isArray(accepted?.chat) ? accepted.chat : null;
  if (acceptedChat) settleQueuedFromTranscript(acceptedChat);
  const acceptedRevision = parseChatRevision(accepted?.chat_revision);
  const reconciledChat = acceptedChat
    ? acceptedRevision !== null && acceptedRevision > chatRevision
      ? acceptedChat
      : mergeAcceptedChat(acceptedChat, submission.chatAtRequest)
    : null;
  if (!acceptedChat || reconciledChat) {
    for (const prompt of prompts) {
      deliveredPrompts.add(prompt);
      const index = queued.indexOf(prompt);
      if (index !== -1) queued.splice(index, 1);
    }
    persistQueuedPrompts();
    if (reconciledChat) syncChat(reconciledChat, acceptedRevision);
  }
  render();
  settleAcknowledgementGuidance(submission, preserveFailureState);
  if (shouldEndSession) {
    markSessionEnded();
    return;
  }
}

function submissionResolvesSendFailure(submission) {
  if (!sendFailureOwner) return true;
  if (sendFailureOwner.kind === "preparation") return false;
  if (sendFailureOwner.kind === "terminal") return sendFailureOwner.operation === submission.terminal;
  const failedSubmission = sendFailureOwner.operation;
  return (
    failedSubmission === submission ||
    (Array.isArray(failedSubmission.prompts) &&
      failedSubmission.prompts.every((prompt) => deliveredPrompts.has(prompt)))
  );
}

function settleAcknowledgementGuidance(submission, preserveFailureState) {
  if (!submissionResolvesSendFailure(submission) || (preserveFailureState && queued.length)) return;
  const hasLaterAcknowledgement = [...pendingAcknowledgements].some(
    (acknowledgement) => acknowledgement !== submission.acknowledgement,
  );
  if (hasLaterAcknowledgement) {
    if (!sendAcknowledgementTimer && !sendAcknowledgementWarningVisible) armSendAcknowledgementWarning();
    return;
  }
  clearSendAcknowledgementWarning();
  clearPersistentSendFailure();
}

function normalizeLayoutFindings(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && String(item.severity || "").toLowerCase() === "error")
    : [];
}

function clearLayoutGateTimer() {
  layoutGateEscape?.cancel?.();
  if (layoutGateTimer) clearTimeout(layoutGateTimer);
  layoutGateTimer = undefined;
}

function setLayoutGateCard(state) {
  if (!layoutGateTitle || !layoutGateCopy) return;

  if (state === "held") {
    layoutGateTitle.innerHTML = "Fixing a layout issue...";
    layoutGateCopy.textContent =
      "The browser found inaccessible or unusable content. Your agent has been notified and this will reveal after the next clean reload.";
    return;
  }

  layoutGateTitle.innerHTML = "Checking layout.<br>One moment.";
  layoutGateCopy.textContent = "Lavish is waiting for fonts and final geometry before revealing this artifact.";
}

function setLayoutGateActive(active) {
  layoutGateVisible = active;
  if (layoutGateOverlay) layoutGateOverlay.hidden = !active;
  document.body?.classList?.toggle("layout-gate-active", active);
}

// Terminal, user-recoverable failure state for the one thing the chrome cannot work around on
// its own: the artifact never loaded and retrying stopped helping. The overlay is reused because
// it already covers the empty artifact area; without this the user is left looking at either a
// spinner that never resolves or a blank frame, with nothing explaining it and nothing to click.
// Bumping the cycle invalidates the previous timer; setLayoutGateFailure immediately replaces it
// with a fresh hold timer so the card cannot strand the visual gate.
function setLayoutGateFailure(title, copy, actionLabel = "Reload", onAction, { sticky = false } = {}) {
  if (ended) return;
  // A sticky card is the user's to retire, and that has to hold against being overwritten as
  // well as against being cleared: the version-skew warning is the only thing telling this page
  // it is running the pre-upgrade client, and a later ordinary load failure must not replace it.
  if (layoutGateFailureActive && layoutGateFailureSticky && !sticky) return;
  layoutGateFailureActive = true;
  layoutGateFailureSticky = sticky;
  layoutGateCycle += 1;
  // Failure copy must not disable the visual gate's own recovery paths. Keep a fresh hold timer
  // over the card so a server replacement or any other failure cannot strand the artifact behind
  // a sticky message forever.
  if (layoutGateTitle) layoutGateTitle.textContent = title;
  if (layoutGateCopy) layoutGateCopy.textContent = copy;
  if (layoutGateAction) {
    layoutGateAction.disabled = false;
    layoutGateAction.textContent = actionLabel;
    layoutGateAction.onclick = onAction || (() => location.reload());
  }
  if (layoutGateBypass) {
    layoutGateBypass.hidden = false;
    layoutGateBypass.onclick = () => forceRevealLayoutGate("manual");
  }
  setLayoutGateActive(true);
  armLayoutGateTimer();
}

// Every failure card in this feature is raised in a state where the server may not be listening,
// so none of them may navigate on trust: a reload into a dead port replaces a recoverable page
// with the browser's own connection-error page. Ask first, and say so when nothing answers.
// Title and body are written together: a probe that timed out establishes neither that the server
// is running nor that it is gone, so a heading naming a definite cause may not stand over a line
// saying the cause is unknown.
function checkServerThenReload(failureTitle, stillDownCopy) {
  let checking = false;
  return async () => {
    if (checking) return;
    checking = true;
    if (layoutGateAction) layoutGateAction.disabled = true;
    // The card this click was made on. A probe can take until HEALTH_PROBE_TIMEOUT_MS, and the
    // overlay may have moved on to a different card - or back to the checking gate - by then; its
    // copy is not this probe's to overwrite.
    const cycle = layoutGateCycle;
    let outcome = "not-running";
    let navigating = false;
    try {
      outcome = await probeChromeHealth();
      if (outcome === "running") {
        navigating = true;
        await flushWhiteboardsBeforeChromeReload();
        location.reload();
      }
    } finally {
      // Every path that does not navigate hands the control back, including a probe that timed
      // out or threw: a button that stays disabled is worse than the reload it was guarding.
      if (!navigating) {
        checking = false;
        if (layoutGateAction) layoutGateAction.disabled = false;
        if (cycle === layoutGateCycle) {
          const answered = outcome !== "no-answer";
          if (layoutGateTitle) layoutGateTitle.textContent = answered ? failureTitle : HEALTH_NO_ANSWER_TITLE;
          if (layoutGateCopy) layoutGateCopy.textContent = answered ? stillDownCopy : HEALTH_NO_ANSWER_COPY;
        }
      }
    }
  };
}

// A load attempt that gets going again retires the failure card. This runs even when the gate is
// disabled or the user already bypassed it, because otherwise the card would keep covering an
// artifact that has since loaded.
function clearLayoutGateFailure() {
  if (!layoutGateFailureActive || layoutGateFailureSticky) return;
  layoutGateFailureActive = false;
  if (layoutGateAction) {
    layoutGateAction.textContent = "Show anyway";
    layoutGateAction.onclick = () => forceRevealLayoutGate("manual");
  }
  if (layoutGateBypass) layoutGateBypass.hidden = true;
  revealLayoutGate();
}

function revealLayoutGate() {
  clearLayoutGateTimer();
  layoutGateEscape?.reveal?.();
  setLayoutGateActive(false);
}

function forceRevealLayoutGate(reason) {
  if (ended) return;
  if (reason === "manual") {
    layoutGateManuallyBypassed = true;
    layoutGateEscape?.manualReveal?.();
  }
  revealLayoutGate();
}

function armLayoutGateTimer() {
  clearLayoutGateTimer();
  if (layoutGateEscape?.arm) {
    layoutGateEscape.arm(layoutGateMaxHoldMs, () => forceRevealLayoutGate("timeout"));
    return;
  }
  const cycle = layoutGateCycle;
  layoutGateTimer = setTimeout(() => {
    if (cycle !== layoutGateCycle || !layoutGateVisible || ended) return;
    forceRevealLayoutGate("timeout");
  }, layoutGateMaxHoldMs);
  layoutGateTimer?.unref?.();
}

function startLayoutGateCycle() {
  clearLayoutGateFailure();
  if (!layoutGateEnabled || layoutGateManuallyBypassed || ended) return;

  layoutGateCycle += 1;
  setLayoutGateActive(true);
  // A sticky failure owns the card copy, but never the reveal. Do not repaint it as a checking
  // card, and do arm a fresh timer for reloads that happen while the sticky card is present.
  if (!layoutGateFailureSticky) setLayoutGateCard("checking");
  armLayoutGateTimer();
}

// The gate only waits for fonts and final geometry now. It never holds the artifact hostage
// pending an agent repair: findings are the user's to triage, so a completed pass always reveals
// and hands the result to the passive inbox.
function handleLayoutGatePass() {
  if (ended || !layoutGateVisible) return;
  revealLayoutGate();
}

function initializeLayoutGate() {
  if (layoutGateEscape?.isManuallyBypassed?.()) layoutGateManuallyBypassed = true;
  if (!layoutGateEnabled) {
    setLayoutGateActive(false);
    return;
  }

  if (layoutGateAction) layoutGateAction.onclick = () => forceRevealLayoutGate("manual");
  if (layoutGateBypass) layoutGateBypass.onclick = () => forceRevealLayoutGate("manual");
  startLayoutGateCycle();
}

// ---------------------------------------------------------------------------
// Passive layout-warning inbox
// ---------------------------------------------------------------------------

async function submitLayoutDiagnostics(pass) {
  const response = await fetch("/api/" + key + "/layout-diagnostics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      complete: pass?.complete !== false,
      target_presence_complete: pass?.targetPresenceComplete === true,
      artifact_revision: Number(pass?.artifactRevision) || 0,
      artifact_load_token: String(pass?.artifactLoadToken || artifactLoadToken),
      artifact_pass_sequence: Number(pass?.artifactPassSequence) || 0,
      viewport_width: Number(pass?.viewportWidth) || 0,
      findings: normalizeLayoutFindings(pass?.findings),
    }),
  });
  if (!response.ok) throw new Error("failed to submit layout diagnostics");
  return response.json();
}

async function reportArtifactFailures(failures, loadToken = artifactLoadToken) {
  if (loadToken !== artifactLoadToken) return;
  await fetch("/api/" + key + "/artifact-failures", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ failures, artifact_load_token: loadToken, artifact_revision: artifactLoadRevision }),
  });
}

// The narrow fatal probe. A healthy artifact boots its SDK and starts talking within seconds; if
// nothing ever arrives we ask the server whether the document is servable at all. Probing only on
// silence keeps the normal path to a single artifact request, and a non-OK answer is the one
// signal that separates "the review is unusable" from "the review has layout problems".
function armArtifactAvailabilityProbe(loadToken = artifactLoadToken) {
  clearTimeout(artifactSilenceTimer);
  artifactSilenceTimer = setTimeout(() => {
    if (loadToken !== artifactLoadToken) return;
    probeArtifactAvailability(loadToken).catch(() => {});
  }, ARTIFACT_SILENCE_PROBE_MS);
  artifactSilenceTimer?.unref?.();
}

function artifactProbeSrc() {
  const separator = artifactSrc.includes("?") ? "&" : "?";
  return (
    artifactSrc +
    separator +
    "probe=1&artifact_revision=" +
    encodeURIComponent(artifactLoadRevision) +
    "&artifact_load_token=" +
    encodeURIComponent(artifactLoadToken)
  );
}

async function probeArtifactAvailability(loadToken) {
  if (loadToken !== artifactLoadToken) return;
  try {
    const response = await fetch(artifactProbeSrc(), { cache: "no-store" });
    if (loadToken !== artifactLoadToken) return;
    if (response.status === 409) return;
    if (response.ok) return;
    await reportArtifactFailures(
      [{ kind: "artifact-unavailable", detail: "the artifact document responded with HTTP " + response.status }],
      loadToken,
    );
  } catch {
    // A transient fetch failure is uncertainty, not proof - stay silent.
  }
}

function activeWarnings() {
  return layoutWarnings.filter((warning) => warning && warning.active);
}

function pendingLayoutWarningIds() {
  const ids = new Set();
  for (const prompt of queued) {
    if (prompt?.tag !== "layout-warnings" || prompt.target?.type !== "layout-warnings") continue;
    for (const warning of Array.isArray(prompt.target.warnings) ? prompt.target.warnings : []) {
      if (warning?.id) ids.add(String(warning.id));
    }
  }
  return ids;
}

function setLayoutWarnings(next) {
  layoutWarnings = Array.isArray(next) ? next : [];
  // Selections only ever reference warnings the user may still act on.
  const pending = pendingLayoutWarningIds();
  const selectable = new Set(
    layoutWarnings.filter((warning) => warning.selectable && !pending.has(warning.id)).map((warning) => warning.id),
  );
  for (const id of [...selectedWarningIds]) {
    if (!selectable.has(id)) selectedWarningIds.delete(id);
  }
  persistWarningSelection();
  renderWarnings();
}

function persistWarningSelection() {
  saveJsonState(warningSelectionStorageKey, [...selectedWarningIds]);
}

function warningRelativeTime(value) {
  const at = Date.parse(String(value || ""));
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.round(hours / 24) + "d ago";
}

function createWarningChip(text, extraClass) {
  const chip = document.createElement("span");
  chip.className = "warning-chip" + (extraClass ? " " + extraClass : "");
  chip.textContent = text;
  return chip;
}

function createWarningRow(warning) {
  const row = document.createElement("div");
  row.className = "warning-row" + (warning.outstanding ? " is-outstanding" : "");
  row.dataset.warningId = warning.id;
  const pending = pendingLayoutWarningIds().has(warning.id);
  const selectable = warning.selectable && !pending;
  const unavailableLabel = pending ? "is queued to send" : "is already queued for a fix";
  const statusLabel = pending ? "Queued for send" : warning.status_label;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "warning-select";
  checkbox.checked = selectable && selectedWarningIds.has(warning.id);
  checkbox.disabled = !selectable;
  checkbox.setAttribute(
    "aria-label",
    selectable
      ? "Select " + warning.title + " on " + warning.viewport_label
      : warning.title + " on " + warning.viewport_label + " " + unavailableLabel,
  );
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selectedWarningIds.add(warning.id);
    else selectedWarningIds.delete(warning.id);
    persistWarningSelection();
    updateWarningSelectionState();
  });
  row.appendChild(checkbox);

  const body = document.createElement("div");
  body.className = "warning-body";

  const title = document.createElement("div");
  title.className = "warning-title";
  title.textContent = warning.title;
  body.appendChild(title);

  const explanation = document.createElement("p");
  explanation.className = "warning-explanation";
  explanation.textContent = warning.explanation;
  body.appendChild(explanation);

  const meta = document.createElement("div");
  meta.className = "warning-meta";
  meta.appendChild(createWarningChip("Severe", "severity"));
  meta.appendChild(createWarningChip(statusLabel, "status-" + warning.status));
  meta.appendChild(createWarningChip(warning.viewport_label + " · " + warning.viewport_width + "px"));
  const seen = warningRelativeTime(warning.last_seen_at);
  if (seen) meta.appendChild(createWarningChip("Seen " + seen));
  body.appendChild(meta);

  const target = document.createElement("code");
  target.className = "warning-target";
  target.textContent = warning.selector || "(whole page)";
  body.appendChild(target);

  const actions = document.createElement("div");
  actions.className = "warning-actions";
  if (warning.selector) {
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "warning-action";
    reveal.textContent = "Reveal";
    reveal.setAttribute("aria-label", "Reveal " + warning.title + " in the artifact");
    reveal.addEventListener("click", () => revealWarning(warning));
    actions.appendChild(reveal);
  }
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "warning-action";
  dismiss.textContent = "Dismiss";
  dismiss.disabled = !selectable;
  dismiss.setAttribute(
    "aria-label",
    selectable
      ? "Dismiss " + warning.title + " for this artifact revision"
      : warning.title + " cannot be dismissed while " + (pending ? "queued to send" : "a fix is queued"),
  );
  dismiss.addEventListener("click", () => dismissWarning(warning.id));
  actions.appendChild(dismiss);
  body.appendChild(actions);

  row.appendChild(body);
  return row;
}

function renderWarnings() {
  if (!warningsWrap) return;
  const pending = pendingLayoutWarningIds();
  let selectionChanged = false;
  for (const id of [...selectedWarningIds]) {
    if (pending.has(id)) {
      selectedWarningIds.delete(id);
      selectionChanged = true;
    }
  }
  if (selectionChanged) persistWarningSelection();
  const active = activeWarnings();
  const count = active.length;

  warningsWrap.hidden = count === 0 || ended;
  if (warningsWrap.hidden && warningsDrawerOpen) setWarningsDrawerOpen(false);
  setCount(warningsCount, count);
  warningsButton.setAttribute(
    "aria-label",
    count === 1 ? "1 unresolved layout issue" : count + " unresolved layout issues",
  );

  const outstanding = active.filter((warning) => warning.outstanding).length;
  warningsSummary.textContent =
    (count === 1 ? "1 unresolved issue" : count + " unresolved issues") +
    (outstanding > 0 ? " · " + outstanding + " already queued for a fix" : "");

  warningsList.replaceChildren();
  if (count === 0) {
    const empty = document.createElement("p");
    empty.className = "warnings-empty";
    empty.textContent = "No unresolved layout issues.";
    warningsList.appendChild(empty);
  } else {
    for (const warning of active) warningsList.appendChild(createWarningRow(warning));
  }
  updateWarningSelectionState();
}

function updateWarningSelectionState() {
  const pending = pendingLayoutWarningIds();
  const selectable = activeWarnings().filter((warning) => warning.selectable && !pending.has(warning.id));
  const selectedCount = selectable.filter((warning) => selectedWarningIds.has(warning.id)).length;
  warningsSelectAll.disabled = selectable.length === 0;
  // Default selection is never "everything": Select all is an explicit action.
  warningsSelectAll.checked = selectable.length > 0 && selectedCount === selectable.length;
  warningsSelectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
  warningsSelected.textContent = selectedCount === 0 ? "None selected" : selectedCount + " selected";
  warningsQueueButton.disabled = selectedCount === 0 || ended || terminalSubmission !== null;
}

function toggleSelectAllWarnings() {
  const pending = pendingLayoutWarningIds();
  const selectable = activeWarnings().filter((warning) => warning.selectable && !pending.has(warning.id));
  const shouldSelect = warningsSelectAll.checked;
  for (const warning of selectable) {
    if (shouldSelect) selectedWarningIds.add(warning.id);
    else selectedWarningIds.delete(warning.id);
  }
  persistWarningSelection();
  renderWarnings();
}

function setWarningsDrawerOpen(open) {
  warningsDrawerOpen = open && !ended;
  setLayerOpen(warningsDrawer, warningsDrawerOpen);
  warningsButton.setAttribute("aria-expanded", String(warningsDrawerOpen));
  if (warningsDrawerOpen) {
    closeMenus();
    warningsSelectAll.focus();
  }
}

function toggleWarningsDrawer() {
  setWarningsDrawerOpen(warningsDrawer.hidden);
}

function closeWarningsDrawer({ restoreFocus = false } = {}) {
  if (!warningsDrawerOpen) return;
  setWarningsDrawerOpen(false);
  if (restoreFocus) warningsButton.focus();
}

function revealWarning(warning) {
  postToFrame({ type: "lavish:revealElement", selector: warning.selector });
}

// ---------------------------------------------------------------------------
// Revision legend
//
// The agent declares what it changed in the artifact HTML itself (a
// `data-lavish-revisions` registry plus `data-lavish-revision` marks); the SDK
// reads it and posts it here. The legend lives entirely in the chrome, so the
// served artifact still matches the file on disk - Lavish never paints the
// change indicator into the page. Reveal borrows the same transient marker the
// layout-issues drawer uses, and only when the reader asks for it.

// The payload crosses postMessage from a sandboxed frame rendering author
// content, so it is untrusted here whatever built it. These bound what is
// examined, not what is accepted: capping accepted rows alone would let a
// registry of ten thousand records walk the whole array on the chrome's main
// thread before yielding its handful of rows.
// Server-owned, injected into the session JSON from src/artifact-revisions.js.
// The swatch is presentation the chrome owes the reader, not something the
// artifact gets a say in, so nothing about it is read from the message.
const REVISION_PALETTE = (Array.isArray(sessionData.revisionPalette) ? sessionData.revisionPalette : []).filter(
  (entry) => entry && /^#[0-9a-fA-F]{6}$/.test(String(entry.hex)),
);
const REVISION_LIMITS = {
  // Derived from the server-injected palette (src/artifact-revisions.js) rather than a
  // second hardcoded number, so the two can never drift; falls back to 6 only if the
  // palette itself came through empty.
  entries: REVISION_PALETTE.length > 0 ? REVISION_PALETTE.length : 6,
  rawEntries: 256,
  marks: 200,
  rawMarks: 2000,
  id: 60,
  label: 80,
  summary: 400,
  timestamp: 40,
  excerpt: 120,
  selector: 400,
};
const REVISION_BORDER_STYLES = ["solid", "dashed", "dotted", "double"];

/** @type {any[]} */
let revisionEntries = [];
/** @type {any[]} */
let revisionMarks = [];
/** @type {Map<string, number>} */
const revisionRevealCursor = new Map();
let revisionsDrawerOpen = false;

// Display-only fields. Anything the legend merely shows can be shortened.
function revisionText(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

// Identity fields, mirroring `exactRevisionText` in src/artifact-revisions.js.
// The message is untrusted here, so shortening an id or a selector is worse
// than dropping it: two distinct overlong ids collapse into one legend row, and
// the first 400 characters of a long selector are a different valid selector
// that Reveal would resolve to some other block.
function revisionExact(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  return text.length > 0 && text.length <= max ? text : "";
}

function revisionPatternFill(pattern) {
  if (pattern === "diagonal") return "repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 5px)";
  if (pattern === "dots") return "radial-gradient(currentColor 1px, transparent 1px)";
  return "";
}

// The swatch for a revision's position in the registry. Position is the only
// thing the artifact influences, and it cannot repeat one: ids are deduplicated
// before this runs, so each accepted revision gets a distinct index and
// therefore a distinct swatch.
function revisionPresentation(index) {
  const entry = REVISION_PALETTE.length > 0 ? REVISION_PALETTE[index % REVISION_PALETTE.length] : null;
  return {
    color: entry ? String(entry.hex) : "#0072b2",
    borderStyle: REVISION_BORDER_STYLES.includes(String(entry && entry.borderStyle))
      ? String(entry.borderStyle)
      : "solid",
    pattern: revisionPatternFill(entry && entry.pattern),
  };
}

// Only text crosses from the artifact into the legend, and it crosses as
// textContent. Nothing the message carries reaches a style property.
function normalizeRevisionMessage(msg) {
  const rawRevisions = Array.isArray(msg && msg.revisions) ? msg.revisions : [];
  const revisions = [];
  const byId = new Map();
  let examined = 0;
  for (const raw of rawRevisions) {
    if (examined >= REVISION_LIMITS.rawEntries || revisions.length >= REVISION_LIMITS.entries) break;
    examined += 1;
    if (!raw || typeof raw !== "object") continue;
    const id = revisionExact(raw.id, REVISION_LIMITS.id);
    if (!id || /\s/.test(id) || byId.has(id)) continue;
    const entry = {
      id,
      label: revisionText(raw.label, REVISION_LIMITS.label) || id,
      timestamp: revisionText(raw.timestamp, REVISION_LIMITS.timestamp),
      summary: revisionText(raw.summary, REVISION_LIMITS.summary),
      ...revisionPresentation(revisions.length),
      marks: [],
    };
    byId.set(id, entry);
    revisions.push(entry);
  }

  const rawMarks = Array.isArray(msg && msg.marks) ? msg.marks : [];
  const marks = [];
  examined = 0;
  for (const raw of rawMarks) {
    if (examined >= REVISION_LIMITS.rawMarks || marks.length >= REVISION_LIMITS.marks) break;
    examined += 1;
    if (!raw || typeof raw !== "object") continue;
    const revisionId = revisionExact(raw.revision_id, REVISION_LIMITS.id);
    const selector = revisionExact(raw.selector, REVISION_LIMITS.selector);
    const owner = byId.get(revisionId);
    if (!owner || !selector) continue;
    const mark = {
      revisionId,
      selector,
      tag: revisionText(raw.tag, 40).toLowerCase(),
      excerpt: revisionText(raw.excerpt, REVISION_LIMITS.excerpt),
    };
    owner.marks.push(mark);
    marks.push(mark);
  }

  return { revisions, marks };
}

function resetRevisionLegend() {
  revisionEntries = [];
  revisionMarks = [];
  revisionRevealCursor.clear();
  // The new frame starts without outlines, so the chrome forgets the old choice rather than
  // re-sending it into a document that never declared that round.
  outlinedRevisionId = "";
  renderRevisionLegend();
}

// Outline what changed: one round at a time, every block marked with it gets a dashed outline and
// its id. The SDK draws them over the page from its own read of the marks.
let outlinedRevisionId = "";
function setOutlinedRevision(id) {
  outlinedRevisionId = id;
  postToFrame({ type: "lavish:outlineRevision", revision_id: id });
  renderRevisionLegend();
}

function applyRevisionMessage(msg) {
  const normalized = normalizeRevisionMessage(msg);
  revisionEntries = normalized.revisions;
  revisionMarks = normalized.marks;
  for (const id of [...revisionRevealCursor.keys()]) {
    if (!revisionEntries.some((entry) => entry.id === id)) revisionRevealCursor.delete(id);
  }
  if (outlinedRevisionId && !revisionEntries.some((entry) => entry.id === outlinedRevisionId)) {
    setOutlinedRevision("");
    return;
  }
  renderRevisionLegend();
}

function revisionMarkSummary(entry) {
  if (entry.marks.length === 0) return "no marked blocks";
  return entry.marks.length === 1 ? "1 marked block" : entry.marks.length + " marked blocks";
}

function buildRevisionRow(entry) {
  const row = document.createElement("div");
  row.className = "revision-row";

  const swatch = document.createElement("span");
  swatch.className = "revision-swatch";
  swatch.setAttribute("aria-hidden", "true");
  swatch.style.color = entry.color;
  swatch.style.borderColor = entry.color;
  swatch.style.borderStyle = entry.borderStyle;
  if (entry.pattern) swatch.style.backgroundImage = entry.pattern;
  row.appendChild(swatch);

  const body = document.createElement("div");
  body.className = "revision-body";

  const head = document.createElement("div");
  head.className = "revision-head";
  const label = document.createElement("span");
  label.className = "revision-label";
  label.textContent = entry.label;
  head.appendChild(label);
  if (entry.timestamp) {
    const time = document.createElement("span");
    time.className = "revision-time";
    time.textContent = entry.timestamp;
    head.appendChild(time);
  }
  body.appendChild(head);

  if (entry.summary) {
    const summary = document.createElement("p");
    summary.className = "revision-summary";
    summary.textContent = entry.summary;
    body.appendChild(summary);
  }

  const foot = document.createElement("div");
  foot.className = "revision-foot";
  const count = document.createElement("span");
  count.className = "revision-marks";
  count.textContent = revisionMarkSummary(entry);
  foot.appendChild(count);
  if (entry.marks.length > 0) {
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "revision-reveal";
    const position = (revisionRevealCursor.get(entry.id) || 0) % entry.marks.length;
    reveal.textContent = entry.marks.length === 1 ? "Reveal" : "Reveal " + (position + 1) + "/" + entry.marks.length;
    reveal.setAttribute("aria-label", "Reveal the next block changed in " + entry.label);
    // Bound per row rather than delegated from the list: the rows are rebuilt
    // on every render anyway, so there is no listener to accumulate, and the
    // button carries the revision it belongs to without a data attribute round
    // trip through the DOM.
    reveal.onclick = () => revealNextRevisionMark(entry.id);
    foot.appendChild(reveal);
    const outline = document.createElement("button");
    outline.type = "button";
    outline.className = "revision-outline";
    outline.textContent = "Outline";
    outline.setAttribute("aria-pressed", String(outlinedRevisionId === entry.id));
    outline.setAttribute("aria-label", "Outline every block changed in " + entry.label);
    outline.onclick = () => setOutlinedRevision(outlinedRevisionId === entry.id ? "" : entry.id);
    foot.appendChild(outline);
  }
  body.appendChild(foot);

  row.appendChild(body);
  return row;
}

function renderRevisionLegend() {
  if (!revisionsWrap) return;
  syncReplyRevisionButtons();
  const count = revisionEntries.length;
  revisionsWrap.hidden = count === 0 || ended;
  if (revisionsWrap.hidden && revisionsDrawerOpen) setRevisionsDrawerOpen(false);
  setCount(revisionsCount, count);
  // The prototype labels the button with the newest round, the one a reviewer is checking.
  revisionsLatest.textContent = count ? revisionEntries[count - 1].id : "Revisions";
  revisionsButton.setAttribute("aria-label", count === 1 ? "1 revision" : count + " revisions");
  revisionsSummary.textContent =
    (count === 1 ? "1 revision" : count + " revisions") +
    " · " +
    (revisionMarks.length === 1 ? "1 marked block" : revisionMarks.length + " marked blocks");

  revisionsList.replaceChildren(...revisionEntries.map(buildRevisionRow));
}

function setRevisionsDrawerOpen(open) {
  revisionsDrawerOpen = open && !ended;
  setLayerOpen(revisionsDrawer, revisionsDrawerOpen);
  revisionsButton.setAttribute("aria-expanded", String(revisionsDrawerOpen));
  if (revisionsDrawerOpen) closeMenus();
}

function closeRevisionsDrawer({ restoreFocus = false } = {}) {
  if (!revisionsDrawerOpen) return;
  setRevisionsDrawerOpen(false);
  if (restoreFocus) revisionsButton.focus();
}

// Step through a revision's marked blocks one at a time. The existing reveal
// path flashes one element and clears the previous marker, so a revision that
// touched several blocks is walked rather than lit up all at once.
function revealNextRevisionMark(id) {
  const entry = revisionEntries.find((candidate) => candidate.id === id);
  if (!entry || entry.marks.length === 0) return;
  const position = (revisionRevealCursor.get(id) || 0) % entry.marks.length;
  postToFrame({ type: "lavish:revealElement", selector: entry.marks[position].selector });
  revisionRevealCursor.set(id, (position + 1) % entry.marks.length);
  renderRevisionLegend();
}

async function dismissWarning(id) {
  try {
    const response = await fetch("/api/" + key + "/layout-warnings/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) throw new Error("failed to dismiss layout warning");
    const data = await response.json();
    if (Array.isArray(data.warnings)) setLayoutWarnings(data.warnings);
  } catch {
    // Leave the warning in place - a failed dismissal must never look like a resolution.
  }
}

// One queued batch = one ordinary queued prompt. The CLI cannot tell it apart from any other
// feedback, which is exactly the point: no parallel agent protocol.
async function queueSelectedWarningFixes() {
  const preparation = beginFeedbackPreparation();
  if (!preparation) return;
  const ids = [...selectedWarningIds];
  if (ids.length === 0) {
    preparation.finish(true);
    return;
  }
  warningsQueueButton.disabled = true;
  let succeeded = false;
  try {
    const response = await fetch("/api/" + key + "/layout-warnings/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) throw new Error("failed to queue layout warning fixes");
    const data = await response.json();
    if (data.prompt) {
      if (
        !enqueuePrompt(
          {
            uid: "",
            prompt: data.prompt.prompt,
            selector: "",
            tag: "layout-warnings",
            text: data.prompt.text,
            target: data.prompt.target,
          },
          preparation,
        )
      )
        throw new Error("failed to retain layout warning fixes");
    }
    selectedWarningIds.clear();
    persistWarningSelection();
    if (Array.isArray(data.warnings)) setLayoutWarnings(data.warnings);
    closeWarningsDrawer({ restoreFocus: true });
    clearPreparationFailure("layout-warnings");
    succeeded = true;
  } catch {
    showPersistentSendFailure(
      "Could not prepare the selected layout fixes. Review the current issues and try again.",
      false,
      { kind: "preparation", operation: preparation, preparationType: "layout-warnings" },
    );
    updateWarningSelectionState();
  } finally {
    preparation.finish(succeeded);
  }
}

async function refreshLayoutWarnings() {
  try {
    const response = await fetch("/api/" + key + "/layout-warnings");
    if (!response.ok) return;
    const data = await response.json();
    if (Array.isArray(data.warnings)) setLayoutWarnings(data.warnings);
  } catch {
    // Keep whatever the chrome already has; never clear on a failed refresh.
  }
}

async function endSession(terminal = null) {
  if (ended || (terminalSubmission && terminal !== terminalSubmission)) return;
  const response = await fetch("/api/" + key + "/end", { method: "POST" });
  if (!response.ok) throw new Error("failed to end session");
  markSessionEnded();
}

function markSessionEnded() {
  if (ended) return;
  ended = true;
  renderAgentStatus();
  setSuggestions([]);
  pendingAcknowledgements.clear();
  clearSendAcknowledgementWarning();
  terminalSubmission = null;
  persistTerminalReservation(false);
  cancelArtifactLoadRecovery();
  closeMenus();
  closeShareDialog();
  closeWarningsDrawer();
  renderWarnings();
  closeRevisionsDrawer();
  renderRevisionLegend();
  closeWhiteboard();
  annotationSwitch.disabled = true;
  modeInteractButton.disabled = true;
  railAnnotateButton.disabled = true;
  moreButton.disabled = true;
  chatInput.disabled = true;
  updateSendState();
  applySheetState();
  if (presenceBanner) presenceBanner.hidden = true;
  if (handoffBanner) handoffBanner.hidden = true;
  if (outdatedBanner) outdatedBanner.hidden = true;
  layoutGateManuallyBypassed = true;
  layoutGateFailureSticky = false;
  revealLayoutGate();
  layoutGateEscape?.end?.();
  postToFrame({ type: "lavish:setAnnotationMode", enabled: false });
  endedOverlay.hidden = false;
}

function copyFilePath() {
  copyText(filePath);
  copyHint.classList.add("copied");
  copyHintText.textContent = "Copied";
  clearTimeout(copyHintTimer);
  copyHintTimer = setTimeout(() => {
    copyHint.classList.remove("copied");
    copyHintText.textContent = "Copy";
  }, 1600);
}

function copyDomSnapshot() {
  closeMenus();
  requestSnapshot("copy");
}

function exportFileName() {
  const base = (filePath.split(/[\\/]/).pop() || "artifact.html").replace(/\.html?$/i, "");
  return (base || "artifact") + ".export.html";
}

function setExportLabel(text) {
  const label = exportArtifactButton.querySelector("span");
  if (label) label.textContent = text;
}

function unresolvedAssetText(count) {
  return count === 1 ? "1 unresolved asset" : `${count} unresolved assets`;
}

function noticeText(count) {
  return count === 1 ? "1 notice" : `${count} notices`;
}

function exportWarningText(unresolvedCount, noticeCount) {
  if (unresolvedCount > 0 && noticeCount > 0) {
    return `${unresolvedAssetText(unresolvedCount)} and ${noticeText(noticeCount)}`;
  }
  if (unresolvedCount > 0) return unresolvedAssetText(unresolvedCount);
  return noticeText(noticeCount);
}

async function exportArtifact() {
  // The bundle inlines local assets server-side, so it can take a moment - keep the menu open
  // and narrate progress in place instead of closing it and leaving the user with no feedback.
  exportArtifactButton.disabled = true;
  setExportLabel("Exporting...");
  try {
    const response = await fetch("/api/" + key + "/export");
    if (!response.ok) throw new Error("export failed");
    const warningCount = Number(response.headers.get("x-lavish-export-warning-count") || "0");
    const noticeCount = Number(response.headers.get("x-lavish-export-notice-count") || "0");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (warningCount > 0 || noticeCount > 0) {
      setExportLabel(`Exported with ${exportWarningText(warningCount, noticeCount)}`);
    } else {
      setExportLabel("Export standalone HTML");
      closeMenus();
    }
  } catch {
    setExportLabel("Export failed - retry");
  } finally {
    exportArtifactButton.disabled = false;
  }
}

// ONE owner for the whole result panel. Every path that renders an outcome - dialog open, a
// successful publish, a retry after any failure, an indeterminate report, an incomplete 200 -
// routes through here, because a row shown or hidden by one path and reset by another is how a
// retry after a failed publish came to display "Published" with the once-only update_key still
// hidden. Each row is derived from the value it would show, so nothing can be half-rendered.
function renderShareResult({ url = "", siteId = "", password = "", updateKey = "" } = {}) {
  shareUrlInput.value = url;
  shareUrlResult.hidden = !url;
  // A self-hosted backend may not return one, and an empty box with a copy button is worse than
  // no row. Never derive it from the URL: that shape belongs to the backend, not Lavish.
  shareSiteIdInput.value = siteId;
  shareSiteIdResult.hidden = !siteId;
  sharePasswordOutput.value = password;
  sharePasswordResult.hidden = !password;
  shareUpdateKeyInput.value = updateKey;
  shareUpdateKeyResult.hidden = !updateKey;
  // The note's own copy tells the user to republish with `--site <site id> --update-key <key>`,
  // so it may only appear when BOTH halves of that credential are on screen. An update key with
  // no usable site id cannot update anything, and the status line says so instead.
  shareUpdateKeyNote.hidden = !(updateKey && siteId);
  shareResult.hidden = !(url || siteId || password || updateKey);
  // Returned so every sentence in the status line is derived from what was actually rendered.
  // Copy stamped from the request instead has promised rows the panel does not contain.
  return { url, siteId, password, updateKey };
}

// Wording shared with the CLI's next_step for the same condition, so the two surfaces cannot
// drift into describing the same dead end differently.
const NO_SITE_ID_WARNING =
  " The host did not return a site id Lavish can use, and --site is half the republish credential, so this page can NEVER be republished or unpublished even though its update key is in hand.";

// What the page is gated behind, said only in terms of what the panel can show. A password the
// user typed is never echoed by the server, so pointing at a row that was not rendered is the
// same confidently-wrong sentence this feature exists to avoid.
function publishedVisibilityText(isPublic, rendered, publicText) {
  if (isPublic) return publicText;
  return rendered.password ? "behind the password below" : "behind the password you supplied";
}

function openShareDialog() {
  closeMenus();
  setLayerOpen(shareDialog, true, { surface: shareForm });
  shareStatus.textContent = "";
  shareStatus.classList.remove("error");
  renderShareResult();
  shareGenerateInput.checked = false;
  sharePasswordInput.value = "";
  syncSharePasswordInput();
  sharePasswordInput.focus();
}

// A generated password and a typed one are the same field to the server, so the checkbox owns
// the input rather than the two racing to decide what gets published.
function syncSharePasswordInput() {
  const generating = shareGenerateInput.checked;
  sharePasswordInput.disabled = generating;
  sharePasswordInput.placeholder = generating
    ? "Lavish will generate one when you publish"
    : "Leave blank for a public page";
  if (generating) sharePasswordInput.value = "";
}

function closeShareDialog() {
  setLayerOpen(shareDialog, false, { surface: shareForm, closeToken: "--modal-close-dur" });
}

async function copyToButton(value, button, label) {
  await copyText(value);
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = label;
  }, 1200);
}

function reportIndeterminatePublish(data) {
  const rendered = renderShareResult({ password: data.password || "" });
  shareStatus.classList.add("error");
  const reason = data.error ? data.error + " " : "";
  const visibility = publishedVisibilityText(data.public, rendered, "PUBLIC - anyone with the link could read it");
  shareStatus.textContent =
    reason +
    "ht-ml.app may or may not have published this page, so treat the outcome as unknown. If it did publish, the page is live " +
    visibility +
    ", and its URL and update key were lost with the failed response, so it can never be republished or unpublished. Publishing again creates a SECOND page rather than replacing it." +
    (rendered.password ? " Copy the password now - it is shown once here and Lavish does not store it." : "");
}

// An incomplete 200 is NOT an unknown outcome: the host answered, so the page landed. Whatever
// fields did arrive are rendered, because a url with no update_key names a live, public-by-default
// page whose only write credential is gone - and saying "may or may not" there would throw away
// the address Lavish is holding.
function reportIncompletePublish(data) {
  const rendered = renderShareResult({
    url: data.url || "",
    siteId: data.site_id || "",
    password: data.password || "",
    updateKey: data.update_key || "",
  });
  shareStatus.classList.add("error");
  const visibility = publishedVisibilityText(data.public, rendered, "PUBLIC - anyone with the link can read it");
  const updateKeyNote = !rendered.updateKey
    ? "No update key came back, and ht-ml.app issues one only once and has no delete, so this page can never be republished or unpublished. "
    : rendered.siteId
      ? "Copy the update key below - it is issued once. "
      : "Copy the update key below - it is issued once, though" + NO_SITE_ID_WARNING.slice(1) + " ";
  shareStatus.textContent =
    "ht-ml.app accepted this publish, so the page IS live and " +
    visibility +
    ", but its response was malformed and Lavish could not read the whole result back. " +
    (rendered.url ? "Its address is below. " : "The response carried no URL, so Lavish cannot show the address. ") +
    updateKeyNote +
    "Publishing again creates a SECOND page rather than replacing it." +
    (rendered.password ? " Copy the password now - it is shown once here and Lavish does not store it." : "");
}

async function publishShare(event) {
  event.preventDefault();
  sharePublishButton.disabled = true;
  shareStatus.classList.remove("error");
  shareStatus.textContent = "Publishing to ht-ml.app...";
  renderShareResult();
  const generating = shareGenerateInput.checked;
  const password = generating ? "" : sharePasswordInput.value.trim();
  const passwordProtected = generating || Boolean(password);
  try {
    const response = await fetch("/api/" + key + "/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(generating ? { generate_password: true } : password ? { password } : {}),
    });
    const data = await response.json();
    if (!response.ok) {
      // Only a host rejection proves nothing was published. On anything else the page may already
      // be live, and a password minted for this request is the one thing that could still open it,
      // so it is shown here rather than dying with the failed response.
      if (data.outcome === "published-incomplete") {
        reportIncompletePublish(data);
        return;
      }
      if (data.outcome === "indeterminate") {
        reportIndeterminatePublish(data);
        return;
      }
      throw new Error(data.error || "publish failed");
    }
    const rendered = renderShareResult({
      url: data.url || "",
      siteId: data.site_id || "",
      password: data.password || "",
      updateKey: data.update_key || "",
    });
    const unresolvedAssets = Array.isArray(data.unresolved_local_assets) ? data.unresolved_local_assets : [];
    const notices = Array.isArray(data.notices) ? data.notices : [];
    const warningCount = unresolvedAssets.length;
    const noticeCount = notices.length;
    const noticeSummary = noticeCount ? noticeText(noticeCount) : "";
    shareStatus.textContent =
      warningCount > 0
        ? `Published with ${warningCount === 1 ? "1 unresolved local asset" : `${warningCount} unresolved local assets`}${noticeSummary ? ` and ${noticeSummary}` : ""}.${passwordProtected ? " This page is PASSWORD-PROTECTED; viewers also need the password." : ""}`
        : noticeCount > 0
          ? `Published with ${noticeSummary}.${passwordProtected ? " This page is PASSWORD-PROTECTED; viewers also need the password." : ""}`
          : passwordProtected
            ? "Published. This page is PASSWORD-PROTECTED; viewers also need the password."
            : "Published. Anyone with the link can view this page.";
    if (rendered.updateKey && !rendered.siteId) shareStatus.textContent += NO_SITE_ID_WARNING;
    if (rendered.password) {
      shareStatus.textContent += " Copy the password now - it is shown once here and Lavish does not store it.";
    }
    shareUrlInput.focus();
    shareUrlInput.select();
  } catch (error) {
    // Deliberately does NOT clear the panel. It is already cleared before the fetch, so the only
    // thing this could reach is a result the success path already rendered - and wiping that
    // destroys the once-issued update_key of a page that definitely published.
    shareStatus.classList.add("error");
    shareStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    sharePublishButton.disabled = false;
  }
}

function cancelArtifactLoadRecovery() {
  if (artifactLoadRecoveryTimer) clearTimeout(artifactLoadRecoveryTimer);
  artifactLoadRecoveryTimer = undefined;
}

// Retry a begin-load attempt that failed for a recoverable reason. Returns false once the
// backoff is exhausted so the caller can surface the terminal failure. A `superseded` or
// `out-of-order` outcome never lands here: another reviewer or a newer request in this same
// chrome owns the artifact, and retrying would fight it.
function scheduleArtifactLoadRecovery() {
  if (ended) return false;
  const delay = ARTIFACT_LOAD_RECOVERY_DELAYS_MS[artifactLoadRecoveryAttempt];
  if (delay === undefined) return false;
  artifactLoadRecoveryAttempt += 1;
  const sequence = artifactLoadRequestSequence;
  cancelArtifactLoadRecovery();
  artifactLoadRecoveryTimer = setTimeout(() => {
    artifactLoadRecoveryTimer = undefined;
    if (ended || sequence !== artifactLoadRequestSequence) return;
    replaceArtifactFrame({ recoveryRetry: true }).catch(() => {});
  }, delay);
  artifactLoadRecoveryTimer?.unref?.();
  return true;
}

// The backoff budget belongs to the load attempt that started it, not to the page: anything
// asking for a fresh load - a live reload, Reload artifact, a takeover - gets the whole budget
// again, and only the recovery timer's own retries spend it down. A page that carried an
// exhausted counter forward would have no retries left at all for the next outage.
async function replaceArtifactFrame({ recoveryRetry = false } = {}) {
  cancelArtifactLoadRecovery();
  if (!recoveryRetry) artifactLoadRecoveryAttempt = 0;
  clearTimeout(artifactSilenceTimer);
  // The iframe is sandboxed, so reload by resetting the iframe URL from chrome.
  if (!artifactSrc) {
    // The next document reports its own registry once it loads; until then the
    // previous revision's legend would point at blocks that may no longer exist.
    // Only clear it here, right before the frame is actually replaced - a preserved
    // load (superseded/out-of-order/exhausted retries below) must leave it intact.
    resetRevisionLegend();
    setSuggestions([]);
    startLayoutGateCycle();
    const currentSrc = frame.src || "about:blank";
    frame.src = currentSrc + (currentSrc.includes("?") ? "&" : "?") + "lavish_reload=" + Date.now();
    return true;
  }
  const requestSequence = ++artifactLoadRequestSequence;
  const requestId = `lavish-load-${Date.now().toString(36)}-${requestSequence}-${Math.random().toString(36).slice(2)}`;
  const previousToken = artifactLoadToken;
  const preservePreviousLoad = () => {
    if (
      requestSequence === artifactLoadRequestSequence &&
      !ended &&
      previousToken &&
      artifactSpokeToken !== previousToken
    ) {
      armArtifactAvailabilityProbe(previousToken);
    }
    return false;
  };
  // Keep whatever is on screen, then try again later. A begin-load can fail for reasons that
  // clear on their own - the shared server is mid-restart, or a handoff no begin-load had yet
  // persisted was lost with that restart and this chrome's one re-handshake landed in the same
  // outage window. Giving up here is what leaves the review permanently unloaded.
  const recoverLater = () => {
    preservePreviousLoad();
    if (requestSequence !== artifactLoadRequestSequence || ended) return false;
    if (scheduleArtifactLoadRecovery()) return false;
    // Out of retries. Only say so when there is nothing on screen to say it over: a chrome that
    // already shows an artifact keeps showing it rather than losing a usable review.
    if (!artifactLoadToken) {
      setLayoutGateFailure(
        "Lavish could not load this artifact.",
        "The Lavish server did not answer this review's load request. It usually restarted while this page was opening. Check and reload to reconnect.",
        "Check and reload",
        checkServerThenReload(
          "Lavish could not load this artifact.",
          "Lavish is still not answering. Start it again with your agent, then use Check and reload.",
        ),
      );
    }
    return false;
  };
  let load;
  let transportAttempt = 0;
  let handoffRefreshAttempted = false;
  while (true) {
    if (requestSequence !== artifactLoadRequestSequence || ended) return false;
    try {
      const response = await fetch("/api/" + key + "/artifact-loads/begin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: requestId,
          request_sequence: requestSequence,
          chrome_load_token: chromeLoadToken,
        }),
      });
      const candidate = await response.json().catch(() => ({}));
      if (!response.ok) {
        const status = String(candidate?.status || "");
        if (status === "no-handoff") {
          // One re-handshake per attempt keeps a live reviewer from being ping-ponged; the
          // retry that follows is a whole fresh attempt, so the rule still holds.
          if (handoffRefreshAttempted) return recoverLater();
          handoffRefreshAttempted = true;
          try {
            const refreshed = await refreshChromeLoadHandoff(requestSequence);
            if (!refreshed) return false;
          } catch {
            return recoverLater();
          }
          continue;
        }
        if (status === "superseded") {
          setHandoffSuperseded(true);
          // The takeover banner sits in the conversation panel, which the layout gate overlay
          // covers whenever the gate is enabled. A chrome that never loaded the artifact would
          // otherwise show the checking spinner until the gate's max hold expires and then
          // reveal an empty frame, with the only recovery control hidden the whole time. Say it
          // on the overlay instead. Still no background retry: the reload is the user's to make.
          if (!artifactLoadToken) {
            setLayoutGateFailure(
              "This review is already open in another tab.",
              "Lavish loads an artifact in one tab at a time. Take over here to move the review into this tab, or switch back to the tab that already has it.",
              "Take over here",
            );
          }
          return preservePreviousLoad();
        }
        if (status === "out-of-order") return preservePreviousLoad();
        throw new Error("failed to begin artifact load");
      }
      const candidateRevision = Number(candidate?.artifact_revision);
      const candidateToken = String(candidate?.artifact_load_token || "");
      if (!Number.isSafeInteger(candidateRevision) || candidateRevision < 0 || !candidateToken) {
        throw new Error("invalid artifact load");
      }
      load = { artifact_revision: candidateRevision, artifact_load_token: candidateToken };
      break;
    } catch {
      const delay = ARTIFACT_LOAD_BEGIN_RETRY_DELAYS_MS[transportAttempt++];
      if (delay === undefined) return recoverLater();
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
  }
  if (requestSequence !== artifactLoadRequestSequence || ended) return false;
  const revision = Number(load?.artifact_revision);
  const token = String(load?.artifact_load_token || "");
  if (!Number.isSafeInteger(revision) || revision < 0 || !token) return recoverLater();
  artifactLoadRecoveryAttempt = 0;
  artifactLoadRevision = revision;
  artifactLoadToken = token;
  artifactSpokeToken = "";
  inlineWhiteboardChannels.clear();
  setHandoffSuperseded(false);
  startLayoutGateCycle();
  // The next document reports its own registry once it loads; until then the
  // previous revision's legend would point at blocks that may no longer exist.
  resetRevisionLegend();
  setSuggestions([]);
  frame.src = artifactFrameSrcForLoad({ revision, token });
  return true;
}

function resetFrame() {
  if (artifactResetPromise) return artifactResetPromise;
  const hasLiveInlineWhiteboard = [...inlineWhiteboardChannels].some(
    ([index, channel]) => channel.initialized && index !== overlayIndex,
  );
  if (!hasLiveInlineWhiteboard) {
    return replaceArtifactFrame();
  }
  artifactResetPromise = flushInlineWhiteboards()
    .then((flushed) => {
      if (!flushed) return false;
      return replaceArtifactFrame();
    })
    .finally(() => {
      artifactResetPromise = null;
    });
  return artifactResetPromise;
}

// ---------------------------------------------------------------------------
// Whiteboards. The artifact SDK embeds one sandboxed whiteboard frame in place
// of each rendered Mermaid diagram. The chrome owns every server round trip
// and serves all frames concurrently. The overlay hosts the same frame page
// fullscreen when an inline frame asks to maximize - the inline frame is
// suspended while the overlay owns that diagram so two editors never autosave
// one sidecar.
// ---------------------------------------------------------------------------

/** @type {Map<number, { diagramId: string, source: string, sourceHash: string }>} */
const whiteboards = new Map();
/** @type {number | null} */
let overlayIndex = null;
let overlayFrameReady = false;
let overlayChannelId = "";
let overlayOpeningIndex = null;
let nextWhiteboardFlushId = 0;
let artifactResetPromise = null;
let chromeRestartReloadPromise = null;
const whiteboardTeardowns = new Map();
const whiteboardFlushes = new Map();
const whiteboardSaveChains = new Map();
const inlineWhiteboardChannels = new Map();

function whiteboardTheme() {
  return effectiveTheme();
}

function postToWhiteboardOverlay(message) {
  if (whiteboardFrame.contentWindow && overlayChannelId) {
    whiteboardFrame.contentWindow.postMessage({ ...message, channelId: overlayChannelId }, "*");
  }
}

function postToInlineWhiteboard(index, message) {
  const channel = inlineWhiteboardChannels.get(index);
  if (channel?.window) channel.window.postMessage({ ...message, channelId: channel.channelId }, "*");
}

function postToWhiteboard(index, placement, message) {
  if (placement === "overlay") postToWhiteboardOverlay(message);
  else postToInlineWhiteboard(index, message);
}

async function fetchMermaidSources() {
  const response = await fetch("/api/" + key + "/mermaid-sources");
  if (!response.ok) throw new Error("could not read the artifact's Mermaid sources");
  const data = await response.json();
  return Array.isArray(data.sources) ? data.sources : [];
}

async function authenticateWhiteboardChannel(token) {
  const response = await fetch("/api/" + key + "/whiteboard-channel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return response.ok;
}

function showWhiteboardError(text) {
  whiteboardError.textContent = text;
  whiteboardError.hidden = false;
  whiteboardOverlay.hidden = false;
}

function whiteboardRecord(index) {
  let record = whiteboards.get(index);
  if (!record) {
    record = { diagramId: "", source: "", sourceHash: "" };
    whiteboards.set(index, record);
  }
  return record;
}

async function handleWhiteboardReady(index, mode, isCurrent) {
  try {
    const sources = await fetchMermaidSources();
    const source = sources.find((item) => item.index === index);
    if (!source) throw new Error("this diagram's Mermaid source was not found in the artifact file");
    const savedResponse = await fetch("/api/" + key + "/whiteboard/" + index);
    const saved = savedResponse.ok ? (await savedResponse.json()).whiteboard : null;
    const record = whiteboardRecord(index);
    record.source = String(source.source || "");
    record.sourceHash = String(source.hash || "");
    if (!isCurrent()) return false;
    postToWhiteboard(index, mode, {
      type: "lavish-whiteboard:init",
      mode,
      diagramIndex: index,
      diagramId: record.diagramId,
      source: record.source,
      sourceHash: record.sourceHash,
      saved,
      theme: whiteboardTheme(),
    });
    return true;
  } catch (error) {
    if (mode === "overlay") {
      showWhiteboardError("Could not open the whiteboard: " + (error instanceof Error ? error.message : String(error)));
    }
    return false;
  }
}

function showWhiteboardOverlay(index) {
  if (ended) return;
  overlayIndex = index;
  overlayFrameReady = false;
  overlayChannelId = "";
  inlineWhiteboardChannels.delete(index);
  whiteboardError.hidden = true;
  whiteboardOverlay.hidden = false;
  postToFrame({ type: "lavish:suspendWhiteboard", diagramIndex: index });
  // A fresh document per open: the frame boots, posts ready, and receives its
  // init - no stale editor state can leak between opens.
  whiteboardFrame.src =
    "/whiteboard-frame?diagramIndex=" + encodeURIComponent(String(index)) + "&key=" + encodeURIComponent(key);
}

function finishWhiteboardClose(index) {
  whiteboardOverlay.hidden = true;
  whiteboardError.hidden = true;
  whiteboardFrame.src = "about:blank";
  overlayIndex = null;
  overlayFrameReady = false;
  overlayChannelId = "";
  inlineWhiteboardChannels.delete(index);
  if (!ended) postToFrame({ type: "lavish:resumeWhiteboard", diagramIndex: index });
}

function whiteboardTeardownKey(index, placement) {
  return placement + ":" + index;
}

function beginWhiteboardTeardown(index, placement, onComplete) {
  const key = whiteboardTeardownKey(index, placement);
  const pending = whiteboardTeardowns.get(key);
  if (pending) {
    if (onComplete) pending.promise.then(onComplete);
    return pending.promise;
  }
  const flushId = `whiteboard-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  const teardown = { index, placement, flushId, promise, resolve, onComplete };
  whiteboardTeardowns.set(key, teardown);
  const message = { type: "lavish-whiteboard:prepareTeardown", flushId };
  postToWhiteboard(index, placement, message);
  return promise;
}

function finishWhiteboardTeardown(index, message, placement) {
  const flushId = String(message.flushId || "");
  const key = whiteboardTeardownKey(index, placement);
  const teardown = whiteboardTeardowns.get(key);
  if (!teardown || teardown.index !== index || teardown.placement !== placement || teardown.flushId !== flushId) return;
  whiteboardTeardowns.delete(key);
  teardown.onComplete?.(true);
  teardown.resolve(true);
}

function failWhiteboardTeardown(index, message, placement) {
  const flushId = String(message.flushId || "");
  const key = whiteboardTeardownKey(index, placement);
  const teardown = whiteboardTeardowns.get(key);
  if (!teardown || teardown.index !== index || teardown.placement !== placement || teardown.flushId !== flushId) return;
  whiteboardTeardowns.delete(key);
  teardown.onComplete?.(false);
  teardown.resolve(false);
}

function whiteboardFlushKey(index, placement) {
  return placement + ":" + index;
}

function beginWhiteboardFlush(index, placement) {
  const flushKey = whiteboardFlushKey(index, placement);
  const pending = whiteboardFlushes.get(flushKey);
  if (pending) return pending.promise;
  const flushId = `whiteboard-flush-${++nextWhiteboardFlushId}`;
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  whiteboardFlushes.set(flushKey, { index, placement, flushId, promise, resolve });
  postToWhiteboard(index, placement, { type: "lavish-whiteboard:flush", flushId });
  return promise;
}

function finishWhiteboardFlush(index, message, placement) {
  const flushId = String(message.flushId || "");
  const flushKey = whiteboardFlushKey(index, placement);
  const flush = whiteboardFlushes.get(flushKey);
  if (!flush || flush.index !== index || flush.placement !== placement || flush.flushId !== flushId) return;
  whiteboardFlushes.delete(flushKey);
  flush.resolve(Boolean(message.ok));
}

async function flushWhiteboardsBeforeChromeReload() {
  const flushes = [];
  for (const [index, channel] of inlineWhiteboardChannels) {
    if (channel.initialized && index !== overlayIndex) flushes.push(beginWhiteboardFlush(index, "inline"));
  }
  if (overlayIndex !== null && overlayFrameReady) flushes.push(beginWhiteboardFlush(overlayIndex, "overlay"));
  if (flushes.length === 0) return;
  let timeout;
  await Promise.race([
    Promise.all(flushes),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, 1500);
    }),
  ]);
  clearTimeout(timeout);
}

async function flushInlineWhiteboards() {
  for (const [index, channel] of [...inlineWhiteboardChannels]) {
    if (!channel.initialized || index === overlayIndex) continue;
    if (!(await beginWhiteboardTeardown(index, "inline"))) return false;
  }
  return true;
}

function openWhiteboardOverlay(index) {
  if (ended || overlayIndex !== null || overlayOpeningIndex !== null) return;
  overlayOpeningIndex = index;
  beginWhiteboardTeardown(index, "inline", (flushed) => {
    if (overlayOpeningIndex !== index) return;
    overlayOpeningIndex = null;
    if (flushed && !ended && overlayIndex === null) showWhiteboardOverlay(index);
  });
}

function closeWhiteboard() {
  const index = overlayIndex;
  if (index === null) return;
  if (!overlayFrameReady) {
    finishWhiteboardClose(index);
    return;
  }
  beginWhiteboardTeardown(index, "overlay", (flushed) => {
    if (flushed && overlayIndex === index) finishWhiteboardClose(index);
  });
}

async function persistWhiteboardScene(index, message) {
  const response = await fetch("/api/" + key + "/whiteboard/" + index, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source_hash: String(message.sourceHash || ""),
      text_metrics_version: Number(message.textMetricsVersion) || 0,
      scene: message.scene || null,
      baseline: message.baseline || null,
    }),
  });
  if (!response.ok) throw new Error("failed to save whiteboard scene");
}

function saveWhiteboardScene(index, message) {
  const previous = whiteboardSaveChains.get(index) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => persistWhiteboardScene(index, message));
  const tail = result.catch(() => {});
  whiteboardSaveChains.set(index, tail);
  tail.finally(() => {
    if (whiteboardSaveChains.get(index) === tail) whiteboardSaveChains.delete(index);
  });
  return result;
}

function handleWhiteboardSave(index, message, mode) {
  const flushId = String(message.flushId || "");
  saveWhiteboardScene(index, message).then(
    () => {
      if (flushId) postToWhiteboard(index, mode, { type: "lavish-whiteboard:saveResult", flushId, ok: true });
    },
    (error) => {
      if (flushId) {
        postToWhiteboard(index, mode, {
          type: "lavish-whiteboard:saveResult",
          flushId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}

function whiteboardSummaryText(summaryLines) {
  return (Array.isArray(summaryLines) ? summaryLines : [])
    .filter((line) => typeof line === "string")
    .slice(0, 50)
    .map((line) => line.slice(0, 300))
    .join("\n");
}

async function queueWhiteboardFeedback(index, message, mode) {
  const preparation = beginFeedbackPreparation();
  if (!preparation) {
    postToWhiteboard(index, mode, {
      type: "lavish-whiteboard:queueResult",
      ok: false,
      error: "Feedback delivery is already ending this review.",
    });
    return;
  }
  const diagramId = whiteboardRecord(index).diagramId;
  let succeeded = false;
  try {
    // Persist the exact reviewed state before queueing, so the paths in the
    // prompt point at what the user actually saw.
    await saveWhiteboardScene(index, message);
    const response = await fetch("/api/" + key + "/whiteboard/" + index + "/feedback-files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene: message.scene || null, pngDataUrl: String(message.pngDataUrl || "") }),
    });
    if (!response.ok) throw new Error("failed to write whiteboard feedback files");
    const files = await response.json();
    const note = String(message.note || "").slice(0, 4000);
    const summary = whiteboardSummaryText(message.summaryLines);
    const promptText =
      (note ? note + "\n\n" : "") +
      "Whiteboard edits to diagram " +
      (index + 1) +
      (diagramId ? " (" + diagramId + ")" : "") +
      ":\n" +
      (summary || "(no summary)") +
      "\n\nEdited scene JSON: " +
      String(files.scene_path || "") +
      (files.preview_path ? "\nPNG preview: " + String(files.preview_path) : "");
    if (
      !enqueuePrompt(
        {
          uid: "",
          prompt: promptText,
          selector: "",
          tag: "whiteboard",
          text: "Whiteboard: diagram " + (index + 1),
          target: {
            type: "excalidraw-scene",
            diagramIndex: index,
            diagramId,
            sourceHash: String(message.sourceHash || ""),
            scenePath: String(files.scene_path || ""),
            previewPath: String(files.preview_path || ""),
            imageFallback: Boolean(message.imageFallback),
            stats: message.stats && typeof message.stats === "object" ? message.stats : {},
          },
          // Re-queueing the same diagram's whiteboard before sending replaces the
          // earlier unsent prompt instead of stacking duplicates.
          [internalQueueKeyField]: "whiteboard:" + index,
        },
        preparation,
      )
    )
      throw new Error("failed to retain whiteboard feedback");
    // Queued from the whiteboard inside the artifact, like any other in-artifact prompt.
    pulseSheetDock();
    postToWhiteboard(index, mode, { type: "lavish-whiteboard:queueResult", ok: true });
    if (mode === "overlay") closeWhiteboard();
    clearPreparationFailure("whiteboard");
    succeeded = true;
  } catch (error) {
    postToWhiteboard(index, mode, {
      type: "lavish-whiteboard:queueResult",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    preparation.finish(succeeded);
  }
}

// Inline frames live inside the artifact iframe, so a live reload replaces
// them wholesale and they re-init against fresh sources on their own. Only an
// open overlay outlives the reload; tell it when its diagram's source changed
// underneath it so the frame can surface staleness (never silently merge).
async function refreshWhiteboardSource() {
  if (overlayIndex === null) return;
  const index = overlayIndex;
  try {
    const sources = await fetchMermaidSources();
    const source = sources.find((item) => item.index === index);
    const nextHash = source ? String(source.hash || "") : "";
    const record = whiteboardRecord(index);
    if (nextHash !== record.sourceHash) {
      record.source = source ? String(source.source || "") : "";
      record.sourceHash = nextHash;
      postToWhiteboardOverlay({
        type: "lavish-whiteboard:sourceChanged",
        source: record.source,
        sourceHash: record.sourceHash,
      });
    }
  } catch {
    // Best effort - the staleness banner also re-arms on the next open.
  }
}

function validWhiteboardIndex(value) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index <= 999 ? index : null;
}

function handleAuthenticatedWhiteboardMessage(index, message, mode) {
  if (message.type === "lavish-whiteboard:save") handleWhiteboardSave(index, message, mode);
  if (message.type === "lavish-whiteboard:queueFeedback") queueWhiteboardFeedback(index, message, mode);
  if (message.type === "lavish-whiteboard:maximize" && mode === "inline") openWhiteboardOverlay(index);
  if (message.type === "lavish-whiteboard:close" && mode === "overlay") closeWhiteboard();
  if (message.type === "lavish-whiteboard:teardownReady") finishWhiteboardTeardown(index, message, mode);
  if (message.type === "lavish-whiteboard:teardownFailed") failWhiteboardTeardown(index, message, mode);
  if (message.type === "lavish-whiteboard:flushComplete") finishWhiteboardFlush(index, message, mode);
}

// Inline whiteboard frames are created by the SDK inside the artifact document,
// so a genuine one is always a direct child of the *current* artifact window.
// Descent - not the channel token - is what proves the sender is ours: the
// frame page is framable by any origin, so a token is not a secret an attacker
// cannot obtain. Without this, any window that could postMessage to this chrome
// (a page that framed it, or one holding a window.open handle) could open a
// channel and queue a fabricated prompt. Mirrors the artifact-message handler's
// `event.source !== frame.contentWindow` guard.
function isArtifactChildWindow(source) {
  if (!source) return false;
  try {
    // Reading `parent` on a cross-origin WindowProxy is permitted; the frame's
    // sandbox makes everything else about it opaque.
    return source.parent === frame.contentWindow;
  } catch {
    return false;
  }
}

function handleInlineWhiteboardMessage(event, message) {
  if (ended) return;
  if (!isArtifactChildWindow(event.source)) return;
  const index = validWhiteboardIndex(message.diagramIndex);
  if (index === null) return;
  if (message.type === "lavish-whiteboard:ready") {
    if (inlineWhiteboardChannels.has(index)) return;
    const channelId = String(message.channelToken || "");
    if (!channelId) return;
    authenticateWhiteboardChannel(channelId).then((authenticated) => {
      if (!authenticated || ended || inlineWhiteboardChannels.has(index)) return;
      const channel = { window: event.source, channelId, initialized: false };
      inlineWhiteboardChannels.set(index, channel);
      whiteboardRecord(index).diagramId = String(message.diagramId || "");
      handleWhiteboardReady(index, "inline", () => inlineWhiteboardChannels.get(index) === channel).then(
        (initialized) => {
          if (inlineWhiteboardChannels.get(index) === channel) channel.initialized = initialized;
        },
      );
    });
    return;
  }
  const channel = inlineWhiteboardChannels.get(index);
  if (!channel || channel.window !== event.source || channel.channelId !== message.channelId) return;
  handleAuthenticatedWhiteboardMessage(index, message, "inline");
}

function handleOverlayWhiteboardMessage(event, message) {
  if (event.source !== whiteboardFrame.contentWindow || overlayIndex === null) return;
  const index = validWhiteboardIndex(message.diagramIndex);
  if (index === null || index !== overlayIndex) return;
  if (message.type === "lavish-whiteboard:ready") {
    if (overlayFrameReady || overlayChannelId) return;
    const channelId = String(message.channelToken || "");
    if (!channelId) return;
    overlayChannelId = channelId;
    authenticateWhiteboardChannel(channelId).then(async (authenticated) => {
      const isCurrent = () =>
        overlayIndex === index && overlayChannelId === channelId && event.source === whiteboardFrame.contentWindow;
      if (!authenticated) {
        if (isCurrent()) overlayChannelId = "";
        return;
      }
      if (!isCurrent()) return;
      const initialized = await handleWhiteboardReady(index, "overlay", isCurrent);
      if (initialized && isCurrent()) overlayFrameReady = true;
    });
    return;
  }
  if (!overlayFrameReady || message.channelId !== overlayChannelId) return;
  handleAuthenticatedWhiteboardMessage(index, message, "overlay");
}

window.addEventListener("message", (event) => {
  const message = event.data || {};
  if (event.source === whiteboardFrame.contentWindow) {
    handleOverlayWhiteboardMessage(event, message);
  } else if (event.source !== frame.contentWindow) {
    handleInlineWhiteboardMessage(event, message);
  }
});

// Navigate once. The bootstrapped load belongs to whichever page began it, and the begin below
// retires it, so navigating to it first only races that begin: the artifact route re-verifies
// after reading the file, answers the first navigation 409, and Chromium can commit that page in
// place of the second navigation (AB#3233). The bootstrapped load is the fallback for a begin that
// did not navigate, such as a superseded reviewer, and is read here rather than at boot because a
// re-handshake may have replaced it with the current one. A newer request (a live reload that
// landed meanwhile) owns the frame instead, so the fallback stands down for it.
function loadFrame() {
  if (!artifactSrc) return;
  const replacement = replaceArtifactFrame();
  const sequence = artifactLoadRequestSequence;
  replacement
    .then((navigated) => {
      if (navigated || sequence !== artifactLoadRequestSequence) return;
      if (!artifactLoadToken || frame.src) return;
      frame.src = artifactFrameSrcForLoad({ revision: artifactLoadRevision, token: artifactLoadToken });
    })
    .catch(() => {});
}

function reloadArtifact() {
  closeMenus();
  resetFrame().then((reloaded) => {
    if (reloaded) refreshWhiteboardSource();
  });
}

async function reloadAfterServerRestart(reason) {
  if (chromeRestartReloadPromise) return chromeRestartReloadPromise;
  chromeRestartReloadPromise = reloadChromeAfterServerRestart(reason);
  return chromeRestartReloadPromise;
}

// Three outcomes, not two: a port that accepts a connection and then says nothing proves neither
// that the server is running nor that it is gone, and a probe that never settles would leave the
// control the user is holding disabled for as long as the browser's own network timeout takes.
async function probeChromeHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch("/health", { cache: "no-store", signal: controller.signal });
    return res.ok ? "running" : "not-running";
  } catch {
    return controller.signal.aborted ? "no-answer" : "not-running";
  } finally {
    clearTimeout(timer);
  }
}

// The replacement server usually binds within a second, but it is a fresh node process competing
// with whatever else the machine is doing, and several `lavish-axi` invocations can be racing for
// the same port. Reloading on a fixed short deadline regardless of whether anything is listening
// trades a recoverable page for the browser's connection-error page, which no Lavish code can
// recover from. So wait for the port to answer, and if it never does, say so instead.
async function reloadChromeAfterServerRestart(reason = "") {
  let sawOutage = false;
  let healthy = false;
  let settled = false;
  // Keep the pre-outage behavior: a server that never actually went away is reloaded promptly.
  const settleDeadline = Date.now() + CHROME_RESTART_SETTLE_MS;
  const deadline = Date.now() + CHROME_RESTART_WAIT_MS;

  while (Date.now() < deadline) {
    // The bounded probe is what keeps this loop honest: a port that accepts and then says nothing
    // would otherwise hold one iteration open past the deadline, and neither the reload nor the
    // card below would ever happen.
    const outcome = await probeChromeHealth();
    healthy = outcome === "running";
    if (!healthy) sawOutage = true;
    if (healthy && (sawOutage || Date.now() >= settleDeadline)) {
      settled = true;
      break;
    }

    const probeDelay = Date.now() < settleDeadline ? CHROME_RESTART_PROBE_MS : CHROME_RESTART_SLOW_PROBE_MS;
    await new Promise((resolve) => setTimeout(resolve, probeDelay));
  }

  // A loop that ended on the deadline carries whatever the last probe happened to see, and in a
  // hidden tab the browser clamps these timers to seconds or minutes - so a single probe can be
  // the only one that ran. Neither answer may be trusted then: a stale failure claims a running
  // server is gone, and a stale success reloads into a port nothing is listening on.
  if (!settled) healthy = (await probeChromeHealth()) === "running";

  if (!healthy) {
    chromeRestartReloadPromise = null;
    setLayoutGateFailure(
      "Lavish is not running.",
      "The Lavish server restarted and did not come back. Start it again with your agent, then check and reload this page.",
      "Check and reload",
      checkServerThenReload(
        "Lavish is not running.",
        "Lavish is still not running. Start it again with your agent, then use Check and reload.",
      ),
      { sticky: true },
    );
    return;
  }

  // Unsent annotation text is the user's writing. A reload replays it, but it is still their
  // call when to interrupt the card they are typing into, so offer the reload instead of taking
  // it. The same applies to a page the user is only reading: the banner never reloads by itself.
  if (hasUnsentDraft()) {
    chromeRestartReloadPromise = null;
    // The line this page shows comes from the same reason its siblings were sent. An event that
    // named none leaves the branch that claims neither.
    setChromeOutdated(true, reason);
    return;
  }

  await flushWhiteboardsBeforeChromeReload();
  location.reload();
}

// The banner is shown at the moment a server goes away, and in the deliberate-stop case nothing
// is coming to replace it, so this button probes before it navigates for the same reason the
// not-running card does: a reload into a dead port lands on the browser's own error page.
async function reloadChromeForOutdatedBanner() {
  if (outdatedReloadInFlight) return;
  outdatedReloadInFlight = true;
  if (outdatedReloadButton) outdatedReloadButton.disabled = true;
  // The banner this click was made on: a later one carries a newer reason, and that line stands.
  const generation = chromeOutdatedGeneration;
  let outcome = "not-running";
  let navigating = false;
  try {
    outcome = await probeChromeHealth();
    if (outcome === "running") {
      navigating = true;
      await flushWhiteboardsBeforeChromeReload();
      location.reload();
    }
  } finally {
    if (!navigating) {
      outdatedReloadInFlight = false;
      if (outdatedReloadButton) outdatedReloadButton.disabled = false;
      if (outdatedText && generation === chromeOutdatedGeneration) {
        outdatedText.textContent =
          outcome === "no-answer"
            ? HEALTH_NO_ANSWER_COPY
            : "Lavish is still not running. Start it again, then use Check and reload.";
      }
    }
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;

  const msg = event.data || {};
  const messageToken = String(msg.artifact_load_token || "");
  if (messageToken !== artifactLoadToken) {
    // A pass can be stamped by the load that just lost a token race. Ask the current artifact
    // document to run the audit again instead of consuming the only pass for this cycle.
    if (msg.type === "lavish:layoutDiagnostics") postToFrame({ type: "lavish:requestLayoutDiagnostics" });
    return;
  }
  const messageSequence = ++artifactMessageSequence;
  artifactSpokeToken = messageToken;
  clearTimeout(artifactSilenceTimer);
  if (msg.type === "lavish:layoutDiagnostics") {
    const diagnosticSequence = ++layoutDiagnosticSequence;
    const complete = msg.complete !== false;
    // The gate is visual, so the client-side settled pass is the release signal. Reporting the
    // pass is deliberately fire-and-forget: a server restart or a diagnostics 4xx/5xx must not
    // hold a rendered artifact hostage to a network round-trip.
    if (complete) handleLayoutGatePass();
    submitLayoutDiagnostics({
      complete,
      targetPresenceComplete: msg.target_presence_complete === true,
      artifactRevision: msg.artifact_revision,
      artifactLoadToken: msg.artifact_load_token,
      artifactPassSequence: msg.artifact_pass_sequence,
      viewportWidth: msg.viewport_width,
      findings: msg.findings,
    })
      .then((result) => {
        if (messageToken !== artifactLoadToken || diagnosticSequence !== layoutDiagnosticSequence) return;
        if (Array.isArray(result?.warnings)) setLayoutWarnings(result.warnings);
        if (result?.status === "stale") {
          if (messageSequence === artifactMessageSequence) armArtifactAvailabilityProbe(messageToken);
          return;
        }
      })
      .catch(() => {
        // A failed report is still a completed client-side pass. Keep this fallback explicit so a
        // future change cannot accidentally make the network request the gate's release path.
        if (complete && messageToken === artifactLoadToken && diagnosticSequence === layoutDiagnosticSequence) {
          handleLayoutGatePass();
        }
      });
    return;
  }
  // The artifact spoke, so it rendered and ran its SDK - there is nothing fatal to probe for.
  if (msg.type === "lavish:queuePrompt") {
    enqueuePrompt(msg.prompt);
    // Queued from inside the artifact, where the closed dock is the only sign it landed.
    pulseSheetDock();
  }
  if (msg.type === "lavish:addMark") addMark(msg.prompt);
  if (msg.type === "lavish:snapshot") {
    completeSnapshotRequest(msg.snapshot_request_id, msg.snapshot || "");
  }
  if (msg.type === "lavish:suggestions") setSuggestions(msg.items);
  if (msg.type === "lavish:scroll") {
    lastScroll = { x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
  }
  if (msg.type === "lavish:reviewState") {
    setReviewState(msg.state && typeof msg.state === "object" ? msg.state : null);
  }
  if (msg.type === "lavish:reviewDraftUnrestorable") {
    discardUnrestorableDraft(String(msg.selector || ""));
  }
  if (msg.type === "lavish:artifactAssetFailure") {
    reportArtifactFailures(
      [{ kind: "artifact-asset-unavailable", detail: String(msg.detail || "a local artifact asset failed to load") }],
      messageToken,
    ).catch(() => {});
  }
  if (msg.type === "lavish:uploadAttachment") uploadAttachment(msg);
  // There is deliberately no attachment-delete message. See removeAttachment's
  // removal note below: the iframe cannot be trusted to decide a delete, and the
  // chrome cannot see every live reference, so reclamation is the sweeper's job.
  if (msg.type === "lavish:sendQueuedPrompts") sendQueued();
  if (msg.type === "lavish:endSession") endSession();
  if (msg.type === "lavish:revisions") applyRevisionMessage(msg);
  if (msg.type === "lavish:toggleAnnotationMode") toggleAnnotationMode();
  if (msg.type === "lavish:toggleCommandPalette") togglePalette();
  if (msg.type === "lavish:zoomImage") openImageZoomFromFrame(msg);
  if (msg.type === "lavish:maximizeVideo") openVideoViewer(msg);
  if (msg.type === "lavish:editQueuedAnchor") editQueuedAnchor(String(msg.selector || ""));
});

// The sandboxed artifact iframe can't reach the loopback server (opaque origin),
// so it hands captured image bytes here and the chrome performs the same-origin
// upload, then reports the server-vetted id back to the card.
async function uploadAttachment(message, reportResult = postToFrame, signal) {
  const localId = String(message.localId || "");
  if (!localId) return;
  // Echoed verbatim on every result so the artifact can tell a reply to ITS upload
  // from one still in flight for a previous document (E1). The chrome never
  // interprets it; it only round-trips it.
  const nonce = message.nonce;
  const bytes = message.bytes;
  let size;
  if (ArrayBuffer.isView(bytes)) {
    size = bytes.byteLength;
  } else {
    try {
      const byteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
      size = byteLengthGetter ? byteLengthGetter.call(bytes) : NaN;
    } catch {
      size = NaN;
    }
  }
  if (!Number.isFinite(size) || size < 0) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: "invalid upload payload",
    });
    return;
  }
  // Reject over-cap images before they hit the network: an over-cap upload aborts
  // mid-stream, and the browser can hang or reset instead of surfacing the 413, so
  // the chip would never leave "uploading". Catching it here guarantees the card
  // reaches its error+retry state. The server still enforces the cap authoritatively.
  if (attachmentMaxBytes > 0 && size > attachmentMaxBytes) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: "Image is larger than the " + formatByteLimit(attachmentMaxBytes) + " limit",
    });
    return;
  }
  // Confused-deputy guard: rate + cumulative-byte ceiling before touching the network.
  const now = Date.now();
  while (uploadTimestamps.length && now - uploadTimestamps[0] > UPLOAD_RATE_WINDOW_MS) uploadTimestamps.shift();
  if (uploadTimestamps.length >= UPLOAD_RATE_MAX) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: "Too many uploads. Wait a moment and retry.",
    });
    return;
  }
  if (uploadedBytesTotal + size > UPLOAD_SESSION_BYTE_QUOTA) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: "Upload limit reached for this session (" + formatByteLimit(UPLOAD_SESSION_BYTE_QUOTA) + ").",
    });
    return;
  }
  // In-flight ceiling: refuse rather than pile another large body onto the network
  // while the bound is full. The card keeps its retry affordance, and a settled
  // upload (below) frees a slot for the next.
  if (uploadsInFlight >= UPLOAD_MAX_IN_FLIGHT) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: "Too many uploads in flight. Wait a moment and retry.",
    });
    return;
  }
  uploadTimestamps.push(now);
  uploadedBytesTotal += size;
  uploadsInFlight += 1;
  try {
    const response = await fetch("/api/" + key + "/attachments", {
      method: "POST",
      headers: { "content-type": String(message.mime || "application/octet-stream") },
      body: bytes,
      signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Upload failed");
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: true,
      id: (data.attachment && data.attachment.id) || "",
    });
  } catch (error) {
    reportResult({
      type: "lavish:attachmentResult",
      nonce,
      localId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    uploadsInFlight -= 1;
  }
}

// There is intentionally no eager attachment delete here. Removing a chip used to
// ask the chrome to DELETE the stored file once no queued prompt referenced it,
// but that check is not authoritative: attachments are content-addressed, so two
// tabs (or two cards) can hold the SAME id, and a chip that is ready but not yet
// queued in another tab is invisible from here. The delete was also driven by the
// untrusted iframe, making the chrome a confused deputy - a malicious artifact
// could destroy bytes a live card still needed, which then failed as `not-found`
// on send. Unreferenced files are reclaimed by the server's reference-aware TTL
// sweeper and the disk-cap backstop, which see every session's pending prompts
// at once. Deleting late is cheap; deleting bytes someone still needs is not.

loadFrame();

function toggleAnnotationMode() {
  if (ended || terminalSubmission) return;
  annotation = !annotation;
  renderPointerMode();
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation });
}

// Pointer mode is one state shown three ways: the Annotate half of the top bar's segment (the
// historical #annotation toggle), its Interact half, and the rail's annotate button.
function renderPointerMode() {
  annotationSwitch.setAttribute("aria-pressed", String(annotation));
  modeInteractButton.setAttribute("aria-pressed", String(!annotation));
  railAnnotateButton.setAttribute("aria-pressed", String(annotation));
}

annotationSwitch.onclick = toggleAnnotationMode;
modeInteractButton.onclick = () => {
  if (annotation) toggleAnnotationMode();
};
railAnnotateButton.onclick = toggleAnnotationMode;
renderPointerMode();

sendButton.onclick = () => sendQueued(false);
sendAndEndButton.onclick = () => sendQueued(true);
moreButton.onclick = () => {
  closeWarningsDrawer();
  closeRevisionsDrawer();
  toggleMenu(moreButton, moreMenu);
};
warningsButton.onclick = toggleWarningsDrawer;
revisionsButton.onclick = () => {
  closeWarningsDrawer();
  setRevisionsDrawerOpen(revisionsDrawer.hidden);
};
warningsSelectAll.onchange = toggleSelectAllWarnings;
warningsQueueButton.onclick = queueSelectedWarningFixes;
chatAttachButton.onclick = () => chatAttachInput.click();
chatAttachInput.addEventListener("change", () => {
  chatAttachmentController.addFiles(chatAttachInput.files);
  chatAttachmentController.rejectUnsupported(chatAttachInput.files);
  chatAttachInput.value = "";
});
// The one place a paste or drop is turned into a file list, so both surfaces see
// the same payload. Pasted screenshots arrive as items, not files, in some
// browsers; `.files` alone silently attaches nothing there.
function transferredFiles(dataTransfer) {
  const files = Array.from(dataTransfer?.files || []).filter(Boolean);
  if (files.length) return files;
  return Array.from(dataTransfer?.items || [])
    .filter((item) => item && item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}
// Finder/Explorer file copies put the copied file's name or path in text/plain;
// that placeholder must not land in the message beside the attached image. Real
// captions (any line that is not a pasted file's name) keep the default paste.
// Mirrors planClipboardPaste in artifact-sdk.js, which owns the same rule for
// the annotation card - this file is served raw and cannot import it.
function keepsClipboardText(text, files) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return false;
  const names = files.map((file) => String(file?.name || "")).filter(Boolean);
  if (!names.length) return true;
  return !lines.every((line) =>
    names.some((name) => line === name || line.endsWith("/" + name) || line.endsWith("\\" + name)),
  );
}
chatInput.addEventListener("paste", (event) => {
  const files = transferredFiles(event.clipboardData);
  // Images only: Office and macOS pastes expose stray non-image file flavors
  // beside their text, so unsupported entries raise no chip here (matching the
  // annotation card) - a chip would block sending for a perceived text paste.
  const added = chatAttachmentController.addFiles(files);
  if (added && !keepsClipboardText(event.clipboardData?.getData("text/plain") || "", files)) event.preventDefault();
});
chatComposer.addEventListener("dragover", (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes("Files")) {
    event.preventDefault();
    chatComposer.classList.add("is-dropping");
  }
});
chatComposer.addEventListener("dragleave", (event) => {
  const entering = /** @type {Node | null} */ (event.relatedTarget);
  if (!chatComposer.contains(entering)) chatComposer.classList.remove("is-dropping");
});
chatComposer.addEventListener("drop", (event) => {
  chatComposer.classList.remove("is-dropping");
  if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
  event.preventDefault();
  const files = transferredFiles(event.dataTransfer);
  if (!files.length) {
    // A drag advertising Files with nothing enumerable: the default was already
    // consumed, so refuse visibly (like the card) instead of swallowing it.
    chatAttachmentController.rejectUnsupported([{ name: "file", type: "" }]);
    return;
  }
  chatAttachmentController.addFiles(files);
  chatAttachmentController.rejectUnsupported(files);
});
// A file drop that misses the composer must not navigate the chrome away from
// the session (losing chips, uploads, and the live-event connection). Text drags stay
// untouched so dropping text into the textarea keeps working.
document.addEventListener("dragover", (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault();
});
document.addEventListener("drop", (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault();
});
chatAttachments.addEventListener("click", (event) => {
  const target = /** @type {HTMLElement | null} */ (event.target);
  const remove = /** @type {HTMLElement | null} */ (target?.closest?.("[data-chat-attachment-remove]") || null);
  if (remove) chatAttachmentController.remove(String(remove.dataset.chatAttachmentRemove || ""));
  const retry = /** @type {HTMLElement | null} */ (target?.closest?.("[data-chat-attachment-retry]") || null);
  if (retry) chatAttachmentController.retry(String(retry.dataset.chatAttachmentRetry || ""));
});
chatInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  // Ctrl+Q only, never Cmd+Q, which quits the browser on a Mac before the page can object.
  if (event.ctrlKey && !event.metaKey && !event.altKey && String(event.key || "").toLowerCase() === "q") {
    event.preventDefault();
    queueComposerDraft();
    return;
  }
  if (editingPromptId) {
    // Editing a queued note: Enter keeps the words, Escape drops the edit, Shift+Enter breaks the line.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      saveQueuedEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation?.();
      cancelQueuedEdit();
    }
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendQueued(false);
  }
});
chatInput.addEventListener("input", () => {
  if (editingPromptId) {
    editingDraft = String(chatInput.value || "");
    return;
  }
  hideSendHint();
  renderSuggestions();
  renderSendLabel();
});
copyPathButton.onclick = copyFilePath;
/** @type {HTMLButtonElement} */ (document.getElementById("copyPathBar")).onclick = copyFilePath;
/** @type {HTMLButtonElement} */ (document.getElementById("openPalette")).onclick = () => {
  closeMenus();
  openPalette();
};
reloadArtifactButton.onclick = reloadArtifact;
copySnapshotButton.onclick = copyDomSnapshot;
exportArtifactButton.onclick = exportArtifact;
shareArtifactButton.onclick = openShareDialog;
shareCloseButton.onclick = closeShareDialog;
shareCancelButton.onclick = closeShareDialog;
shareForm.addEventListener("submit", publishShare);
shareDialog.addEventListener("click", (event) => {
  if (event.target === shareDialog) closeShareDialog();
});
copyShareUrlButton.onclick = () => copyToButton(shareUrlInput.value, copyShareUrlButton, "Copy URL");
copyUpdateKeyButton.onclick = () => copyToButton(shareUpdateKeyInput.value, copyUpdateKeyButton, "Copy key");
copySharePasswordButton.onclick = () =>
  copyToButton(sharePasswordOutput.value, copySharePasswordButton, "Copy password");
copyShareSiteIdButton.onclick = () => copyToButton(shareSiteIdInput.value, copyShareSiteIdButton, "Copy site ID");
shareGenerateInput.onchange = syncSharePasswordInput;
endButton.onclick = () => {
  closeMenus();
  endSession();
};
handoffTakeoverButton.onclick = () => location.reload();
if (outdatedReloadButton) outdatedReloadButton.onclick = () => reloadChromeForOutdatedBanner();
if (outdatedDismissButton) {
  outdatedDismissButton.onclick = () => {
    // A dismissed unreachable banner stays dismissed until the stream actually recovers; without
    // this the next failed reconnect puts it straight back on screen.
    if (unreachableBannerOwned) {
      unreachableBannerOwned = false;
      unreachableDismissed = true;
    }
    setChromeOutdated(false);
  };
}
document.addEventListener("mousedown", (event) => {
  const target = /** @type {Node} */ (event.target);
  if (!moreMenu.hidden && !moreWrap.contains(target)) setMenuOpen(moreButton, moreMenu, false);
  if (warningsDrawerOpen && !warningsWrap.contains(target)) closeWarningsDrawer();
  if (revisionsDrawerOpen && !revisionsWrap.contains(target)) closeRevisionsDrawer();
});
// A non-modal popover closes when focus leaves it, so keyboard users are never stranded inside a
// panel they cannot see the end of.
warningsWrap.addEventListener("focusout", (event) => {
  const next = /** @type {Node | null} */ (event.relatedTarget);
  if (warningsDrawerOpen && next && !warningsWrap.contains(next)) closeWarningsDrawer();
});
revisionsWrap.addEventListener("focusout", (event) => {
  const next = /** @type {Node | null} */ (event.relatedTarget);
  if (revisionsDrawerOpen && next && !revisionsWrap.contains(next)) closeRevisionsDrawer();
});
whiteboardCloseButton.onclick = closeWhiteboard;
// ---- Image zoom (#3230). The interaction is Kibo UI's Image Zoom, the shadcn/ui registry
// component: a click grows the picture from where it sat to fill the window over a blurred
// backdrop, and Esc or a click on the backdrop sends it back. Review needs a closer look than
// "fit", so the zoomed view adds inspection: wheel or pinch zooms around the pointer, drag pans,
// double-click toggles fit and 1:1, and the toolbar and keys (+, -, 0, 1, arrows) do the same.
// Sources: chat and composer thumbnails here, and artifact images via lavish:zoomImage. ----

const imageZoom = /** @type {HTMLDivElement} */ (document.getElementById("imageZoom"));
const imageZoomStage = /** @type {HTMLDivElement} */ (document.getElementById("imageZoomStage"));
const imageZoomImg = /** @type {HTMLImageElement} */ (document.getElementById("imageZoomImg"));
const imageZoomCaption = /** @type {HTMLParagraphElement} */ (document.getElementById("imageZoomCaption"));
const imageZoomLevel = /** @type {HTMLOutputElement} */ (document.getElementById("imageZoomLevel"));
const imageZoomClose = /** @type {HTMLButtonElement} */ (document.getElementById("imageZoomClose"));
const imageZoomInButton = /** @type {HTMLButtonElement} */ (document.getElementById("imageZoomIn"));
const imageZoomOutButton = /** @type {HTMLButtonElement} */ (document.getElementById("imageZoomOut"));
const imageZoomFitButton = /** @type {HTMLButtonElement} */ (document.getElementById("imageZoomFit"));
const imageZoomActualButton = /** @type {HTMLButtonElement} */ (document.getElementById("imageZoomActual"));

// Room kept around a fitted picture, and below it for the toolbar.
const IMAGE_ZOOM_MARGIN = 48;
const IMAGE_ZOOM_BAR_SPACE = 76;
const IMAGE_ZOOM_MAX_SCALE = 16;
const IMAGE_ZOOM_STEP = 1.25;
// A data: URL an artifact hands over is bounded, like every other frame payload.
const IMAGE_ZOOM_MAX_SRC_LENGTH = 8_000_000;

/**
 * @typedef {{ left: number, top: number, width: number, height: number }} ZoomRect
 * @type {{ width: number, height: number, scale: number, x: number, y: number, origin: ZoomRect | null, returnFocus: Element | null, vector: boolean } | null}
 */
let zoomView = null;
let zoomOpening = 0;
/** @type {Map<number, { x: number, y: number }>} */
const zoomPointers = new Map();
/** @type {{ kind: "pan", x: number, y: number, viewX: number, viewY: number, moved: boolean, onImage: boolean } | { kind: "pinch", distance: number, scale: number } | null} */
let zoomGesture = null;

// Only pictures can open: http(s) URLs and raster or SVG data: URLs from the artifact, plus the
// composer's own blob: previews. An <img> never runs script, SVG included.
function zoomableSrc(value, { allowBlob = false } = {}) {
  if (typeof value !== "string" || !value || value.length > IMAGE_ZOOM_MAX_SRC_LENGTH) return "";
  if (/^data:/i.test(value)) return /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(value) ? value : "";
  // An <img>'s src property is already absolute, so the scheme decides.
  if (/^https?:\/\//i.test(value)) return value;
  if (allowBlob && /^blob:/i.test(value)) return value;
  return "";
}

function zoomRect(value) {
  if (!value || typeof value !== "object") return null;
  const rect = {
    left: Number(value.left),
    top: Number(value.top),
    width: Number(value.width),
    height: Number(value.height),
  };
  return Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0 ? rect : null;
}

function zoomViewport() {
  return { width: Number(window.innerWidth) || 1024, height: Number(window.innerHeight) || 768 };
}

function zoomFitScale() {
  if (!zoomView) return 1;
  const viewport = zoomViewport();
  const width = Math.max(1, viewport.width - IMAGE_ZOOM_MARGIN * 2);
  const height = Math.max(1, viewport.height - IMAGE_ZOOM_MARGIN - IMAGE_ZOOM_BAR_SPACE);
  // Never blow a small picture up past its own pixels on open; zooming in is one step away.
  return Math.min(width / zoomView.width, height / zoomView.height, 1);
}

function zoomMinScale() {
  return Math.min(zoomFitScale(), 1) / 2;
}

// Keeps the picture reachable: centred on an axis where it is smaller than the window, and never
// dragged so far that its edge leaves the margin on an axis where it is larger.
function clampZoomView() {
  if (!zoomView) return;
  const viewport = zoomViewport();
  const width = zoomView.width * zoomView.scale;
  const height = zoomView.height * zoomView.scale;
  const top = IMAGE_ZOOM_MARGIN;
  const bottom = viewport.height - IMAGE_ZOOM_BAR_SPACE;
  if (width <= viewport.width - IMAGE_ZOOM_MARGIN * 2) zoomView.x = (viewport.width - width) / 2;
  else zoomView.x = Math.min(IMAGE_ZOOM_MARGIN, Math.max(viewport.width - IMAGE_ZOOM_MARGIN - width, zoomView.x));
  if (height <= bottom - top) zoomView.y = top + (bottom - top - height) / 2;
  else zoomView.y = Math.min(top, Math.max(bottom - height, zoomView.y));
}

function renderZoomView() {
  if (!zoomView) return;
  // Sized, not scaled: the browser then draws the picture at its zoomed size, so an SVG stays
  // sharp at any level instead of being stretched from one raster.
  imageZoomImg.style.width = zoomView.width * zoomView.scale + "px";
  imageZoomImg.style.height = zoomView.height * zoomView.scale + "px";
  imageZoomImg.style.transform = "translate(" + zoomView.x + "px, " + zoomView.y + "px)";
  imageZoomLevel.textContent = Math.round(zoomView.scale * 100) + "%";
  // Past 3x, show the real pixels instead of smoothing them away: that is what inspecting is for.
  imageZoomImg.classList.toggle("is-pixelated", zoomView.scale >= 3 && !zoomView.vector);
  imageZoomStage.classList.toggle("can-pan", zoomView.scale > zoomFitScale() + 0.001);
  imageZoomOutButton.disabled = zoomView.scale <= zoomMinScale() + 0.001;
  imageZoomInButton.disabled = zoomView.scale >= IMAGE_ZOOM_MAX_SCALE - 0.001;
}

// One owner for the open/close glide: only these two steps tween the transform.
function animateZoomView(apply) {
  if (prefersReducedMotion()) {
    apply();
    renderZoomView();
    return;
  }
  imageZoom.classList.add("is-animating");
  apply();
  renderZoomView();
  const duration = motionMs("--modal-open-dur", 250);
  setTimeout(() => imageZoom.classList.remove("is-animating"), duration);
}

function zoomTo(scale, pointX, pointY, { animate = false } = {}) {
  if (!zoomView) return;
  const next = Math.min(IMAGE_ZOOM_MAX_SCALE, Math.max(zoomMinScale(), scale));
  const apply = () => {
    if (!zoomView) return;
    const ratio = next / zoomView.scale;
    zoomView.x = pointX - (pointX - zoomView.x) * ratio;
    zoomView.y = pointY - (pointY - zoomView.y) * ratio;
    zoomView.scale = next;
    clampZoomView();
  };
  if (animate) animateZoomView(apply);
  else {
    apply();
    renderZoomView();
  }
}

function zoomCenter() {
  const viewport = zoomViewport();
  return { x: viewport.width / 2, y: (viewport.height - IMAGE_ZOOM_BAR_SPACE + IMAGE_ZOOM_MARGIN) / 2 };
}

function zoomToFit({ animate = true } = {}) {
  if (!zoomView) return;
  const apply = () => {
    if (!zoomView) return;
    zoomView.scale = zoomFitScale();
    clampZoomView();
  };
  if (animate) animateZoomView(apply);
  else {
    apply();
    renderZoomView();
  }
}

function zoomStep(direction) {
  if (!zoomView) return;
  const center = zoomCenter();
  zoomTo(zoomView.scale * (direction > 0 ? IMAGE_ZOOM_STEP : 1 / IMAGE_ZOOM_STEP), center.x, center.y, {
    animate: true,
  });
}

/**
 * @param {string} src
 * @param {{ alt?: string, origin?: ZoomRect | null }} [options]
 */
async function openImageZoom(src, { alt = "", origin = null } = {}) {
  if (!src || zoomView) return;
  const opening = ++zoomOpening;
  const returnFocus = document.activeElement;
  imageZoomImg.alt = alt;
  imageZoomImg.src = src;
  try {
    if (typeof imageZoomImg.decode === "function") await imageZoomImg.decode();
  } catch {
    // An image that will not decode cannot be inspected; leave the page as it was.
    if (opening === zoomOpening) imageZoomImg.removeAttribute("src");
    return;
  }
  if (opening !== zoomOpening || zoomView) return;
  const width = Number(imageZoomImg.naturalWidth) || 0;
  const height = Number(imageZoomImg.naturalHeight) || 0;
  if (!width || !height) return;
  const vector = /^data:image\/svg\+xml/i.test(src) || /\.svgz?(?:[?#]|$)/i.test(src);
  zoomView = { width, height, scale: 1, x: 0, y: 0, origin, returnFocus, vector };
  imageZoomCaption.textContent = (alt ? alt + " · " : "") + width + " × " + height;
  closeMenus();
  setLayerOpen(imageZoom, true);
  if (origin) {
    // Start exactly over the thumbnail, then glide to the fitted view.
    zoomView.scale = origin.width / width;
    zoomView.x = origin.left;
    zoomView.y = origin.top;
    renderZoomView();
    void imageZoomImg.offsetWidth;
    zoomToFit({ animate: true });
  } else {
    zoomToFit({ animate: false });
  }
  imageZoomClose.focus();
}

function closeImageZoom() {
  if (!zoomView) return;
  const view = zoomView;
  zoomPointers.clear();
  zoomGesture = null;
  if (view.origin) {
    animateZoomView(() => {
      view.scale = view.origin ? view.origin.width / view.width : view.scale;
      view.x = view.origin ? view.origin.left : view.x;
      view.y = view.origin ? view.origin.top : view.y;
    });
  }
  zoomView = null;
  setLayerOpen(imageZoom, false, { closeToken: "--modal-open-dur" });
  const back = /** @type {HTMLElement | null} */ (view.returnFocus);
  if (back && typeof back.focus === "function" && back !== document.body) back.focus();
}

imageZoomStage.addEventListener(
  "wheel",
  (event) => {
    if (!zoomView) return;
    event.preventDefault();
    // A trackpad pinch arrives as a ctrl-wheel with small deltas; scale it up to feel the same.
    const factor = Math.exp(-Number(event.deltaY) * (event.ctrlKey ? 0.01 : 0.0015));
    zoomTo(zoomView.scale * factor, Number(event.clientX), Number(event.clientY));
  },
  { passive: false },
);

imageZoomStage.addEventListener("pointerdown", (event) => {
  if (!zoomView || (event.pointerType === "mouse" && event.button !== 0)) return;
  zoomPointers.set(event.pointerId, { x: Number(event.clientX), y: Number(event.clientY) });
  if (typeof imageZoomStage.setPointerCapture === "function") imageZoomStage.setPointerCapture(event.pointerId);
  if (zoomPointers.size === 2) {
    const [a, b] = [...zoomPointers.values()];
    zoomGesture = { kind: "pinch", distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: zoomView.scale };
  } else if (zoomPointers.size === 1) {
    zoomGesture = {
      kind: "pan",
      x: Number(event.clientX),
      y: Number(event.clientY),
      viewX: zoomView.x,
      viewY: zoomView.y,
      moved: false,
      onImage: event.target === imageZoomImg,
    };
  }
});

imageZoomStage.addEventListener("pointermove", (event) => {
  if (!zoomView || !zoomPointers.has(event.pointerId) || !zoomGesture) return;
  zoomPointers.set(event.pointerId, { x: Number(event.clientX), y: Number(event.clientY) });
  if (zoomGesture.kind === "pinch" && zoomPointers.size >= 2) {
    const [a, b] = [...zoomPointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    zoomTo((zoomGesture.scale * distance) / zoomGesture.distance, (a.x + b.x) / 2, (a.y + b.y) / 2);
    return;
  }
  if (zoomGesture.kind !== "pan") return;
  const dx = Number(event.clientX) - zoomGesture.x;
  const dy = Number(event.clientY) - zoomGesture.y;
  if (!zoomGesture.moved && Math.hypot(dx, dy) < 4) return;
  zoomGesture.moved = true;
  imageZoomStage.classList.add("is-panning");
  zoomView.x = zoomGesture.viewX + dx;
  zoomView.y = zoomGesture.viewY + dy;
  clampZoomView();
  renderZoomView();
});

function endZoomPointer(event) {
  if (!zoomPointers.has(event.pointerId)) return;
  zoomPointers.delete(event.pointerId);
  const gesture = zoomGesture;
  imageZoomStage.classList.remove("is-panning");
  if (zoomPointers.size === 0) zoomGesture = null;
  else if (zoomPointers.size === 1 && zoomView) {
    // Lifting one finger of a pinch hands over to panning from where the other one is.
    const [rest] = [...zoomPointers.values()];
    zoomGesture = {
      kind: "pan",
      x: rest.x,
      y: rest.y,
      viewX: zoomView.x,
      viewY: zoomView.y,
      moved: true,
      onImage: true,
    };
  }
  // A plain click on the backdrop closes, as in the Kibo component; a click on the picture or
  // the end of a drag does not.
  if (event.type === "pointerup" && gesture?.kind === "pan" && !gesture.moved && !gesture.onImage) closeImageZoom();
}
imageZoomStage.addEventListener("pointerup", endZoomPointer);
imageZoomStage.addEventListener("pointercancel", endZoomPointer);

imageZoomStage.addEventListener("dblclick", (event) => {
  if (!zoomView) return;
  const fit = zoomFitScale();
  const close = Math.max(1, fit * 2);
  if (zoomView.scale < close - 0.01) zoomTo(close, Number(event.clientX), Number(event.clientY), { animate: true });
  else zoomToFit();
});

imageZoomClose.addEventListener("click", () => closeImageZoom());
imageZoomInButton.addEventListener("click", () => zoomStep(1));
imageZoomOutButton.addEventListener("click", () => zoomStep(-1));
imageZoomFitButton.addEventListener("click", () => zoomToFit());
imageZoomActualButton.addEventListener("click", () => {
  const center = zoomCenter();
  zoomTo(1, center.x, center.y, { animate: true });
});

imageZoom.addEventListener("keydown", (event) => {
  if (!zoomView) return;
  const key = String(event.key || "");
  const pan = 48;
  if (key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeImageZoom();
  } else if (key === "+" || key === "=") {
    event.preventDefault();
    zoomStep(1);
  } else if (key === "-" || key === "_") {
    event.preventDefault();
    zoomStep(-1);
  } else if (key === "0") {
    event.preventDefault();
    zoomToFit();
  } else if (key === "1") {
    event.preventDefault();
    imageZoomActualButton.click();
  } else if (key.startsWith("Arrow")) {
    event.preventDefault();
    zoomView.x += key === "ArrowLeft" ? pan : key === "ArrowRight" ? -pan : 0;
    zoomView.y += key === "ArrowUp" ? pan : key === "ArrowDown" ? -pan : 0;
    clampZoomView();
    renderZoomView();
  } else if (key === "Tab") {
    // The preview is modal: Tab cycles through its own controls.
    const controls = [
      imageZoomClose,
      imageZoomOutButton,
      imageZoomInButton,
      imageZoomFitButton,
      imageZoomActualButton,
    ].filter((control) => !control.disabled);
    const index = controls.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    event.preventDefault();
    const next = (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
    controls[next].focus();
  }
});

window.addEventListener("resize", () => {
  if (!zoomView) return;
  zoomView.scale = Math.min(Math.max(zoomView.scale, zoomMinScale()), IMAGE_ZOOM_MAX_SCALE);
  clampZoomView();
  renderZoomView();
});

// Chat bubble thumbnails and the composer's attachment previews. Capture phase, so opening a
// queued note's picture does not also open that note for editing.
document.addEventListener(
  "click",
  (event) => {
    const target = /** @type {Element | null} */ (event.target);
    const thumb =
      target && typeof target.closest === "function"
        ? target.closest("img.bubble-attachment, img.chat-attachment-thumb")
        : null;
    if (!thumb) return;
    const image = /** @type {HTMLImageElement} */ (thumb);
    const src = zoomableSrc(image.currentSrc || image.src, { allowBlob: true });
    if (!src) return;
    event.preventDefault();
    event.stopPropagation();
    const box = typeof image.getBoundingClientRect === "function" ? image.getBoundingClientRect() : null;
    void openImageZoom(src, { alt: String(image.alt || ""), origin: zoomRect(box) });
  },
  true,
);

// An artifact picture. The SDK reports its box in the frame's coordinates; the frame's own box
// puts it on the page so the glide starts where the reader clicked.
function openImageZoomFromFrame(msg) {
  const src = zoomableSrc(msg.src);
  if (!src) return;
  const inner = zoomRect(msg.rect);
  const frameBox = typeof frame.getBoundingClientRect === "function" ? frame.getBoundingClientRect() : null;
  const origin =
    inner && frameBox
      ? {
          left: inner.left + Number(frameBox.left),
          top: inner.top + Number(frameBox.top),
          width: inner.width,
          height: inner.height,
        }
      : null;
  void openImageZoom(src, { alt: typeof msg.alt === "string" ? msg.alt.slice(0, 300) : "", origin: zoomRect(origin) });
}

// ---- Maximized video (#3236). The artifact's video plays large over the editor in the picture
// preview's shell, from the moment it was at; Full screen (or F) hands it to the browser's full
// screen. Closing sends the position back, and the artifact's own player resumes from there. ----

const videoViewer = /** @type {HTMLDivElement} */ (document.getElementById("videoViewer"));
const videoViewerStage = /** @type {HTMLDivElement} */ (document.getElementById("videoViewerStage"));
const videoViewerVideo = /** @type {HTMLVideoElement} */ (document.getElementById("videoViewerVideo"));
const videoViewerCaption = /** @type {HTMLParagraphElement} */ (document.getElementById("videoViewerCaption"));
const videoViewerClose = /** @type {HTMLButtonElement} */ (document.getElementById("videoViewerClose"));
const videoViewerFullscreen = /** @type {HTMLButtonElement} */ (document.getElementById("videoViewerFullscreen"));

/** @type {Element | null} */
let videoViewerReturnFocus = null;

// Only video: http(s) URLs and video data: URLs; anything else stays in the artifact.
function playableVideoSrc(value) {
  if (typeof value !== "string" || !value || value.length > IMAGE_ZOOM_MAX_SRC_LENGTH) return "";
  if (/^data:/i.test(value)) return /^data:video\/(mp4|webm|ogg|quicktime)[;,]/i.test(value) ? value : "";
  return /^https?:\/\//i.test(value) ? value : "";
}

function openVideoViewer(msg) {
  const src = playableVideoSrc(msg.src);
  if (!src || !videoViewer.hidden) return;
  const time = Number(msg.time);
  const title = typeof msg.alt === "string" ? msg.alt.trim().slice(0, 300) : "";
  videoViewerReturnFocus = document.activeElement;
  videoViewerVideo.poster = zoomableSrc(msg.poster) || "";
  videoViewerVideo.muted = msg.muted === true;
  videoViewerVideo.loop = msg.loop === true;
  videoViewerVideo.src = src;
  videoViewerCaption.textContent = title || "Video";
  const start = () => {
    if (Number.isFinite(time) && time > 0) videoViewerVideo.currentTime = time;
    // Carry on playing if it was playing; a browser that refuses autoplay leaves it paused.
    if (msg.paused === false && typeof videoViewerVideo.play === "function") {
      const playing = videoViewerVideo.play();
      if (playing && typeof playing.catch === "function") playing.catch(() => {});
    }
  };
  if (Number(videoViewerVideo.readyState) >= 1) start();
  else videoViewerVideo.addEventListener("loadedmetadata", start, { once: true });
  closeMenus();
  setLayerOpen(videoViewer, true);
  videoViewerVideo.focus();
}

function closeVideoViewer() {
  if (videoViewer.hidden) return;
  if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
    document.exitFullscreen().catch(() => {});
  }
  const time = Number(videoViewerVideo.currentTime) || 0;
  const paused = videoViewerVideo.paused !== false;
  if (typeof videoViewerVideo.pause === "function") videoViewerVideo.pause();
  postToFrame({ type: "lavish:videoReturn", time, paused });
  setLayerOpen(videoViewer, false, { closeToken: "--modal-close-dur" });
  // Let go of the stream once the fade is over, so a closed viewer is not still downloading.
  setTimeout(
    () => {
      if (!videoViewer.hidden) return;
      videoViewerVideo.removeAttribute("src");
      if (typeof videoViewerVideo.load === "function") videoViewerVideo.load();
    },
    motionMs("--modal-close-dur", 150),
  );
  const back = /** @type {HTMLElement | null} */ (videoViewerReturnFocus);
  videoViewerReturnFocus = null;
  if (back && typeof back.focus === "function" && back !== document.body) back.focus();
}

function toggleVideoFullscreen() {
  if (document.fullscreenElement) {
    if (typeof document.exitFullscreen === "function") document.exitFullscreen().catch(() => {});
    return;
  }
  if (typeof videoViewerVideo.requestFullscreen === "function") videoViewerVideo.requestFullscreen().catch(() => {});
}

videoViewerClose.addEventListener("click", () => closeVideoViewer());
videoViewerFullscreen.addEventListener("click", () => toggleVideoFullscreen());
// A click on the backdrop around the player closes it, as in the picture preview.
videoViewerStage.addEventListener("click", (event) => {
  if (event.target === videoViewerStage) closeVideoViewer();
});
videoViewer.addEventListener("keydown", (event) => {
  const key = String(event.key || "");
  if (key === "Escape") {
    // In full screen the browser takes Escape to leave it; this is the next press.
    event.preventDefault();
    event.stopPropagation();
    closeVideoViewer();
  } else if ((key === "f" || key === "F") && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    toggleVideoFullscreen();
  } else if (key === "Tab") {
    const controls = [videoViewerClose, videoViewerVideo, videoViewerFullscreen];
    const index = controls.indexOf(/** @type {any} */ (document.activeElement));
    event.preventDefault();
    controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
  }
});

// ---- Command palette (Ctrl/Cmd+K). Each command runs the same control the reader could click, so
// its guards, focus handling, and side effects stay in one place; a control that is disabled or
// not on screen in this layout is left out of the list. ----

const paletteDialog = /** @type {HTMLDivElement} */ (document.getElementById("paletteDialog"));
const palette = /** @type {HTMLDivElement} */ (document.getElementById("palette"));
const paletteInput = /** @type {HTMLInputElement} */ (document.getElementById("paletteInput"));
const paletteList = /** @type {HTMLUListElement} */ (document.getElementById("paletteList"));
const COMMAND_PALETTE_HOTKEY_KEY = String(sessionData.commandPaletteHotkeyKey || "").toLowerCase();

function isCommandPaletteHotkeyEvent(event) {
  if (event.shiftKey || event.altKey) return false;
  return (
    Boolean(event.metaKey || event.ctrlKey) && String(event.key || "").toLowerCase() === COMMAND_PALETTE_HOTKEY_KEY
  );
}

/** @returns {{ label: string, run: () => void, danger?: boolean }[]} */
function paletteCommands() {
  const desktop = !isMobileSheet();
  // The layout already in use is not a command.
  const currentLayout = chatLayout.mode === "sidebar" ? chatLayout.side : chatLayout.mode;
  const offerLayout = (name) => desktop && name !== currentLayout;
  /** @type {{ label: string, control?: HTMLElement | null, run?: () => void, when?: boolean, danger?: boolean }[]} */
  const commands = [
    { label: annotation ? "Switch to explore mode" : "Switch to annotate mode", control: annotationSwitch },
    { label: "Write a message", run: focusComposer },
    { label: "Attach images", control: chatAttachButton },
    { label: "Conversation on the left", control: layoutOptionButtons.left, when: offerLayout("left") },
    { label: "Conversation on the right", control: layoutOptionButtons.right, when: offerLayout("right") },
    { label: "Collapse the conversation to a rail", control: layoutOptionButtons.rail, when: offerLayout("rail") },
    {
      label: "Peek: float the conversation at the bottom",
      control: layoutOptionButtons.peek,
      when: offerLayout("peek"),
    },
    {
      label: effectiveTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme",
      control: themeToggle,
    },
    { label: "Follow system theme", run: () => setThemeChoice(null), when: Boolean(storedThemeChoice()) },
    { label: "Show revisions", control: revisionsButton, when: !revisionsWrap.hidden },
    { label: "Show layout issues", control: warningsButton, when: !warningsWrap.hidden },
    { label: "Reload artifact", control: reloadArtifactButton },
    { label: "Copy DOM snapshot", control: copySnapshotButton },
    { label: "Copy the artifact path", control: copyPathButton },
    { label: "Export standalone HTML", control: exportArtifactButton },
    { label: "Publish link", control: shareArtifactButton },
    ...revisionPaletteCommands(),
    { label: "End session", control: endButton, danger: true },
  ];
  return commands
    .filter((command) => command.when !== false && !(command.control && /** @type {any} */ (command.control).disabled))
    .map((command) => ({
      label: command.label,
      danger: command.danger,
      run: command.run || (() => command.control && command.control.click()),
    }));
}

function revisionPaletteCommands() {
  return [...revisionEntries].reverse().flatMap((entry) =>
    entry.marks.length
      ? [
          { label: "Jump to " + entry.id + " (" + entry.label + ")", run: () => revealNextRevisionMark(entry.id) },
          {
            label: (outlinedRevisionId === entry.id ? "Stop outlining " : "Outline what changed in ") + entry.id,
            run: () => setOutlinedRevision(outlinedRevisionId === entry.id ? "" : entry.id),
          },
        ]
      : [],
  );
}

function focusComposer() {
  if (isRailLayout()) setChatLayout({ mode: "sidebar" });
  if (isDockLayout()) setSheetOpen(true);
  chatInput.focus();
}

let paletteMatches = /** @type {ReturnType<typeof paletteCommands>} */ ([]);
let paletteActive = 0;
/** @type {Element | null} */
let paletteReturnFocus = null;

// Every word typed has to appear somewhere in the label, in any order.
function filterPaletteCommands(query) {
  const words = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return paletteCommands().filter((command) => {
    const label = command.label.toLowerCase();
    return words.every((word) => label.includes(word));
  });
}

function renderPalette() {
  paletteMatches = filterPaletteCommands(paletteInput.value);
  paletteActive = Math.min(paletteActive, Math.max(0, paletteMatches.length - 1));
  paletteList.replaceChildren();
  if (!paletteMatches.length) {
    const empty = document.createElement("li");
    empty.className = "palette-empty";
    empty.setAttribute("role", "presentation");
    empty.textContent = "No matching command";
    paletteList.appendChild(empty);
    paletteInput.removeAttribute("aria-activedescendant");
    return;
  }
  paletteMatches.forEach((command, index) => {
    const option = document.createElement("li");
    option.id = "palette-option-" + index;
    option.className = command.danger ? "palette-option danger" : "palette-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === paletteActive));
    option.dataset.index = String(index);
    option.textContent = command.label;
    paletteList.appendChild(option);
  });
  paletteInput.setAttribute("aria-activedescendant", "palette-option-" + paletteActive);
  const active = paletteList.querySelector('[aria-selected="true"]');
  if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  if (!paletteDialog.hidden) return;
  closeMenus();
  paletteReturnFocus = document.activeElement;
  paletteInput.value = "";
  paletteActive = 0;
  setLayerOpen(paletteDialog, true, { surface: palette });
  renderPalette();
  paletteInput.focus();
}

function closePalette({ restoreFocus = true } = {}) {
  if (paletteDialog.hidden) return;
  setLayerOpen(paletteDialog, false, { surface: palette, closeToken: "--modal-close-dur" });
  const back = /** @type {HTMLElement | null} */ (paletteReturnFocus);
  paletteReturnFocus = null;
  if (restoreFocus && back && typeof back.focus === "function" && back !== document.body) back.focus();
}

function togglePalette() {
  if (paletteDialog.hidden) openPalette();
  else closePalette();
}

// Closing comes first so a command that opens a menu or moves focus is not undone by the palette
// leaving; the run waits a tick so this click cannot reach the outside-click handlers that would
// close whatever the command just opened.
function runPaletteCommand(index) {
  const command = paletteMatches[index];
  if (!command) return;
  closePalette({ restoreFocus: false });
  setTimeout(command.run, 0);
}

paletteInput.addEventListener("input", () => {
  paletteActive = 0;
  renderPalette();
});
paletteInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!paletteMatches.length) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    paletteActive = (paletteActive + step + paletteMatches.length) % paletteMatches.length;
    renderPalette();
  } else if (event.key === "Enter") {
    event.preventDefault();
    runPaletteCommand(paletteActive);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePalette();
  } else if (event.key === "Tab") {
    // The palette is modal: focus stays in its search box.
    event.preventDefault();
  }
});
// mousedown keeps focus in the search box, so a click never blurs it mid-choice.
paletteList.addEventListener("mousedown", (event) => event.preventDefault());
paletteList.addEventListener("click", (event) => {
  const target = /** @type {Element | null} */ (event.target);
  const option = target && typeof target.closest === "function" ? target.closest(".palette-option") : null;
  if (option) runPaletteCommand(Number(/** @type {HTMLElement} */ (option).dataset.index));
});
paletteDialog.addEventListener("click", (event) => {
  if (event.target === paletteDialog) closePalette();
});
// Capture phase, like the mode hotkey: it works wherever focus is in the chrome. The artifact
// frame catches its own copy and asks for the palette with lavish:toggleCommandPalette.
document.addEventListener(
  "keydown",
  (event) => {
    if (!isCommandPaletteHotkeyEvent(event)) return;
    event.preventDefault();
    togglePalette();
  },
  true,
);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    // The media viewers sit above everything else, and focus can end up outside them (leaving
    // full screen hands it back to the page), so they close first from anywhere.
    if (!videoViewer.hidden) {
      closeVideoViewer();
    } else if (zoomView) {
      closeImageZoom();
    } else if (!whiteboardOverlay.hidden) {
      closeWhiteboard();
    } else if (!shareDialog.hidden) {
      closeShareDialog();
    } else if (revisionsDrawerOpen) {
      closeRevisionsDrawer({ restoreFocus: true });
    } else if (warningsDrawerOpen) {
      closeWarningsDrawer({ restoreFocus: true });
    } else if (!moreMenu.hidden) {
      closeMenus();
    } else if (sheetOpen && isDockLayout()) {
      setSheetOpen(false);
    } else {
      closeMenus();
    }
  }
});
// Capture phase so the mode hotkey fires no matter where focus is in the chrome - including
// mid-keystroke in chatInput or an annotation-card textarea - without disturbing normal typing.
document.addEventListener(
  "keydown",
  (event) => {
    if (!isModeToggleHotkeyEvent(event)) return;
    event.preventDefault();
    toggleAnnotationMode();
  },
  true,
);
frame.addEventListener("load", () => {
  if (artifactSpokeToken !== artifactLoadToken) armArtifactAvailabilityProbe(artifactLoadToken);
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation && !ended });
  postToFrame({ type: "lavish:theme", theme: effectiveTheme() });
  // Replay the pre-reload scroll position so hot reloads don't jump the artifact to the top.
  postToFrame({ type: "lavish:restoreScroll", x: lastScroll.x, y: lastScroll.y });
  if (lastReviewState) postToFrame({ type: "lavish:restoreReviewState", state: lastReviewState });
  postQueuedAnchors(true);
  if (overlayIndex !== null) {
    inlineWhiteboardChannels.delete(overlayIndex);
    postToFrame({ type: "lavish:suspendWhiteboard", diagramIndex: overlayIndex });
  }
});

initializeLayoutGate();

// WebSockets leave the browser's HTTP connection pool free for sends and artifact loads.
const events = new Map();
let eventReconnectDelayMs = 500;
function connectLiveEvents() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(protocol + "//" + location.host + "/events/" + encodeURIComponent(key));
  socket.addEventListener("open", () => {
    eventReconnectDelayMs = 500;
    liveEventFailures = 0;
    unreachableDismissed = false;
    if (unreachableBannerOwned) {
      unreachableBannerOwned = false;
      setChromeOutdated(false);
    }
    refreshLayoutWarnings();
  });
  socket.addEventListener("message", (message) => {
    try {
      const { type, data } = JSON.parse(message.data);
      return events.get(type)?.(data || {});
    } catch {
      // Ignore malformed frames; a later event or reconnect can recover the stream.
    }
  });
  socket.addEventListener("close", () => {
    liveEventFailures += 1;
    noteLiveEventsUnreachable();
    setTimeout(connectLiveEvents, eventReconnectDelayMs);
    eventReconnectDelayMs = Math.min(eventReconnectDelayMs * 2, 5000);
  });
}

// Raise the existing banner once the stream has been down long enough to mean it, and never
// against an ended session or a banner someone else owns. Reconnecting retires it.
function noteLiveEventsUnreachable() {
  if (liveEventFailures < LIVE_EVENT_UNREACHABLE_FAILURES) return;
  if (ended || unreachableDismissed || unreachableBannerOwned) return;
  if (outdatedBanner && !outdatedBanner.hidden) return;
  unreachableBannerOwned = true;
  setChromeOutdated(true, "");
}

events.set("reload", () => {
  resetFrame().then((reloaded) => {
    if (reloaded) refreshWhiteboardSource();
  });
});
events.set("chrome-reload", (data) => reloadAfterServerRestart(String(data.reason || "")));
// The replacement server serves a different artifact's review. This page keeps working against
// it; it is only running the previous version of the chrome, which is the user's to act on.
events.set("chrome-outdated", (data) => setChromeOutdated(true, String(data.reason || "")));
events.set("agent-reply", (data) => {
  const entry = {
    ...data,
    role: "agent",
    text: String(data.text || ""),
    ...(data.at ? { at: String(data.at) } : {}),
  };
  if (addChat(entry, true, { enter: true })) displayedChat.push(entry);
  noteAgentReply(entry.text);
});
events.set("chat-sync", (data) => {
  rememberChatAckIds(data.ack_ids);
  syncChat(data.chat || [], data.chat_revision);
});
events.set("agent-presence", (data) => setAgentPresence(data.mode === "external-listener" ? "external" : data.state));
events.set("layout-warnings", (data) => setLayoutWarnings(data.warnings || []));
events.set("ended", () => markSessionEnded());
connectLiveEvents();

applyChatLayout();
settleQueuedFromTranscript(initialChat, false);
render();
setChromeOutdated(false);
setWarningsDrawerOpen(false);
renderWarnings();
initialChat.forEach((item) => addChat(item));
retiredDrafts.forEach((text) => renderRetiredDraft(text));
setAgentPresence("waiting");
// The session already ended before this page (re)loaded, so there is no future live `ended` event
// to wait for - start read-only instead of looking live until a Send gets silently refused.
if (sessionData.initialEnded) markSessionEnded();

// Reaching this line is the only proof that this file parsed and ran to completion. The inline
// bootstrap already owns the gate's bounded escape if this script fails; retire only its separate
// boot-failure timer now that the full client has taken over.
const chromeBootWindow = /** @type {Record<string, any>} */ (/** @type {unknown} */ (window));
chromeBootWindow.__lavishChromeReady = true;
chromeBootWindow.__lavishCancelChromeBootFailsafe?.();
