<!-- Portions copyright (c) 2026 JADEV-CORP. MIT License, see LICENSE. -->

# Jadev fork

This repository is Jadev's fork of [kunchenguid/lavish-axi](https://github.com/kunchenguid/lavish-axi). It carries the
redesigned review chrome (shadcn/ui preset b50eA1ekc, resizable and movable conversation panel, Peek, the AI Elements
chat, transitions.dev motion, note pins, the command palette, revision outlines) and the Lavish design default for
artifacts. Upstream behaviour is otherwise unchanged.

## Package and versions

The fork is published on npm as `@jadev-corp/lavish`. The command is `lavish`, and `lavish-axi` is an alias for the
same entry, so agents, hooks and skills written for the old name keep working. The `LAVISH_AXI_*` variables, the
state directory (`~/.lavish-axi`), the plugin name (`lavish-axi`), the hook markers and the on-disk formats are
unchanged.

The package has its own semver line. 1.0.0 is built on upstream lavish-axi 0.1.98 and follows the last fork tarball,
0.1.98-jadev.2. A patch release fixes, a minor release adds or merges a new upstream release, and a major release
changes a contract agents rely on: commands, output fields or state. Each `CHANGELOG.md` entry names the upstream
base when it changes.

Change the version in `package.json`, run `pnpm run build:plugin` so `plugin.json` follows, and add the entry to
`CHANGELOG.md`. The changelog is this package's own and written by hand; upstream's history stays in upstream's
repository.

## Install and update

```sh
npm i -g @jadev-corp/lavish
lavish --version
npx -y @jadev-corp/lavish --version
```

Both version commands must print the same version. `npx -y @jadev-corp/lavish` uses the global install when one
exists, and fetches the package from npm when it does not. A machine that still has the 0.1.x tarball needs
`npm rm -g lavish-axi` first, because both packages provide the `lavish-axi` command.

`lavish update` is the AXI SDK's built-in. It reads the package name from the installed `package.json`, asks the
npm registry for the latest version, and upgrades the way the package was installed: `npm install -g
@jadev-corp/lavish@latest` for npm, `pnpm add -g` for pnpm, or a hint to rerun npx. `lavish update --check` only
reports.

The running server asks the npm registry for the latest version 30 seconds after it starts and then every six hours
(`src/update-check.js`). It calls the registry's HTTP endpoint only and never runs npm or git. A newer version shows
**Update** in every open editor's top bar, with `lavish update`, Copy and Dismiss (dismissed per version).
`LAVISH_AXI_UPDATE_CHECK=0` turns the check off. Versions before 1.0.0 fetched this repository from GitHub into
`update-check.git` under the state directory; that folder is no longer used and can be deleted.

A newer CLI replaces an older server when a review opens. An older CLI adopts a newer server instead of restarting
it. Versions order by semver precedence (`compareReleaseVersions`), so 1.0.0 replaces every 0.1.98-jadev.N server
and a prerelease ranks below its release. A version that is not plain semver is replaced, and a forced local
rebuild still replaces the running server. An open review tab or an active poll blocks a replacement with
`SERVER_BUSY` unless `--force` is passed. A forced replacement reloads open tabs onto the new server, or shows a
banner first when a tab holds an unsent draft.

## Releases

A release is a tag on `main`:

1. Set the version in `package.json`, run `pnpm run build:plugin`, date the `CHANGELOG.md` entry, and merge to
   `main`.
2. Tag the merge commit `v<version>` and push the tag: `git tag v1.0.0 && git push origin v1.0.0`.
3. `.github/workflows/jadev-release.yml` checks that the tag matches `package.json`, runs `pnpm run check`, packs
   the tarball, publishes it to npm with `npm publish --provenance --access public`, and creates a GitHub release
   with the `.tgz` attached.

Publishing uses npm trusted publishing. GitHub Actions signs in to npm with a short-lived OIDC token, so no npm
token is stored in the repository, and npm records provenance that links each version to the workflow run that
built it. On npmjs.com, the package's trusted publisher names the repository `JADEV-CORP/lavish-axi` and the
workflow `jadev-release.yml`. npm configures a trusted publisher on an existing package only, so the `jadev-corp`
npm user publishes 1.0.0 once by hand (`npm publish --access public` from a clean checkout of the tag) and adds the
trusted publisher right after. Every later version goes through the workflow.

## Direct agent nudges

Inside T3 Code, a review can be linked to the thread of the conversation that opened it. When the agent stops
listening, the review's notice then offers **Nudge agent**, which runs `t3 thread send` to that thread with one line
naming the review file and asking the agent to poll it. It sends no artifact content or feedback text, and it
registers nothing in T3 Code, so there is no webhook to clean up. A busy thread gets the message as its next turn.

The agent links its conversation once. It reads its own thread id from T3 Code's `orchestrator_capabilities`
(`parentThreadId`) and passes it with the first review:

```sh
lavish report.html --t3-thread <thread-id>
# or, after the review is open
lavish bind-agent report.html --t3-thread <thread-id>
```

`lavish <file>` reports `agent_link` (`linked`, `not linked` with that step, or `failed` with a reason) only when
it runs inside T3 Code. Lavish checks the thread with `t3 thread show` first, which takes about ten seconds while
T3's CLI starts. Every later review the same conversation opens links automatically, without asking T3 again.
The conversation is recognised by the harness id T3 Code's Claude and Codex providers expose (`CLAUDE_CODE_SESSION_ID`,
`CODEX_THREAD_ID`), stored only as a hash. Reuse never replaces a link another conversation made; an explicit
`--t3-thread` does. An open tab notices a new or removed link the next time its not-listening notice opens.

Ending a review, from the browser or with `lavish end`, removes its link, and a server restart removes the links
of reviews that ended while it was down. The conversation's own thread record stays so its next review still links,
and is pruned after 30 days unused. `bind-agent --clear` removes a link by hand.

Outside T3 Code nothing is linked and the notice offers **Copy nudge**, a line to paste into the agent. It stays
available in T3 Code too, for failed deliveries. The action reports that T3 queued the message, not that the agent
read the feedback. Concurrent clicks share one request, and every attempt has a 15-second cooldown because a timed-out
send may still arrive. No automatic nudge runs.

The older webhook link (`bind-agent --webhook-file <file>` holding a T3 Connect webhook URL from `schedule_task`) still
works. Lavish removes its local copy when the review ends, but it cannot delete the webhook task in T3 Code: the thread
that created it must, with `delete_scheduled_task`. Prefer `--t3-thread`.

What is not automatic yet: T3 Code does not tell the processes it runs which thread they belong to, so the first
review of each conversation needs the agent's one `--t3-thread` step. If T3 Code exported the calling thread's id to
provider processes, Lavish could link that first review too.

## Queue all

Every page with at least one `data-lavish-question` scope gets a bar at its end: **Copy**, **Queue all answers** and
**Queue all and send**, with a count of answered questions and a link to each open one. It sticks to the bottom of the
viewport while the page scrolls, rests after the last question, and shrinks to one row on a phone. Agents no longer
have to remember a page-level button, and a page that forgot one still gets it.

Queue all runs each question's own Queue answer control (a form's submit, a `data-lavish-submit` element, or a button
whose label says queue, submit, send or answer), so the prompt is the one the author wrote. A question whose control
queues nothing, for example a form with no handler, still goes as plain text, and the page does not navigate. Each
answer keeps its question's queue key, so pressing Queue all twice replaces the first batch instead of doubling it.
A closing `queue-all` prompt lists the queued and the open question IDs so the agent can account for every one.

The bar also holds a note for the whole page, and every question without its own textarea gets an **Add note**
toggle. Notes are multi-line, ride on the prompt they belong to (the question's own button or Queue all), and survive a
live reload. The closing summary lists one short line per answer, so a summary pasted on its own still says what was
answered. **Copy** works three ways: a copy inside the click, the chrome's clipboard (the sandboxed frame can be
refused it; the chrome only copies right after a real click), and, when both fail, the text shown selected for Cmd+C.

`<html data-lavish-queue-all="off">` turns the bar off; `data-lavish-note="off"` on `<html>` or on a question turns the
notes off. A page that keeps its own page-level control marks it
`data-lavish-queue-all` and the bar stays away. The helpers live in `src/queue-all.js`, the bar in the page SDK.

## Diagrams with draw.io

`lavish diagram <file.drawio>` renders a diagram for a page with the draw.io desktop app (open source, Apache-2.0)
already on the machine. It writes `<name>.drawio.svg` next to the source: a static image, no script at view time, with
colors that follow light and dark mode and the diagram embedded, so draw.io reopens the SVG for editing. It also writes
a PNG preview under the state directory (`diagram-previews/`) for the agent to look at before serving the page, and
prints the `<img>` tag to paste.

`--layout horizontalFlow` (or another draw.io layout) lets the agent write nodes and edges without coordinates; the
positions are written back into the `.drawio`, so later hand edits keep them. A `.mmd` Mermaid file becomes an editable
`.drawio` first. One diagram takes 1 to 5 seconds, mostly draw.io starting. Lavish finds draw.io through
`LAVISH_AXI_DRAWIO`, `PATH`, then the usual install folder; install it with `brew install --cask drawio`,
`winget install JGraph.Draw`, or the Linux packages on github.com/jgraph/drawio-desktop.

The diagram playbook now asks for at least one visible diagram on any page that explains a system or a flow, sends
architecture, process and sequence diagrams to draw.io, and keeps hand-written inline SVG for small figures.

## Opening beside the chat

Inside T3 Code (`T3CODE_THREAD_ID` set), `lavish <file>` does not open an external browser. No command can put a
page in T3's preview panel from outside, but the agent can: the output's `open_in` and `next_step` tell it to call
`preview_open`, which shows the review in a tab beside the conversation. VS Code is opt-in, because every VS Code terminal
sets `TERM_PROGRAM=vscode` whoever types in it: add `"LAVISH_AXI_OPEN": "panel"` to `terminal.integrated.env.osx` (or
`.windows`, `.linux`) and Copilot's agent chat is told to call `openBrowserPage` instead (VS Code 1.109 or later, with
`workbench.browser.enableChatTools` on). An agent without that tool runs the same command with `--external`;
`LAVISH_AXI_OPEN=external` makes that the default. Detection lives in `src/review-host.js`.

## Brainstorm playbook

`lavish playbook brainstorm` shapes a thinking session: the problem in one sentence and a diagram of today, three to
five real options with IDs and fit scores, Go / Maybe / No on each with a note, an open "Something else?" question, and
numbered rounds that open with what changed.

## Polls survive a server restart

A newer CLI replacing the server, `lavish stop`, or a Tailscale address change all restart the server. A poll
waiting at that moment, often one started with `--agent-reply`, used to exit with `SERVER_ERROR`, and the agent
stopped listening. It now prints a line on stderr and listens again on the new server, up to three times, when that
server holds no other listener for the review. It does not post its reply a second time.

## Context data is TOON

`window.lavish.queuePrompt(text, { data })` appends the data to the prompt as TOON (`question: D20`,
`items[2]{id,label}:` rows) instead of indented JSON: the same content in fewer tokens.

## Upstream 0.1.90 adaptations

This base includes custom Excalidraw libraries, platform-specific link modifiers, WebKit IME confirmation guards,
artifact annotation defaults and configurable disconnect grace. `data-lavish-annotate="off"` on the root `html`
opens a form in Interact unless the reviewer saved Interact as their starting preference or explicitly changed
the mode in this review. With no saved preference, each fresh artifact load supplies its own default until a
reviewer toggles it. The top bar, composer and rail all show that one mode.

`LAVISH_AXI_DISCONNECT_GRACE_MS` changes the default 10-second reconnect grace. `0` or `off` disables disconnect
release, while the fork's polling rounds still return on their own budget. Invalid values retain the default;
large durations clamp to the timer maximum. Library files belong in the state directory's `excalidraw-libraries`
folder, and `lavish libraries` lists their references. Libraries never download automatically.

## Upstream 0.1.98 adaptations

Upstream's desktop sidebar toggle (#462) is not taken: the fork's layout switch already collapses the
panel to a rail that counts unseen replies, and two controls for one panel would disagree. The rest
of 0.1.91 to 0.1.98 is in, adapted where the fork's chrome differs:

- Unsent-ownership copy (#464) is in the takeover banner and the empty-Send hint; an empty Send still
  shakes the message box, and keeps the longer hint on screen.
- Unique annotation selectors (#493) also cover notes queued from the card and `window.lavish`; the
  chrome lists each selector at its newest note, next to the fork's pin numbers.
- `window.lavish.setDocumentMeta` (#458) replaces the tab icon link, so the background-tab marker
  looks the link up each time, puts its dot back over a new icon, and keeps the unseen count in a
  title the artifact sets.

## Sync with upstream

The `upstream` remote fetches from GitHub and has its push URL set to `DISABLED`, so nothing from the fork can be
pushed there by mistake.

```sh
git fetch upstream --tags
git checkout -b sync/upstream-<tag> main
git merge <tag>
pnpm install
pnpm run check
```

Resolve conflicts in favour of upstream behaviour unless the fork deliberately changed it; the fork's changes are in
`src/chrome.css`, `src/chrome-client.js`, `src/server.js` (chrome markup), `src/artifact-sdk.js` (pins, outlines,
palette hotkey), `src/design-reference.js`, `src/whiteboard-frame.css` (the whiteboard header and Excalidraw
accent on the chrome palette and preset), and their tests. Bump the minor version, name the new upstream base in
`CHANGELOG.md`, open a PR into `main`, and release it with a tag once it merges.

## Hidden files are not served

Upstream #406 serves every file inside the artifact's folder. The fork also refuses, with a 404, any `/artifact`
path that has a segment starting with a dot below that folder, so a `.env`, `.git/`, or other hidden file beside an
artifact is never readable over the network. The artifact's own folder can be hidden (`.lavish/`); only the part
below it is checked. This lives in `hasHiddenSegment` (`src/artifact-path.js`) and the `/artifact` route; keep it
when merging upstream changes to either.

## Removed from upstream

The package is kept lean. These upstream parts are gone from the repository and the tarball:

- Telemetry: `src/telemetry.js` and its build-time Umami settings. The CLI sends no usage data and reads no
  `LAVISH_AXI_TELEMETRY` or `LAVISH_AXI_UMAMI_*` variable.
- The marketing video project (`lavish-editor-marketing/`) and its GIF.
- Upstream's release and PR tooling: release-please (`release-please.yml`, its config and manifest),
  `no-mistakes-required.yml` and `guard-generated-files.yml`. CI is `ci.yml`, releases are `jadev-release.yml`.
- Maintainer-only material: `task-evidence/` and the internal `lavish-design` brand skill under `.agents/`.

An upstream merge that touches any of these stops on a modify/delete conflict: keep the deletion (`git rm`).
`test/package-json.test.js` fails if an upstream workflow comes back.
