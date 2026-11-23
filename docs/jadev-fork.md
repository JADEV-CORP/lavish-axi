<!-- Copyright (c) 2026 JADEV-CORP. All rights reserved. Proprietary and confidential. -->

# Jadev fork

This repository is Jadev's fork of [kunchenguid/lavish-axi](https://github.com/kunchenguid/lavish-axi). It carries the
redesigned review chrome (shadcn/ui preset b50eA1ekc, resizable and movable conversation panel, Peek, the AI Elements
chat, transitions.dev motion, note pins, the command palette, revision outlines) and the Lavish design default for
artifacts. Upstream behaviour is otherwise unchanged.

## Versions

The fork versions as `<upstream version>-jadev.<n>`, for example `0.1.83-jadev.1`. The suffix makes it impossible to
mistake for an npm release, and `<n>` goes up with each fork release on the same upstream base. A merge of a new
upstream release resets it: `0.1.84-jadev.1`.

Change the version in `package.json` and run `pnpm run build:plugin` so `plugin.json` follows. Do not hand-edit
`CHANGELOG.md` or `.release-please-manifest.json`; release-please belongs to upstream.

## Install on a machine

```sh
pnpm install
pnpm run check
npm pack
npm i -g ./lavish-axi-<version>.tgz
lavish-axi --version
npx -y lavish-axi --version
```

Both version commands must print the jadev version. `npx -y lavish-axi` uses the global install when one exists, which
is how agents reach the fork.

A newer Jadev CLI replaces an older Jadev server when a session opens. An older Jadev CLI adopts a newer
Jadev server instead of restarting it. Plain upstream versions remain a separate build channel, and a forced local
rebuild still replaces the running server. Open review tabs reload onto the replacement, or show a banner first
when they hold an unsent draft.

## Direct agent nudges

Inside T3 Code, a review can be linked to the thread of the conversation that opened it. When the agent stops
listening, the review's notice then offers **Nudge agent**, which runs `t3 thread send` to that thread with one line
naming the review file and asking the agent to poll it. It sends no artifact content or feedback text, and it
registers nothing in T3 Code, so there is no webhook to clean up. A busy thread gets the message as its next turn.

The agent links its conversation once. It reads its own thread id from T3 Code's `orchestrator_capabilities`
(`parentThreadId`) and passes it with the first review:

```sh
lavish-axi report.html --t3-thread <thread-id>
# or, after the review is open
lavish-axi bind-agent report.html --t3-thread <thread-id>
```

`lavish-axi <file>` reports `agent_link` (`linked`, `not linked` with that step, or `failed` with a reason) only when
it runs inside T3 Code. Lavish checks the thread with `t3 thread show` first, which takes about ten seconds while
T3's CLI starts. Every later review the same conversation opens links automatically, without asking T3 again.
The conversation is recognised by the harness id T3 Code's Claude and Codex providers expose (`CLAUDE_CODE_SESSION_ID`,
`CODEX_THREAD_ID`), stored only as a hash. Reuse never replaces a link another conversation made; an explicit
`--t3-thread` does. An open tab notices a new or removed link the next time its not-listening notice opens.

Ending a review, from the browser or with `lavish-axi end`, removes its link, and a server restart removes the links
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

## Polls survive a server restart

A newer CLI replacing the server, `lavish-axi stop`, or a Tailscale address change all restart the server. A poll
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
folder, and `lavish-axi libraries` lists their references. Libraries never download automatically.

The running server checks for a newer fork version shortly after it starts and then every six hours (`src/fork-update.js`). It fetches the fork's `main` from GitHub (`JADEV-CORP/lavish-axi`; the Azure DevOps copy was removed on 23 Nov 2026) with `--depth=1 --filter=blob:none` into `update-check.git` under the state directory and reads only `package.json`, so git's own credential manager signs in and Lavish never handles a token; terminal and Git Credential Manager prompts are off, so a machine that is not signed in skips the check silently. A higher `-jadev.N` shows **Update** in every open editor's top bar, with the steps above and Copy and Dismiss (dismissed per version). `LAVISH_AXI_UPDATE_CHECK=0` turns the check off.

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

`lavish-axi update` is disabled in the fork. The built-in updater installs the newest npm release, which semver ranks
above every `-jadev.N` prerelease, so it would quietly replace the fork with upstream. It exits with
`FORK_UPDATE_DISABLED` instead.

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
accent on the chrome palette and preset), and their tests. Bump the version to `<tag>-jadev.1`, open a PR into
`main`, and reinstall from the new tarball once it merges.

## Hidden files are not served

Upstream #406 serves every file inside the artifact's folder. The fork also refuses, with a 404, any `/artifact`
path that has a segment starting with a dot below that folder, so a `.env`, `.git/`, or other hidden file beside an
artifact is never readable over the network. The artifact's own folder can be hidden (`.lavish/`); only the part
below it is checked. This lives in `hasHiddenSegment` (`src/artifact-path.js`) and the `/artifact` route; keep it
when merging upstream changes to either.

## Telemetry

Upstream's release builds inject an analytics site id at build time. Fork builds do not set
`LAVISH_AXI_BUILD_UMAMI_WEBSITE_ID`, so the telemetry client is a no-op and nothing is sent. Keep it that way.
