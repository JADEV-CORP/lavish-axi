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

Create a T3 Connect webhook task bound to the review's owning thread. Its prompt should tell the agent to poll the
session named by `{{body.file}}` and `{{body.key}}`, within the already approved scope, without taking over another
listener. Save the returned webhook URL in a private local file, then run:

```sh
lavish-axi bind-agent report.html --webhook-file /private/path/t3-webhook.txt
```

Reload the review tab. After the existing no-listener delay, **Nudge agent** sends the session's absolute file path
and key to T3 Connect. It sends no artifact content or feedback text. The URL stays in the local state directory's
`agent-bindings` folder, outside session JSON, browser markup and exports. Files request owner-only permissions;
on Windows they inherit the state directory's ACL. Protect that directory as you protect other agent credentials.

The action reports relay acceptance, not that the agent has read the feedback. Concurrent clicks share one request,
and every attempted delivery has a 15-second cooldown because a timed-out request may already have arrived.
An active listener or a working agent needs no nudge. **Copy nudge** stays available for delivery failures and
other harnesses. No automatic nudge runs. T3 Connect must be reachable, and the webhook stays bound to its original
thread. Remove the binding with `lavish-axi bind-agent report.html --clear` and delete the T3 webhook when retiring
that integration.

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

The running server checks for a newer fork version shortly after it starts and then every six hours (`src/fork-update.js`). It fetches the fork's `main` with `--depth=1 --filter=blob:none` into `update-check.git` under the state directory and reads only `package.json`, so git's own credential manager signs in and Lavish never handles a token; terminal and Git Credential Manager prompts are off, so a machine that is not signed in skips the check silently. A higher `-jadev.N` shows **Update** in every open editor's top bar, with the steps above and Copy and Dismiss (dismissed per version). `LAVISH_AXI_UPDATE_CHECK=0` turns the check off.

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
