# Versioning

Zhivex AI SDK for TypeScript uses [Changesets](https://github.com/changesets/changesets) for package versioning and release management.

This repository publishes multiple npm packages from one monorepo. Versioning decisions should reflect the package where the real consumer-facing change lives, while also reviewing downstream packages that depend on shared contracts.

Related documents:

- [README.md](./README.md)
- [STABILITY.md](./STABILITY.md)
- [SUPPORT.md](./SUPPORT.md)
- [docs/RELEASE.md](./docs/RELEASE.md)

## Versioning Principles

- `@zhivex-ai/core` is the contract source of truth.
- If a public type or behavior changes in `core`, review `sdk` and affected providers before deciding version scope.
- `@zhivex-ai/sdk` should continue to re-export the public high-level surface intentionally.
- Provider packages should version when their observable behavior, exports, metadata, or dependency expectations change.
- Test-only refactors usually do not need a changeset.

## When To Create A Changeset

Create a changeset when:

- a published package changes observable runtime behavior
- a published package adds exports, types, or capabilities
- a bug fix should ship to npm consumers
- npm-facing metadata changes
- internal dependency ranges between published packages should update

A changeset is usually not required when:

- only unpublished tooling changed
- only tests changed without package impact
- a pure refactor did not alter runtime or type behavior

## Bump Guidance

- `patch`: bug fixes and compatible behavior adjustments
- `minor`: new backward-compatible capabilities, exports, or provider support improvements
- `major`: breaking changes to public runtime behavior, exported types, package entrypoints, or supported contract semantics

## Internal Dependency Review

Because this is a monorepo:

- review downstream providers when `@zhivex-ai/core` changes
- review `@zhivex-ai/sdk` when anything should become part of the high-level public API
- review `@zhivex-ai/gateway` when routing depends on shared capability contracts

Changesets is configured to update internal dependencies when needed, but package selection still requires judgment.

## Release Expectations

Before publishing, follow the full [Release Guide](./docs/RELEASE.md). The short checklist is:

1. Run `bun run typecheck`
2. Run `bun run test`
3. Run `bun run build`
4. Run `bun run smoke:providers` before meaningful stable or prerelease publishes
5. Create or review pending changesets
6. Review package manifests, package dry-run output, and re-exports

For local versioning and release:

1. Run `bun run version-packages`
2. Re-run validation after versioning
3. Publish stable releases with `bun run release`

Use `bunx changeset publish --tag next` for prereleases. Do not publish prerelease versions to `latest`.

## Compatibility Expectations

- Stable APIs defined in [STABILITY.md](./STABILITY.md) should not break casually.
- Beta APIs may evolve between minor releases, but observable changes should still be communicated clearly.
- Experimental APIs may change faster and should not be treated as compatibility guarantees.

## Provider Reality

Versioning does not imply universal feature parity across providers.

Consumers should evaluate:

- the README capability matrix
- provider support tiers
- the stability level of the surface they depend on

The version number communicates package evolution, not identical behavior across all providers.
