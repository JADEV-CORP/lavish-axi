<!-- Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE. -->
<h1 align="center">lavish-axi</h1>
<p align="center">
  <a href="https://github.com/kunchenguid/lavish-axi/actions/workflows/ci.yml"
    ><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/lavish-axi/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/kunchenguid/lavish-axi/actions/workflows/release-please.yml"
    ><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/lavish-axi/release-please.yml?style=flat-square&label=release"
  /></a>
  <a href="https://www.npmjs.com/package/lavish-axi"
    ><img alt="npm" src="https://img.shields.io/npm/v/lavish-axi?style=flat-square"
  /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
    ><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img alt="X" src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img alt="Discord" src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

<h3 align="center">For when a rich editor is not rich enough.</h3>

<p align="center">
  <img alt="Lavish Editor demo" src="../lavish-editor-marketing/renders/lavish-editor-marketing.gif" width="960" />
</p>

> **Jadev fork.** This is Jadev's fork of lavish-axi, versioned `<upstream>-jadev.<n>`. Install, upgrade, and upstream sync are in [docs/jadev-fork.md](jadev-fork.md); `lavish-axi update` is disabled here because it would install the upstream npm release.

HTML is the new markdown. Lavish is the new editor for your HTML artifacts.

Agents are good at producing rich HTML artifacts, but the human-agent collaboration loop on such artifacts is lacking and falls back into screenshots and long responses for “tell me what to change.”
That loses the thing HTML is best at: interactivity.

Lavish Editor opens agent-generated HTML files in a local browser, lets you pinpoint elements and selected text, edit diagrams your agent authored as Mermaid whiteboards, and send feedback to the agent to address.

- **Local-first** - Review local HTML artifacts with a local CLI and no cloud dependency in the core feedback loop; hosted sharing through third-party ht-ml.app is explicit and opt-in.
- **Human-AI collaboration** - Annotate elements and selected text ranges, edit Mermaid whiteboard diagrams, and send messages to the agent without leaving Lavish Editor.
- **Battery included** - Lavish Editor teaches your agent good visualization for common use cases such as product or technical plans, design explorations and more out of the box.

Lavish Editor is an [AXI](https://axi.md), which means -

- It's just a CLI any capable agent can run without setup.
- It's optimized for agent ergonomics. TOON output, long polling, and contextual disclosure making it highly token efficient.
- The skill and hooks below only handle discovery; agents learn to use the AXI by using it.

## Quick Start

Install the Lavish skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add kunchenguid/lavish-axi --skill lavish
```

That is the entire setup - no npm install needed.
The skill teaches your agent to run Lavish through `npx -y lavish-axi`, so the CLI comes along on demand.
It stays a short stub and sends the agent to `npx -y lavish-axi --help`, `reply --help`, `design`, and `playbook` for current instructions, so an installed copy cannot go stale against a newer CLI.
Its frontmatter also includes Hermes Agent metadata, so Hermes-compatible harnesses can categorize and surface it as a first-class productivity skill.
This installs the public `lavish` skill.
The repository also contains an internal `lavish-design` brand skill for maintainers; default `npx skills add ... --list` and skills.sh discovery hide it unless `INSTALL_INTERNAL_SKILLS=1` is set.

Then, in agents that expose skills as slash commands (Claude Code, for example), invoke it directly:

```
/lavish let's discuss our plan here
```

Or just ask for anything that is easier to grasp visually - a plan, comparison, diagram, table, code view, or report - and the agent loads the skill on its own when it recognizes the task.

By default the skill lands in the current project's skills directory (`.claude/skills/`, for example); add `-g` to install it for all projects (`~/.claude/skills/`).

## Other Ways to Use Lavish

The skill is the recommended path, but it is not the only one.

### Zero setup

Lavish is an AXI, so any capable agent can run the CLI directly with nothing installed at all.
Just tell your agent:

```
Use `npx -y lavish-axi` to write a product or technical plan for what we discussed.
```

### Session hook

Want Lavish's ambient context - including your live open sessions - fed into every agent session instead of loading on demand?
Install the CLI globally and opt into the hook:

```sh
npm install -g lavish-axi
lavish-axi setup hooks
```

This installs a `SessionStart` hook for **Claude Code**, **Codex**, **OpenCode**, and **GitHub Copilot CLI** that surfaces open sessions, visualization playbooks, and usage guidance at the start of each session.
Unlike the skill, the hook also shows your live open sessions, so a fresh agent session can resume an in-flight review.
**Restart your agent session after running this** so the new hook takes effect.

### Agent Plugin

Lavish also ships as an [Agent Plugin](https://agent-plugins.org) - the vendor-neutral packaging standard for skills and MCP servers - so clients that speak that format can load it directly.

**No marketplace is involved.** The installed npm package _is_ the plugin: `plugin.json` sits at the package root next to the `skills/` directory, so whatever `npm install` already put on disk is a complete, conformant plugin. Install the CLI, then register it:

```sh
npm install -g lavish-axi
lavish-axi setup plugin
```

That registers the installed package with every supported client it finds - **VS Code**, **Cursor**, and **GitHub Copilot CLI** - and reports which ones were absent. It is opt-in and idempotent, and it repairs the registered path after a reinstall or relocation. Reload each client afterward.

Each client is registered independently: one that cannot be registered is reported with what to do about it, and never blocks the others or fails the command.

To register by hand instead, point any client at the package directory (`npm root -g`/`lavish-axi`):

| Client             | Register with                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| VS Code            | `"chat.pluginLocations": { "<package-dir>": true }` in user settings                                               |
| Cursor             | link the package dir at `~/.cursor/plugins/local/lavish-axi` (`setup plugin` handles Windows link compatibility)   |
| GitHub Copilot CLI | `copilot plugin install <package-dir>` (or `copilot plugin install kunchenguid/lavish-axi` straight from the repo) |

Codex and ChatGPT install plugins only from marketplace sources, so Codex users should use the session hook above instead.
Lavish declares no MCP server - the CLI itself is the agent interface - so a plugin install brings the same `lavish` skill, and the skill and plugin are alternatives rather than a stack.

### From source

```sh
git clone https://github.com/kunchenguid/lavish-axi.git
cd lavish-axi
pnpm install --frozen-lockfile
pnpm run build
pnpm link
```

## How It Works

```
┌───────────────┐
│ Agent writes  │
│ artifact.html │
└───────┬───────┘
        ▼
┌────────────────────────┐
│ lavish-axi <file_path> │
│ opens local browser UI │
└───────┬────────────────┘
        ▼
┌────────────────────────┐
│ Human annotates text   │
│ or elements, sends     │
│ chat, or queues layout │
│ issues from the inbox  │
└───────┬────────────────┘
        ▼
┌────────────────────────┐
│ lavish-axi poll waits  │
│ and returns prompts    │
│ the user queued        │
└────────────────────────┘
```

- **File-path identity** - Sessions are keyed by the canonical HTML file path, so agents do not need opaque IDs.
- **Portable artifacts** - The artifact runs in a sandboxed iframe while Lavish injects a small SDK for annotations, snapshots, feedback controls, and render-time layout checks.
  Author-defined links and popups can open in top-level tabs, while artifact documents remain sandboxed without same-origin access.
  Lavish does not inject any design system, so the saved HTML file renders identically whether you open it through `lavish-axi` or directly in a browser.
  Run `lavish-axi design` for the single source of agent-facing design guidance, including the CDN snippet and the whiteboard (Mermaid) opt-in snippet. Unless the user asks for a look, artifacts use the Lavish design, starting from the page `lavish-axi design --template` prints: DaisyUI with an inline `lavish-auto` theme that follows the editor's light or dark mode and theme preset (or the OS when opened on its own; `lavish` / `lavish-dark` pin one side), with a product's own design system kept to any screen that mocks that product.
- **Self-paint warning** - `lavish-axi <html-file>`, `export`, and `share` run a render-free check for artifacts missing an explicit page background and return a one-line `self_paint_warning`.
  The check fails open - any stylesheet link, `@import`, Tailwind runtime script, `color-scheme`, or `html`/`body`/`:root` background signal suppresses it - and it never blocks the open.
- **Open-time layout gate** - The browser chrome masks an artifact only while the real in-iframe audit waits for fonts and final geometry.
  The first completed client-side check reveals the artifact, whatever it found and even if reporting that check to the server fails; the gate never holds the review hostage waiting for a repair or a network round-trip.
  The user can click **Show anyway**, and a bounded safety timeout fails open from every gate state.
  If the review cannot load at all - the chrome's own script never runs, or the server does not answer the artifact's load request after several retries - the mask names the problem and offers **Check and reload** without removing the independent **Show anyway** escape.
  A review already loaded in another browser tab is named the same way, with a **Take over here** button that loads the artifact in the current tab, because Lavish loads an artifact in one tab at a time. The takeover warning reads "Unsent answers stay in the tab or window where you entered them; taking over in another window does not bring them along."
- **Layout issues inbox** - Detection is passive. After fonts and finite animations settle, the injected SDK confirms severe failures from direct rendered evidence such as materially escaped meaningful content or required controls, clipped text fragments, viewport reachability, or near-total semantic occlusion.
  Explicit ellipsis and line clamp, standard visually hidden accessibility text, intentional scrollers or masks, parent overhang, generic element scroll geometry, decorative overlap, and uncertain motion do not produce findings by themselves.
  Proven failures are filed in a **Layout issues** button in the top bar, which is hidden while nothing is unresolved and otherwise shows the unresolved count.
  Its drawer lists each issue with severity, a plain-language explanation, the affected viewport, the target/component identity, when it was last seen, and its lifecycle state, plus per-issue **Reveal** (highlight it in the artifact) and **Dismiss** actions.
  Nothing is selected by default. The user picks issues (or **Select all**) and **Queue selected fixes** turns that whole group into one ordinary queued prompt, tagged `layout-warnings`, that reaches the agent through the normal feedback path when they send.
  Detection never returns `lavish-axi poll` and never wakes an agent; only the user queueing a fix does. The one exception is a fatal `artifact_failures` response, for failures that make the review itself unusable, such as the artifact document or one of its own local assets failing to load.
- **Layout issue lifecycle** - Each issue is identified by a stable fingerprint of the diagnostic rule, the normalized target identity, and the viewport class, so repeat detections update one record instead of inflating the count.
  `Open` means the latest completed check for its viewport still detects it. `Queued for fix` means the user asked for a repair - it stays unresolved and counted, and cannot be queued again while that request is outstanding.
  `Resolved` requires a newer successful artifact load plus a complete check at the same viewport that no longer detects it; it then leaves the count but keeps a bounded history.
  `Still present` (recurring) means a queued issue survived a newer revision, so it is selectable again with its earlier attempt retained. `Unverified` means a reload or check failed or was incomplete, so the prior issue was preserved rather than cleared. `Returned` means a resolved issue came back on a later revision.
  Dismissal applies only to the current artifact revision; a later revision surfaces the issue again if it is still detected. A check at one viewport never clears an issue found at another, and a viewport removed from the configured diagnostic set (`LAVISH_AXI_DIAGNOSTIC_VIEWPORTS`, default all) is marked obsolete with an explicit reason rather than reading as fixed.
- **Picture preview** - Any picture can be inspected up close: a chat or composer thumbnail, and in the artifact an `<img>` or inline SVG (diagrams keep their own pan and zoom). In explore mode, click the picture; in either mode, hover it and press the zoom button on its corner. A picture inside a link to a picture file (`<a href="shot.png"><img></a>`, with or without `target="_blank"`) opens the linked file in the preview instead of leaving the page; a picture that links to a web page, or a download link, keeps its click. It opens over a blurred backdrop, gliding from where it sat, in the style of the Kibo UI Image Zoom component for shadcn/ui. Then the scroll wheel or a pinch zooms around the pointer up to 1600%, dragging pans, double-click switches between fit and close-up, and the toolbar has zoom out, zoom in, Fit, and 1:1. Past 300%, raster images show their real pixels instead of smoothing them; SVG stays sharp at every level. Previous and next buttons on the side edges, with a position such as 2 / 5 in the toolbar, step through the pictures from the same place: the artifact's pictures in page order, or the conversation's thumbnails. They stop at either end.
- **Video** - Hover a video in the artifact and press the maximize button on its corner to play it large over the editor, picking up at the same moment with the same mute and loop settings. **Full screen** (or F) in that view hands it to the browser's full screen, and closing it returns the position to the video in the artifact. A stream that cannot leave the artifact (a `blob:` or MediaSource video) goes straight to full screen instead, and every video's own full-screen control works too.
- **Revisions legend** - Opt-in. After a round of feedback the agent regenerates the whole file, and a one-sentence edit is invisible on a long artifact. The agent can declare what it changed in the artifact itself: one `<script type="application/json" data-lavish-revisions>` array of `{ id, label, timestamp, summary }` entries, plus `data-lavish-revision="<id>"` on each block it edited or added. Run `lavish-axi design` for the snippet.
  A **Revisions** button then appears in the top bar with a legend listing each round - colour swatch, label, time, and the agent's summary - and **Reveal** steps through that round's changed blocks, flashing them one at a time. **Outline** draws a dashed outline with the round's id around every block it changed, one round at a time, until you press it again; the outline is drawn over the page, never written into it.
  An agent reply is stamped with the newest revision the artifact declared when the agent replied, and gets a **View r3**-style button that steps through that round's blocks the same way. The button shows only while the artifact on screen still lists that round.
  Each revision's swatch carries a distinct border style and fill pattern as well as a colour, so the rounds stay distinguishable without colour. Artifacts with no registry show no button and are otherwise unaffected, a malformed registry is ignored rather than surfaced as an error, and at most 6 revisions are listed - one per distinguishable swatch.
  Lavish never marks up the artifact for this: the legend lives in the browser chrome, so the served page stays identical to the saved file, and the registry and marks travel with the file through export.
- **Live tab title and icon** - Opt-in. The browser tab adopts the artifact's `<title>` and first `<link rel="icon">` when it loads. A long-lived artifact can keep the tab current afterwards with `window.lavish.setDocumentMeta({ title, icon })`: a string sets the field (a title that is blank after trimming restores the load-time title), `null` restores the load-time value, and an omitted field is left alone. The title is trimmed to 120 characters and shown as `<title> · Lavish`; the icon must be a `data:image/svg+xml` URL of at most 8192 characters. Anything else is ignored. A value stays until the next call or until the tab itself reloads, so call again after each page update. The call is a no-op when the page is not open in Lavish, so feature-detect with `window.lavish?.setDocumentMeta?.(...)`.
- **Local assets** - Copy local images, CSS, fonts, and scripts next to the HTML artifact and reference them with relative paths from that directory; root-prefixed paths such as `/assets/logo.png` will not resolve through Lavish's artifact route.
- **Export and sharing** - `lavish-axi export` writes `<name>.export.html` by inlining local assets only, stripping the annotation SDK, and leaving remote CDN/font references as links that still need network access.
  `lavish-axi share` publishes the same local-inlined HTML to [ht-ml.app](https://ht-ml.app), a third-party hosting service not part of Lavish.
  Publishing sends the artifact to ht-ml.app's servers, public by default, or private and password-protected with `--private` (Lavish generates the password and returns it once, in the command output and in the browser publish dialog) or `--password <pw>` (one you supply, never echoed back). A generated password is a shared secret: give it to whoever should read the page, and expect it to appear in your agent's transcript, because the agent has to relay it. Lavish does not store it.
  The response includes a secret `update_key` shown once. Keep it to republish the same URL later with `--site <site_id> --update-key <key>`, which replaces the HTML in place and leaves the password alone unless you pass `--private` (rotate to a new generated one) or `--password <pw>` (set one). Locking a page that was public is not instant - it can keep answering from ht-ml.app's CDN cache for minutes after the password is set - while a page that was already private has no such cached copy.
  A page's password cannot be removed: ht-ml.app accepts a request to clear one and silently ignores it, so Lavish offers no way to make a private page public rather than telling you it did something the host did not do. Republish as a new page if you need a public URL.
  ht-ml.app has no delete endpoint, so `--unpublish --site <site_id> --update-key <key>` replaces the page with a short placeholder and locks it behind a discarded random password rather than removing it: the URL still resolves and the host still holds what was published. The content swap is immediate, but the lock is not: a page that was public can keep serving the placeholder to uncredentialed visitors from ht-ml.app's CDN cache for minutes afterwards. The `update_key` plus `--private` republishes real content behind a new password you can share.
  Bundling never fetches remote URLs, Lavish itself does not set a CSP, local reads stay confined and size-capped, and absolute `file://` paths outside safe inlined asset references are redacted before output.
  Per-asset and per-bundle inline caps default to 10 MB and 25 MB, overridable with `LAVISH_AXI_EXPORT_MAX_ASSET_BYTES` and `LAVISH_AXI_EXPORT_MAX_BUNDLE_BYTES`.
  Unresolved local assets or export notices such as author-set CSP meta tags and redacted file URLs are surfaced in command or browser output.
  Use `--token` or `LAVISH_AXI_HTML_APP_TOKEN` for an optional bearer token when publishing a new page (a republish or `--unpublish` authorizes with the `update_key` instead and rejects `--token`); set `LAVISH_AXI_HTML_APP_API_URL` to override the ht-ml.app API base and point `share` at a backend you control (see [Self-hosting the share backend](docs/self-hosting-share.md) for the contract it must implement).
- **Live reload** - Lavish watches the HTML artifact file by default and preserves review context across reloads: the artifact iframe scroll position, an open annotation card's unsent text, and answers to `data-lavish-question` controls (application-owned form state is left alone). Supported review state and the unsent queue are saved in that tab's `sessionStorage` and survive a full reload of the review page in the same tab when browser storage is available. They are not shared with another tab or window; closing the owning tab can lose work that has not been sent. While a queued layout-issue batch is outstanding, closely spaced saves coalesce so one batch of fixes costs one refresh. To also reload on sibling asset changes, add `data-lavish-live-reload-root` to the root element or `<meta name="lavish-live-reload" content="root">`.
  If the element an unsent annotation was attached to is gone from the artifact for good, Lavish cannot reopen that card, and if the artifact replaces a queued note while you are editing it, the replacement is kept as the artifact sent it. Either way, Lavish writes your edited text into the conversation panel under **Unsent annotation** - selectable, never written over anything you have typed, and kept there across reloads; no note is ever dropped to make room for a newer one, and a note the browser refuses to store says so where it is shown.
- **Feedback controls** - Native controls (radios, checkboxes, inputs, selects, buttons, labels, disclosure summaries, contenteditable) and custom widgets with an interactive ARIA role (`button`, `checkbox`, `combobox`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `option`, `radio`, `switch`, `tab`, `treeitem`) are interactive automatically, so they do not need `data-lavish-action`. A link (`<a href>`) stays annotatable when it carries one of these roles or sits inside such a widget.
  Artifacts can start in explore mode with `data-lavish-annotate="off"` on the root `<html>` element so stray clicks do not open annotation cards. Annotation stays on by default (or with `"on"`); unknown values default to on. The toolbar reflects the page default and can override it; the reviewer's choice persists across artifact reloads within that review page. See `lavish-axi playbook input` for author guidance.
  For reversible choices, let option clicks update local state, then queue exactly one final answer from a per-question submit or Queue answer button with `window.lavish.queuePrompt()`.
  An artifact can offer one-click replies with `window.lavish.suggest(["Approve", "Show option B"])`: up to six short strings appear above the composer, a click fills the text box without sending, and the row steps aside while you have a draft. Calling it again replaces the set, and an empty list clears it.
  If someone may open a decision artifact as a standalone HTML file, `lavish-axi playbook input` provides an optional Copy all answers control they can use to paste their form answers back into chat.
  Mark only custom (non-native) clickable elements with `data-lavish-action` so Lavish does not annotate them, and use `data-lavish-question` or `queueKey` when pre-send updates for the same question should replace each other.
  Everything you send is part of the conversation: a note on an element, a text selection, a table cell, a diagram node, a whiteboard, a layout-issue batch, or a composer message each becomes a bubble on your side of the Conversation panel, with an anchor line naming what it was attached to (the element tag, text selection, table cell, diagram node, whiteboard, or layout issues), a quoted excerpt, and, when available, the selector on hover. A note you have queued but not sent waits in the **Queued** list above the message box, with a count, its anchor, and a remove control; the list collapses to its header. **Queue** (or Ctrl+Q) adds what you typed to that list without sending, and **Send** counts what it will deliver ("Send 3"). A note on an element is numbered, and the artifact shows a pin with the same number on that element; pointing at the note outlines its element. To talk about several blocks in one message, choose **Add to message** on each annotation card instead of **Queue**: each block waits in the message box as a numbered chip, with a pin of the same number on the artifact, and pointing at a chip outlines its block. Write the message using those numbers ("make [1] match [2]"). When an artifact's own control queues an answer (a form's Queue this answer button, say), a Queued check draws in beside that control once the answer is in the queue. On Send or Queue, the marks and the message are one item: one row in the **Queued** list and one sent message with the numbered chips above its words. The agent gets the words with a `marks` target listing each mark's number, selector, and the words typed on its card. A pin's number is fixed once given, so removing a note never renumbers the `[n]` you wrote. Clicking a queued note opens its words in the message box for editing, with whatever you were typing set aside until you finish, and scrolls the artifact to the element it points at; clicking that element again in annotate mode opens the same note rather than a fresh card. Enter saves the edit and Escape or **Cancel** drops it; saving a note with no words and no images removes it, and **Send** delivers an open edit as typed. While its batch is in flight it reads **Sending** and can no longer be edited, and once the server accepts it, it settles in place as a sent bubble in every tab of the session. The panel keeps the newest stored transcript up to 5 MiB; older bubbles drop from view, but an accepted note still settles and is not sent twice. Agent replies render a small Markdown subset - paragraphs, line breaks, headings as bold lead lines, bullet and numbered lists, fenced and inline code, bold, italic, and http(s) links - while tables, images, and raw HTML stay as the text the agent wrote; your own messages keep their line breaks and are never parsed. A reply can end with `## What I changed`, `## Files touched`, and `## Reasoning` sections (those exact headings, outside code blocks); each shows as a collapsed block under the reply, and a reply without them renders as before.
  On wider screens, the conversation and the queued notes share one scrollable Conversation panel above a sticky composer, so long feedback queues do not push the text box or send controls off screen.
  The browser chrome keeps editing actions in the overflow menu (copy path, reload artifact, copy DOM snapshot, export standalone HTML, publish link, end session), while the chevron beside the composer's **Send** opens **Send and end session** to submit queued prompts and user-ended attribution together. Once **Send and end session** starts, Lavish pauses new feedback, waits up to 5 seconds for feedback preparation already underway, keeps any open annotation draft intact until delivery succeeds, then holds that exact terminal batch. A completed reservation survives a page reload, including when its prompts were already delivered and only the pending end remains; incomplete preparation is not restored. If preparation times out, Lavish keeps the review open and its existing queue editable with a visible error. A transient delivery failure permits only retrying the same terminal batch through **Send and end session** until it succeeds. If a snapshot makes the request too large (HTTP 413), Lavish retries that exact batch once without the optional snapshot. An actionable attachment rejection (HTTP 400), recoverable layout-selection conflict (HTTP 409), or unrecoverable 413 instead cancels the terminal reservation without ending the session, keeps the prompts queued, and restores editing, removal, **Send to Agent**, **Send & End**, and **End session** so the reviewer can revise or remove stale feedback before submitting again.
  Unsent queued notes belong to the tab where you entered them, not to a server-shared draft. An empty **Send** reports "Nothing queued in this tab." followed by the same message: "Unsent answers stay in the tab or window where you entered them; taking over in another window does not bring them along." Annotate mode alone does not queue a note, so use the annotation card's **Queue** action first. Only feedback accepted by **Send** is stored on the server for delivery to the agent.
  Composer feedback is visibly queued before the text box clears and stays queued until acknowledged. Send waits up to 5 seconds for the artifact's DOM snapshot, then delivers without that optional context if the frame no longer answers; a late snapshot cannot submit the batch twice. A failed or still-unacknowledged POST keeps the queue and shows persistent recovery guidance unless a transcript sync proves the server already accepted that feedback.
- **Starting mode** - Pages open in Annotate. **Open pages in Interact** in the More menu (or the command palette) makes every page open in Interact instead, and switches the page you are on; it is remembered in this browser (`lavish-axi:start-mode`).
- **Notifications** - While the Lavish tab is in the background, an agent reply, a page update, or the agent staying away from its poll for 30 seconds adds a count to the tab title, marks the tab icon with an accent dot, plays a soft chime, and, once you allow it with **Allow desktop notifications** in the More menu, shows a desktop notification that brings the tab forward when clicked. Tabs and notifications name the review by the artifact `<title>`, or by its folder and file name (`billing-flow/review.html`) when it has none; a notification never carries the full path. Coming back to the tab clears the count and the dot. **Notifications** in the More menu turns all of it off for this browser (`lavish-axi:notifications`), and the note under it says why desktop notifications can or cannot appear. Browsers allow them only on a secure address: a review opened over plain http on a Tailscale or LAN name gets the chime and the tab marker, and on the computer running Lavish the menu offers **Open at 127.0.0.1** to reopen the same review where they can be allowed. Once allowed, **Send a test notification** checks that your system shows them. The chime can play only after you have clicked or typed in the page once, as browsers require.
- **Newer Jadev version** - The server checks the fork's repository every few hours; when a newer version is out, an **Update** button in the top bar shows it with the install steps (see docs/jadev-fork.md).
- **Layout and theme** - On wider screens the Conversation panel sits on the left by default. The layout switch in the top bar moves it to the right, collapses it to a narrow rail (which shows a dot when a reply lands), or floats it over the bottom of the artifact as **Peek**, a dock with a live composer that opens to the full conversation. Drag the panel's inner edge to resize it between 280 and 560 pixels (never more than 60% of the window); double-click resets it, and the edge also takes arrow keys, Home, and End. The theme follows your system's light or dark setting until you pick one with the top-bar toggle; **Follow system theme** in the overflow menu hands it back. Layout and theme are personal preferences: they apply to every session in this browser and land before the page first paints. The top bar also says whether your agent is listening, working, or not connected, so you know whether a send reaches anyone right now.
- **Reviewing on a phone** - Below 860px wide, the artifact takes the whole screen above a **Conversation** dock, and the conversation opens as a bottom sheet over it: tap the dock, swipe it up, or press the chevron to raise it; tap the dimmed artifact, swipe the sheet down, press the chevron, or press Escape to lower it. The dock reports what matters while the sheet is down - how many prompts are queued, a reply that arrived while you were reading, or whether the agent is listening - and the sheet stays open across a reload of the review page. The sheet sizes itself to the visible viewport and respects safe-area insets; if the keyboard or attachments leave little room, conversation content yields or scrolls while the send actions remain pinned above the bottom edge. In landscape the sheet covers the top bar as well. Wider screens keep the side-by-side layout.
- **Composer** - The message box is a rich text editor (TipTap, as in T3 Code). Markdown is recognised as you type: `**bold**`, `*italic*`, `` `code` ``, `- ` and `1. ` lists, `## ` headings, `> ` quotes and ` ``` ` code blocks; a typed or pasted URL becomes a link. A pasted, dropped or attached picture appears as an inline chip, Image 1, Image 2, ..., where the cursor was, numbered like the attachment list above the text; hovering a chip shows the picture, and deleting a chip removes the picture. Typing `@` offers the blocks marked for this message (Mark 1, ...) and the attached pictures. The agent receives the message as Markdown, with each chip written in place as `[Image 1]` or `[Mark 1]`, and plain text as typed. If the editor bundle cannot load, the composer is a plain text box.
- **Find in the page** - Ctrl+F (Cmd+F on macOS), pressed anywhere in the editor or the page, opens a find bar over the artifact that searches its visible text: matches are marked without changing the page (the current one in orange), Enter and Shift+Enter (or F3 and Shift+F3) step through them with a count such as 2 of 5, a reloaded page is searched again, and Escape closes the bar and clears the marks. It is also in the command palette.
- **Keyboard shortcuts** - In the chrome composer, Enter sends queued prompts and Shift+Enter starts a new line (the next item in a list).
  In the annotation card, Enter queues the annotation, Shift+Enter inserts a newline, and Ctrl+Enter (Cmd+Enter on macOS) queues it and sends all queued prompts immediately. Escape closes the card, same as Cancel, but only while it is empty (no text, no attachment); with unsent text or an attachment present, Escape does nothing rather than risk discarding it.
  While editing a queued note, Enter saves it, Shift+Enter inserts a newline, and Escape discards the edit.
  Cmd+I or Ctrl+I toggles between annotate and explore mode from either the browser chrome or the artifact iframe, including while focus is in a textarea or control.
  In the picture preview, + and - zoom, 0 fits, 1 shows actual size, the arrow keys pan, and Escape closes it. When the picture belongs to a set of several, Left and Right step to the previous and next picture while it fits the screen; zoomed in, they pan. In the maximized video, F toggles full screen and Escape closes it.
  Cmd+K or Ctrl+K opens the command palette from either the chrome or the artifact: type to filter, arrow keys to move, Enter to run, Escape to close. It lists the layout, theme, annotate, artifact, publish, and session actions the chrome offers at that moment.
  In annotate mode a plain click on a link annotates it; Ctrl+click (Cmd+click on macOS) follows the link instead, opening it in a new tab as the browser normally would, without leaving annotate mode. Off macOS, Meta+click annotates like a plain click.
- **Agent presence** - The browser shows when no agent is listening and keeps human feedback actions available while the agent is working. Feedback accepted by **Send** is queued on the server for the next successful `lavish-axi poll` delivery even across reloads; never-sent notes remain in the originating tab. An agent reply concludes delivered work and returns presence to waiting (see the CLI Reference for reply and poll commands). A supervisor-owned process listener is shown as an external listener rather than an idle captain turn.
- **Delivery receipts** - Every note you have sent carries three icons under it that light up in turn: an eye for **Seen** when a `lavish-axi poll` takes the note, a wrench for **Working** when the artifact file changes after that, and a check for **Done** when the agent replies. A step that has not happened yet is the same icon greyed out. All three come from what the server observes; the agent does nothing extra. Until 👀 lights, the row says why: no agent is listening, or the agent is busy and the note is delivered on its next poll. A note answered without touching the artifact goes Seen to Done with Working still grey. A reply marks every note the agent has seen as Done, not notes still waiting for a poll. Each emoji names its step and time on hover and to screen readers. Notes sent before receipts existed show no receipt row.
  In a Herdr-managed pane, set `LAVISH_AXI_HERDR_CHIME=1` to show a Herdr request notification and play its chime once an indefinite poll enters the waiting state. Immediate queued feedback and timed debug polls do not trigger a notification. The integration is off unless both `LAVISH_AXI_HERDR_CHIME` and Herdr's `HERDR_ENV` session marker equal `1`; leaving either unset or using any other value opts out. Notification delivery runs without blocking feedback: if Herdr is unavailable, rejects the notification, stalls, or fails, the poll continues unchanged.
  Closing the last review tab while a poll is active starts a reconnect grace period, 10 seconds by default. A reload or quick reconnect keeps an active poll waiting; if every review stays disconnected, the poll returns `browser_disconnected` without ending the resumable session, and the agent asks whether to reopen or end it instead of acting uninvited.
  A phone that locks its screen or backgrounds the tab drops the connection too, so set `LAVISH_AXI_DISCONNECT_GRACE_MS` on the server to a longer millisecond budget, or to `0` or `off` so a disconnect never ends the poll (it then waits for feedback, an end, or its own timeout). Empty or invalid values keep the 10-second default.
  The no-timeout poll always writes an immediate stderr banner so it is visibly not hung; it adds the periodic stderr wait ticks only in an interactive terminal, so when stderr is piped (as under agent harnesses) the captured output carries no tick noise. Stdout always stays reserved for the final response; if the poll is interrupted or times out before feedback arrives, re-run it because feedback remains queued until delivery. Poll delivery consumes the response, so read the complete response before truncating or filtering it.
  Codex-specific guidance keeps that poll attached to the active turn instead of hiding it in a background task, because completed background tasks may not resume the agent.
- **Session end etiquette** - Lavish tracks who ended a session: a human clicking **End session** (or **Send and end session**) in the browser is a user-initiated end, while `lavish-axi end <html-file>` is agent-initiated.
  When either side ends the session, every open review tab becomes visibly read-only and disables its feedback controls; feedback submitted after the end is refused instead of being accepted without an agent to receive it.
  A plain `lavish-axi <html-file>` after a user-initiated end refuses to reopen the browser and returns guidance instead; pass `--reopen` only when the user asks for further review or something important needs their visual attention.
  Agent-initiated ends keep reopening normally, same as before.
  `lavish-axi poll`'s `ended` response and the `feedback` response for the final batch before an end both carry `next_step` guidance telling the agent to stop polling and deliver remaining updates in chat instead of reopening.
- **Precise targets** - Text annotations include selected text plus range anchors, and text selections carry those anchors only.
  Clicking an element inside a table also carries the cell's visible row and column names alongside the exact CSS locator, so filtered or sorted rows do not make feedback look misdirected.
  When merged cells make either name ambiguous, Lavish leaves that name out rather than guessing; an explicit `<th scope="row">` remains authoritative even when a `rowspan` makes the row's position ambiguous.
  The CSS locator still points at the exact element you clicked, so an annotation with an omitted name is only less descriptive, never mislabelled.
- **Image attachments** - Attach reference images (PNG, JPEG, WebP) in either the Conversation composer or an annotation card by pasting, drag-dropping, or using its image picker; each image shows a thumbnail chip with upload, remove, retry, and error states. If a sent image is later evicted under the attachment storage limits, its transcript-history thumbnail becomes an **Image expired** placeholder.
  A paste containing both text and images preserves the text while attaching the images (a copied file's own name or path is treated as placeholder and not pasted). Conversation messages may contain text and images together or images only.
  Images are stored under the state dir and the queued prompt carries a server-generated absolute `path` and content-hash `id` (plus mime and dimensions) - never the raw bytes - so `lavish-axi poll` hands the agent a local file path to open.
  Limits are `LAVISH_AXI_MAX_ATTACHMENT_BYTES` (default 10 MiB per image), `LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT` (default 20), and `LAVISH_AXI_MAX_PROMPT_ATTACHMENT_BYTES` (default 100 MiB per prompt); if any image is missing or any prompt breaches a count or byte cap, the entire send batch is rejected, the queue is preserved, and the reason is surfaced in the composer rather than silently dropping images.
  As a browser-side abuse guard, each chrome page allows 30 upload attempts per rolling minute, 4 uploads in flight at once, and 256 MiB of attempted image bytes over its lifetime; rejected uploads stay visible for retry or removal.
  Unreferenced attachments expire after `LAVISH_AXI_ATTACHMENT_TTL_MS` (default 7 days; `0`/`off` disables); `LAVISH_AXI_MAX_ATTACHMENT_DISK_MB` (default 512 MiB; `0`/`off` disables) caps total attachment disk and may evict older unreferenced images sooner.
  The cap is enforced when an image is uploaded, not just periodically: the upload first reclaims unreferenced files (oldest first, and never one added within the last hour), and if it still would not fit, that upload is refused with a storage-full error on its chip instead of discarding an image the user is about to send.
- **Mermaid diagrams** - Whiteboards are an opt-in: agents author a diagram as Mermaid only when you ask for an editable whiteboard, and hand-authored inline SVG illustrations are the default figure medium otherwise.
  In the Lavish browser, every rendered Mermaid diagram in a `.mermaid` container becomes an embedded editable Excalidraw whiteboard.
  Click a diagram to unlock editing, and use its Fullscreen action to edit it over the whole viewport.
  Whiteboard scenes autosave locally.
  If a live reload changes the Mermaid source, an unmodified whiteboard silently re-converts to the new diagram. If the reviewer had edited the scene, reopening it lets them re-convert and discard the saved edits or keep editing the saved scene.
  Use **Queue feedback** to add a bounded edit summary plus local `.excalidraw` scene and PNG preview paths to the Conversation panel, then click **Send** to deliver it.
  The agent updates the artifact's Mermaid source, which remains authoritative.
  Flowchart, sequence, class, ER, and state diagrams convert to editable shapes; other diagram types are images that reviewers can draw and annotate.
  Lavish changes only the browser view, so saved, standalone, and exported artifacts still render plain Mermaid.
- **Whiteboard libraries** - Copy Excalidraw library files (`.excalidrawlib`, for example from [libraries.excalidraw.com](https://libraries.excalidraw.com)) into `~/.lavish-axi/excalidraw-libraries/`, or `LAVISH_AXI_STATE_DIR/excalidraw-libraries/` when set. Every whiteboard's library panel lists their items, and an item you drop on the canvas reaches the agent by name in the edit summary.
  Agents run `lavish-axi libraries` to find item refs and can show a flowchart node as one of those icons by adding a `%% lavish-icon <node-id> <library-id>/<item name>` comment to the Mermaid source. Mermaid ignores the comment, so saved, exported, and shared copies, and whiteboards missing that library, show the plain node.
  Lavish only reads that directory and never downloads libraries. Files over 10 MB, more than 25 MB or 5,000 items in total, and unreadable files are skipped; `lavish-axi libraries` lists each skip with its reason.
  Each library carries its author's terms (AWS Architecture Icons, for example, are covered by AWS's own usage terms), so check them before using one.
- **Server cleanup** - The detached server stops after the last session ends when nothing is connected, or after `LAVISH_AXI_IDLE_TIMEOUT_MS` (default 30 minutes) with no browser or poll connections.
  Set `LAVISH_AXI_IDLE_TIMEOUT_MS=0` or `off` to disable idle self-shutdown.
- **Server upgrades** - One background server serves every session, so upgrading `lavish-axi` while reviews are open makes the next `lavish-axi <html-file>` replace that server. Only a newer CLI replaces an older server: a CLI older than the running server uses it as is, so two installed versions on one machine do not restart each other's server. Releases up to and including 0.1.86 still replace a server of a different version, so this turn-by-turn restart stops only when both installed versions contain this fix. Only the review page for the artifact being opened reloads itself once the replacement answers - and not even that one while you have unsent annotation text open, which gets the same banner instead so the reload is yours to make. Every other open review page keeps working and shows a banner reading "Lavish was updated. This page is running the previous version.", with a Check and reload button and a Dismiss button, so no page you are reading reloads on its own. After `lavish-axi stop` those pages say Lavish was stopped and to reload after you start it again, and a restart that only picks up a local build says that rather than claiming an update. An open review page whose server simply goes away - idle self-shutdown, a crash, a machine that slept - shows that same banner once reconnecting has failed for a few seconds, rather than retrying a dead server silently while looking fine; it clears itself if the server comes back, and dismissing it keeps it dismissed until then.
  A page still using the legacy event stream reloads once when it reconnects to the replacement server, moving itself onto the current transport without retaining an HTTP connection. If unsent annotation text is open, it shows the neutral server-restarted banner instead and waits for you to reload.
  Every **Check and reload** control asks the server whether it is running before it navigates; while nothing answers, the page stays where it is and says so, and a check that gets no answer at all says that instead of guessing.
  In-flight `lavish-axi poll` commands end with an interrupted-poll error and are safe to re-run; server-accepted feedback remains queued until delivery, while never-sent notes and supported annotation drafts survive a same-tab reload as described under **Live reload**.
  A page waits for the replacement rather than reloading into a port nothing is listening on, and tells the user to restart Lavish if it never returns.
- **Local-first state** - Session state stays under `~/.lavish-axi/` by default, or `LAVISH_AXI_STATE_DIR` when set.
- **Diagnostic viewports** - `LAVISH_AXI_DIAGNOSTIC_VIEWPORTS` sets which viewport classes the layout-issue inbox tracks (`mobile`, `compact`, `desktop`; comma-separated, default all). Warnings whose class leaves the set are marked obsolete with an explicit reason instead of silently reading as fixed.
- **Server port** - Set `LAVISH_AXI_PORT` to choose the server port; it defaults to `4387`.
- **Network binding** - With Tailscale running, the review server automatically listens only on loopback (`127.0.0.1`) and this machine's Tailscale IPv4 address - never on `0.0.0.0` or every interface. The generated session link uses the machine's MagicDNS name, so it is the phone-ready URL to open from another device on the same tailnet. When Tailscale is absent or down, Lavish silently falls back to loopback-only and prints no phone URL. If Tailscale is running but MagicDNS is unavailable, Lavish visibly warns that phone access is unavailable and remains loopback-only. Binding beyond loopback exposes an unauthenticated server that can read and serve arbitrary local files to devices that can reach it, so the tailnet should be trusted. Any explicit `LAVISH_AXI_HOST` overrides automatic Tailscale binding; wildcard values are restricted to loopback, while a non-wildcard value selects that concrete bind address, and the server listens on loopback as well so every local CLI finds it whatever its own `LAVISH_AXI_HOST` says. An address that cannot be bound - the tailnet address while another process holds it, while Tailscale restarts, or an explicit hostname that temporarily does not resolve - is reported as `network_warning` in `lavish-axi <file>` output and logged to `server.log`; session links point at loopback meanwhile unless `LAVISH_AXI_LINK_HOST` overrides them, and the server keeps retrying that address in the background and immediately on the next CLI invocation. Once it binds, the warning clears and new session links use it again, with no restart. If no listener can bind, startup fails rather than claiming a reachable server. `LAVISH_AXI_LINK_HOST` controls the link host when automatic Tailscale binding is disabled.
- **One server per port** - Agents on one machine can run with different `LAVISH_AXI_HOST` settings, or none, and still share one server: before starting one, the CLI looks for a running server on its configured host, loopback, and every other local address. A running server that was never asked to listen on the address a CLI's `LAVISH_AXI_HOST` names is replaced once by a server that listens on that address plus every address the old one served, keeping all sessions. Upgrade and network-change restarts keep every address the old server served in the same way, except an address that is no longer on this machine. Switching to an address the running server already serves, including loopback, reuses it, so run `lavish-axi stop` first to drop an address. Another server of the same installation (the same state directory) found on the same port at a different address is shut down through its own shutdown endpoint, after the kept server is made to serve that address too, so review links already handed out there keep working. A server belonging to another state directory that reports its installation identity is never used, replaced, or stopped: when it holds loopback or the configured address, the CLI fails with an error naming its state directory, so pick another `LAVISH_AXI_PORT`. Older servers that cannot report an identity are treated as belonging to this installation only at those control addresses, for upgrade compatibility.
- **Allowed hosts** - To defend against DNS rebinding, the server rejects (`403`) any request whose `Host` header is missing or not one it answers to: loopback names plus the concrete Tailscale IPv4 address and MagicDNS name when the Tailscale listener is successfully bound. If you configure a reverse proxy or another intentional hostname, list it in `LAVISH_AXI_ALLOWED_HOSTS` (whitespace-separated). Behind a reverse proxy, the forwarded `X-Forwarded-Host` is validated against the same list, so add the public hostname there and have the proxy send it together with `X-Forwarded-Proto`. Set `LAVISH_AXI_ALLOWED_HOSTS` to `*` to disable the check entirely, only when the server sits behind your own authentication or proxy. Mutating routes also reject a present foreign `Origin` or `Referer` (`403`); header-less CLI control requests remain allowed where supported.
- **Browser opening** - Set `LAVISH_AXI_NO_OPEN=1`, equivalent to `--no-open`, to create or resume a session without launching a browser window.

Active polls and review listeners protect the shared server from stop, upgrade, local-build and network/host replacement requests. These operations return `SERVER_BUSY` until reviews finish. Pass `--force` explicitly on `stop` or a command that needs a replacement to interrupt them. Waiting polls receive `SERVER_RESTARTED` before forced shutdown. New servers enforce the guard for older clients too. New clients check older servers' reported polls, but older servers cannot enforce the final check or report browser-only activity. Coordinate the first rollout between reviews. Shutdowns, refusals and confirmed network changes are logged in `server.log`.

Waiting polls send immediate headers and whitespace heartbeats, including bounded rounds. New CLI polls also wait correctly on older servers that stay silent for a full round. Transport timeouts report `POLL_TIMEOUT` without claiming a restart. Failed or incomplete Tailscale checks keep the last successful address; startup discovery retries in the background.

## CLI Reference

| Command                         | Description                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lavish-axi`                    | Show current sessions and usage guidance.                                                                                                                                                                                                                                                                                                                 |
| `lavish-axi update`             | Check for or apply the latest npm release through the AXI SDK self-updater.                                                                                                                                                                                                                                                                               |
| `lavish-axi <html-file>`        | Open or resume a Lavish Editor session, with the open-time layout gate enabled by default. Unresolved layout issues from earlier in the session are preserved. Refuses to reopen a session the user explicitly ended from the browser unless `--reopen` is passed.                                                                                        |
| `lavish-axi poll <html-file>`   | Long-poll until the user sends feedback, ends the session, or leaves every review disconnected past the reconnect grace period; detected layout issues arrive only when queued. On `browser_disconnected`, ask before reopening or ending the still-resumable session. On `ended`, stop polling and do not reopen uninvited.                              |
| `lavish-axi reply <html-file>`  | Post an agent reply and exit 0 only after the server accepts it, so the review page stops showing Working. Exits non-zero if the server does not confirm within 10 seconds. Use this when handing a result back without starting a long-poll. `poll --agent-reply` still posts a reply and then waits.                                                    |
| `lavish-axi end <html-file>`    | End a session as the agent; unlike a user-initiated end from the browser, this still allows a plain reopen later.                                                                                                                                                                                                                                         |
| `lavish-axi export <html-file>` | Write a portable copy of the artifact: one HTML file with its local assets inlined, so it opens with no server and no sibling files. Remote CDN/font references are left as links.                                                                                                                                                                        |
| `lavish-axi share <html-file>`  | Publish the artifact (local assets inlined) to [ht-ml.app](https://ht-ml.app), a third-party host not part of Lavish, and print a visitable URL plus a secret update key; shares are public by default, `--private` locks one behind a generated password, and the same command republishes or unpublishes an existing page with `--site`/`--update-key`. |
| `lavish-axi stop`               | Shut down the background server when no polls or review listeners are active. Use `--force` to interrupt active reviews.                                                                                                                                                                                                                                  |
| `lavish-axi playbook [id]`      | List focused artifact guidance or show one playbook; agents must open each matching playbook before writing HTML.                                                                                                                                                                                                                                         |
| `lavish-axi libraries`          | List the Excalidraw libraries in the whiteboard library directory; `--search <text>` or `--library <id>` lists item refs for `%% lavish-icon` nodes.                                                                                                                                                                                                      |
| `lavish-axi design`             | Show agent-facing design guidance, including optional CDN snippets and the whiteboard (Mermaid) opt-in snippet.                                                                                                                                                                                                                                           |
| `lavish-axi setup hooks`        | Install or repair optional SessionStart hooks for Claude Code, Codex, OpenCode, and GitHub Copilot CLI; restart the agent session afterward.                                                                                                                                                                                                              |
| `lavish-axi setup plugin`       | Register the installed package as an [Agent Plugin](https://agent-plugins.org) in VS Code, Cursor, and GitHub Copilot CLI; opt-in, idempotent, no marketplace involved. Reload each client afterward.                                                                                                                                                     |
| `lavish-axi server`             | Run the local Lavish Editor server.                                                                                                                                                                                                                                                                                                                       |

Known playbook IDs: `diagram`, `table`, `comparison`, `plan`, `code`, `input`, `explanation`, `slides`.
One artifact often combines several playbooks, such as a plan that includes a comparison and a diagram, so agents must match against each `use_when` trigger and open every matching playbook before writing HTML.
For flows, architecture, state, or sequence diagrams, open the diagram playbook for the recommended tooling and SVG guidance.

### Flags

| Command                  | Flag                        | Description                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lavish-axi <html-file>` | `--no-open`                 | Ensure the server/session exists without opening another browser window.                                                                                                                                                                                                                                                      |
| `lavish-axi <html-file>` | `--no-gate`                 | Skip the open-time layout curtain for this browser open.                                                                                                                                                                                                                                                                      |
| `lavish-axi <html-file>` | `--reopen`                  | Reopen a session the user explicitly ended from the browser; without it, a plain open refuses and explains why instead of reopening uninvited.                                                                                                                                                                                |
| `lavish-axi update`      | `--check`                   | Report current vs latest npm version without installing an update.                                                                                                                                                                                                                                                            |
| `lavish-axi export`      | `--out <path>`              | Write the export to a specific path instead of `<name>.export.html` next to the source.                                                                                                                                                                                                                                       |
| `lavish-axi share`       | `--private`                 | Make the page private behind a password Lavish generates and returns once; hand it to viewers as a shared secret.                                                                                                                                                                                                             |
| `lavish-axi share`       | `--password <pw>`           | Make the third-party ht-ml.app page private with a password you supply; viewers must supply the password. An empty or whitespace-only value (an unquoted `$PW` that is unset) is refused rather than publishing a public page.                                                                                                |
| `lavish-axi share`       | `--site <site_id>`          | Republish an existing page in place (with `--update-key`) instead of creating a new one; the URL does not change.                                                                                                                                                                                                             |
| `lavish-axi share`       | `--update-key <key>`        | The secret returned when the page was published; required to republish or unpublish it.                                                                                                                                                                                                                                       |
| `lavish-axi share`       | `--unpublish`               | Replace a published page with a locked placeholder (ht-ml.app cannot delete); takes `--site` and `--update-key` and no file.                                                                                                                                                                                                  |
| `lavish-axi share`       | `--token <t>`               | Attach an optional bearer token (`LAVISH_AXI_HTML_APP_TOKEN`) when creating a page; never required, and rejected on a republish or `--unpublish`, where the `update_key` is the credential.                                                                                                                                   |
| `lavish-axi poll`        | `--owner <label>`           | Identify the process listening for this session; the non-empty label appears in the home session listing. `none` is reserved for sessions without a listener. A second concurrent poll is refused instead of silently returning `waiting`.                                                                                    |
| `lavish-axi poll`        | `--takeover`                | Explicitly displace the current poll listener. The displaced poll exits with typed `LISTENER_REPLACED`; without this flag, the new poll fails with typed `LISTENER_ACTIVE`.                                                                                                                                                   |
| `lavish-axi poll`        | `--agent-reply "..."`       | Show a concise agent reply in the existing browser chat, conclude delivered work (every note the agent has seen is marked Done), and return presence to waiting before polling again. Keep replies concise by default.                                                                                                        |
| `lavish-axi poll`        | `--agent-reply-file <path>` | When a longer reply is genuinely necessary, read Markdown from a file (`-` for stdin) so newlines survive quoting. Use blank-line paragraphs, `- ` / `1. ` lists, and `## ` headings so the Conversation panel renders it scannably. The Markdown subset is under Feedback controls. Cannot be combined with `--agent-reply`. |
| `lavish-axi poll`        | `--timeout-ms <ms>`         | Test/debug escape hatch only. Without it, each poll returns after 8 minutes with status `waiting` when nothing arrived, so a tool's time limit never cuts it off; run it again to keep listening. `LAVISH_AXI_POLL_ROUND_MS` changes the round (`0` waits indefinitely).                                                      |
| `lavish-axi reply`       | `--agent-reply "..."`       | Concise reply text. Required unless `--agent-reply-file` is set. The command exits 0 only after the server accepts it. Empty text is refused. Prefer this over `poll --agent-reply` when you are not about to long-poll.                                                                                                      |
| `lavish-axi reply`       | `--agent-reply-file <path>` | Read the reply from a file (`-` for stdin) so newlines survive quoting. Cannot be combined with `--agent-reply`. Same Markdown guidance as `poll --agent-reply-file`.                                                                                                                                                         |
| `lavish-axi stop`        | `--port <port>`             | Shut down a server running on a non-default port.                                                                                                                                                                                                                                                                             |
| Server clients           | `--force`                   | Allow interrupting active shared reviews. Without it, replacement or stop returns `SERVER_BUSY`.                                                                                                                                                                                                                              |
| `lavish-axi server`      | `--verbose`                 | Log session and watcher events to stderr; can also be enabled with `LAVISH_AXI_DEBUG=1`. Detached server output is appended with UTC timestamps to `~/.lavish-axi/server.log` (or `LAVISH_AXI_STATE_DIR/server.log`) for startup, shutdown-cause, and crash diagnostics.                                                      |
| `lavish-axi server`      | `--also-listen <host>`      | Also listen on this concrete address (repeatable). The CLI passes it when it replaces a running server, so the replacement keeps every address the old one served; see One server per port.                                                                                                                                   |

## Telemetry

The Jadev fork's builds omit the upstream analytics website ID, so telemetry is inactive. Keep it omitted.
The description below applies to upstream npm releases. Installing one replaces this fork and its custom UI.

The npm release sends anonymous usage telemetry to an [Umami](https://umami.is) server at `https://a.kunchenguid.com`. The host and website ID are baked into the published bundle at build time, so telemetry is on by default for `npx -y lavish-axi`.

Each `lavish-axi` run sends two requests, except `lavish-axi --version` (also `-v` and `-V`), which sends none: a page view when the command starts, and a `command` event when it finishes. Both carry:

- the command name (for example `open`, `poll`, or `home` when you run it with no command), but not its arguments, file paths, artifact content, or prompts
- the Lavish version, `process.platform`, and `process.arch`

The `command` event also carries a `status` field: `success`, or `error` only when the CLI itself throws. A command that fails and sets a nonzero exit code is handled by the CLI framework, so it still reports `success`. No user identifier is sent. Requests time out after 1 second, and failures are ignored, so telemetry never changes what a command does.

Set `LAVISH_AXI_TELEMETRY=0` (or `false` or `off`) to turn it off. A build from source sends nothing unless `LAVISH_AXI_UMAMI_WEBSITE_ID` is set, and `LAVISH_AXI_UMAMI_HOST` overrides the host.

## Development

```sh
pnpm run check          # Run all verification commands
pnpm run build          # Bundle the publishable CLI, chrome, and design assets
pnpm run build:skill    # Regenerate the installable lavish skill
pnpm test               # Run node:test tests
pnpm run lint           # Run ESLint
pnpm run format:check   # Check Prettier formatting
pnpm run typecheck      # Run TypeScript checkJs validation
```
