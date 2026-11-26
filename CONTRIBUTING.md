# Contributing

Thanks for wanting to contribute.

## Workflow

1. Fork the repo and create a branch.
2. Make your changes. Bug fixes and features come with a test.
3. Run `pnpm run check`. It must pass.
4. Add user-facing changes to the top entry of `CHANGELOG.md`.
5. Open a pull request against `main`.

## Repo Conventions

- Node 22+, ESM-only JavaScript, and TypeScript `checkJs` validation.
- Run `pnpm run check` before pushing.
- [AGENTS.md](AGENTS.md) lists the rules that apply to almost every change, and [docs/invariants.md](docs/invariants.md) explains how the code works.
- Changes that differ from upstream lavish-axi are described in [docs/jadev-fork.md](docs/jadev-fork.md).

## Questions

Open an issue.
