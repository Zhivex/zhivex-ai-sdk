# Contributing

Thanks for your interest in contributing to Zhivex AI SDK.

## Getting Started

This repository is a Bun-based TypeScript monorepo with project references and Vitest.

```bash
bun install
bun run typecheck
bun run test
bun run build
```

## Development Guidelines

- Keep `packages/core` as the source of truth for shared contracts, runtime helpers, capabilities, and typed errors.
- Add new capabilities to the shared contract first, then adapt provider packages as supported.
- Keep provider adapters focused on translating between external APIs and the shared SDK contract.
- Prefer explicit capabilities or typed errors over provider-specific implicit behavior.
- Keep the public API small and consistent. If you export something new, review both `packages/core/src/index.ts` and `packages/sdk/src/index.ts`.

## Tests

- Changes in `packages/core` should include coverage in `packages/core/tests`.
- Provider changes should validate message mapping, tools, structured output, streaming, and error handling when applicable.
- If a documented behavior changes, update `README.md`.

## Pull Requests

- Keep changes focused and incremental.
- Add or update tests for behavioral changes.
- Make sure `bun run typecheck`, `bun run test`, and `bun run build` pass before opening a PR.
- Include a changeset when the change affects published packages.

## Release Notes

Published packages are managed with Changesets. Add a changeset for user-facing changes:

```bash
bunx changeset
```

## Reporting Issues

- Use GitHub Issues for bugs, regressions, and feature requests.
- For security issues, please follow the process in `SECURITY.md`.
