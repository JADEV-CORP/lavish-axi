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

A running Lavish server from an older version shuts itself down the next time any session opens, because the CLI
replaces a server whose `/health` reports a different version. Open review tabs reload onto the new server, or show a banner first when they hold an unsent draft.

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
palette hotkey), `src/design-reference.js`, and their tests. Bump the version to `<tag>-jadev.1`, open a PR into
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
