# Changelog

## 1.1.0 (unreleased)

### Added

- **Page storage.** `window.lavish.store` keeps JSON per page file in the state directory, through reloads and server restarts (1 MB a value, 5 MB a page). `lavish data <page>` prints it for the agent; `--clear --yes` deletes it.
- **Ask the agent from the page.** `await window.lavish.ask(question, { data })` sends the question at once and resolves with the agent's reply. Poll marks it as a prompt tagged `ask`, and `lavish reply <page> --ask <id>` answers it. With no agent listening it fails at once with `NO_AGENT`.
- **Files in and out.** `window.lavish.files.pick()` lets the reviewer choose images, PDFs or text files; the agent gets their local paths when the page queues them. `window.lavish.download(name, content)` saves a file through the browser after a click.

## 1.0.0 (2026-11-26)

First release of `@jadev-corp/lavish` on npm. It is based on [lavish-axi](https://github.com/kunchenguid/lavish-axi) 0.1.98 by Kun Chen, under the MIT license. Upstream's release history is in [its changelog](https://github.com/kunchenguid/lavish-axi/blob/main/CHANGELOG.md). Every change this build makes to upstream is described in [docs/jadev-fork.md](docs/jadev-fork.md).

### Added

- **npm package.** Install with `npm i -g @jadev-corp/lavish`. The command is `lavish`; `lavish-axi` stays as an alias. `LAVISH_AXI_*` variables and the `~/.lavish-axi` state directory are unchanged.
- **`lavish update`.** Upgrades from npm the way the package was installed. Open reviews show **Update** when npm has a newer version. A 1.0.0 CLI replaces a running 0.1.98-jadev.N server the next time a review opens, unless a review or poll is still active.
- **Queue all.** Every page with questions ends with a bar: a count of answered questions, links to the open ones, **Copy**, **Queue all answers** and **Queue all and send**. It carries a note for the whole page, and each question without a text box gets **Add note**. Copy still works when the browser refuses the clipboard: the text is shown selected for Cmd+C.
- **draw.io diagrams.** `lavish diagram <file.drawio>` renders a static SVG that follows light and dark mode and stays editable in draw.io, plus a PNG preview for the agent to check. A `.mmd` Mermaid file becomes an editable `.drawio` first.
- **Opening beside the chat.** In T3 Code the review opens in the thread's preview panel. In VS Code, with `LAVISH_AXI_OPEN=panel`, Copilot's agent chat opens it in the integrated browser.
- **Brainstorm playbook.** `lavish playbook brainstorm` shapes a thinking session: the problem, a diagram, three to five options with fit scores, Go / Maybe / No with notes, and numbered rounds.

### Removed

- **GitHub update check.** The server no longer fetches this repository to look for a newer version; it asks the npm registry. The old `update-check.git` folder in the state directory can be deleted.
- **Lean package.** No telemetry code: `LAVISH_AXI_TELEMETRY` and `LAVISH_AXI_UMAMI_*` are no longer read. The upstream marketing video, release tooling and maintainer-only files are gone from the repository and the tarball.
