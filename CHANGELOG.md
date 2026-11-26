# Changelog

## Unreleased

First release of this package. It is based on [lavish-axi](https://github.com/kunchenguid/lavish-axi) 0.1.98 by Kun Chen, under the MIT license. Upstream's release history is in [its changelog](https://github.com/kunchenguid/lavish-axi/blob/main/CHANGELOG.md). Every change this build makes to upstream is described in [docs/jadev-fork.md](docs/jadev-fork.md).

### Added

- **Queue all.** Every page with questions ends with a bar: a count of answered questions, links to the open ones, **Copy**, **Queue all answers** and **Queue all and send**. It carries a note for the whole page, and each question without a text box gets **Add note**. Copy still works when the browser refuses the clipboard: the text is shown selected for Cmd+C.
- **draw.io diagrams.** `lavish-axi diagram <file.drawio>` renders a static SVG that follows light and dark mode and stays editable in draw.io, plus a PNG preview for the agent to check. A `.mmd` Mermaid file becomes an editable `.drawio` first.
- **Opening beside the chat.** In T3 Code the review opens in the thread's preview panel. In VS Code, with `LAVISH_AXI_OPEN=panel`, Copilot's agent chat opens it in the integrated browser.
- **Brainstorm playbook.** `lavish-axi playbook brainstorm` shapes a thinking session: the problem, a diagram, three to five options with fit scores, Go / Maybe / No with notes, and numbered rounds.

### Removed

- **Lean package.** No telemetry code: `LAVISH_AXI_TELEMETRY` and `LAVISH_AXI_UMAMI_*` are no longer read. The upstream marketing video, release tooling and maintainer-only files are gone from the repository and the tarball.
