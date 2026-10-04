# Support

This document defines the current support stance for the published TypeScript packages in this repository.

Related documents:

- [README.md](./README.md)
- [STABILITY.md](./STABILITY.md)
- [VERSIONING.md](./VERSIONING.md)

## Support Principles

- `packages/core` is the contract source of truth.
- `packages/sdk` is the recommended high-level entrypoint for most application code.
- Provider adapters should stay thin and map provider behavior into the shared contract.
- A provider being available does not mean every feature has parity with every other provider.
- When a feature does not apply to a provider, the SDK should expose that through capabilities or explicit errors instead of silent fallback behavior.

## Published Packages

The following packages are intended for npm consumers:

- `@zhivex-ai/core`
- `@zhivex-ai/sdk`
- `@zhivex-ai/agents`
- `@zhivex-ai/react`
- `@zhivex-ai/openai`
- `@zhivex-ai/xai`
- `@zhivex-ai/meta`
- `@zhivex-ai/azure-openai`
- `@zhivex-ai/anthropic`
- `@zhivex-ai/gemini`
- `@zhivex-ai/vertex`
- `@zhivex-ai/bedrock`
- `@zhivex-ai/ollama`
- `@zhivex-ai/openrouter`
- `@zhivex-ai/qwen`
- `@zhivex-ai/kimi`
- `@zhivex-ai/deepseek`
- `@zhivex-ai/zai`
- `@zhivex-ai/gateway`

## Installation And Consumer Compatibility

Published packages can be installed with npm, pnpm, Yarn, or Bun. These consumer installations are separate from repository development, which uses the committed Bun lockfile and requires Bun 1.4.2+ and Node.js 22.12+.

CI builds once, then installs actual `npm pack` tarballs in a new temporary project for each row:

| Package manager | Pinned version | Package execution runtime | Installation layout |
| --- | --- | --- | --- |
| npm | 10.9.4 | Node.js 24.21.0 | npm node_modules |
| pnpm | 10.34.6 | Node.js 24.21.0 | pnpm isolated node_modules |
| Yarn Classic | 1.22.22 | Node.js 24.21.0 | Yarn node_modules |
| Bun | 1.3.7 | Bun 1.3.7 | Bun node_modules |

The matrix packs every publishable package with npm 10.9.4, installs all 19 tarballs together with required React peers and optional Markdown/virtualization peers, imports every JavaScript export, verifies every top-level installed package file against the packed inputs, and checks the installed `zhivex-ai` CLI version through the selected manager. It runs the deterministic golden path (generation, Agent, file-backed Runner sessions across recreated instances, and React transport), plus a TypeScript 5.9.3 NodeNext consumer typecheck with `@types/node` 22.19.0 and `skipLibCheck`. Lifecycle scripts are disabled. Temporary projects have no workspaces, aliases, overrides, or resolutions. Manager versions, runtime versions, entrypoint counts, and tarball SHA-256 hashes are printed in CI logs. Direct registry dependency versions are pinned; transitive dependencies are resolved afresh, so this is also a check against current dependency compatibility.

Internal semver dependencies are resolved normally by each manager. Some managers install separate registry copies instead of reusing top-level `file:` tarballs; the harness records their requested ranges, resolved versions, and source. Every top-level export is imported from the checkout's packed artifact, while end-to-end SDK execution can use those registry dependencies. The existing npm certification also exercises the combined packed dependency graph. This matrix does not force all nested dependencies onto unpublished checkout builds.

The existing broader npm certification continues separately on Node.js 18.18.0 with OpenTelemetry SDK 1.30.1 and Node.js 24 with OpenTelemetry SDK 2.11.0, including the optional OpenTelemetry peer absence check and installed provider/AGW fixtures. Its Node 18 row imports all provider packages but does not establish Node 18 runtime support for providers with higher engine requirements. The additional manager matrix does not repeat that full certification four times.

`@zhivex-ai/sdk` and `@zhivex-ai/core` declare Node.js 18.18+ or Bun 1.3.7+. Provider boundaries still apply: Bedrock requires Node.js 20+, and Vertex requires Node.js 22+. Optional dependencies and specific features may impose additional requirements; the separate MCP certification runs on Node.js 22.12/24 and Bun. The matrix tests ESM server consumption. Modern Yarn (including its node-modules linker), Yarn Plug'n'Play, CommonJS `require`, browser bundlers, every manager/runtime combination, and live provider calls are outside this matrix's coverage. Modern Yarn's registry age gates can reject newly published internal dependencies when installing local tarballs; no security gates are disabled by this harness. React export imports and transport construction are not a browser-rendering certification; the existing browser suite covers that separately.

To reproduce a manager row after installing the pinned tooling on your PATH:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run smoke:packages:manager npm
bun run smoke:packages:manager pnpm
bun run smoke:packages:manager yarn
bun run smoke:packages:manager bun
```

Use Bun 1.4.2 for the repository build and Bun 1.3.7 on PATH for the Bun consumer row. The harness itself runs on Node.js, launches the selected consumer runtime, and always forces deterministic offline fixtures. No provider credentials are needed.

## Provider Tiers

The README support matrix is the source of truth for current feature coverage.

At a high level:

- `Tier A`: strongest hosted-agent story, approval-capable remote MCP or equivalent, and best fit for advanced agent workflows
- `Tier B`: strong tool-using agent support with some provider-specific gaps
- `Tier C`: usable for basic loops, but not the default recommendation for full hosted-agent positioning

## What Zhivex Should Support Well

For stable public APIs, support means:

- documented package entrypoints
- test coverage for the shared contract
- explicit release notes for observable behavior changes
- provider capability signaling when a feature is unsupported
- compatible durability primitives for built-in agent stores, including schema-versioned state, idempotency-key lookup, and cooperative cancellation
- stable safety policy helpers for approvals, redaction, budget limits, and provider capability inspection

For provider adapters, support means:

- message mapping
- tool execution flows where documented
- structured output behavior where documented
- streaming behavior where documented
- error normalization where documented

## What Is Not Guaranteed

- Deep imports from internal source files
- Provider-specific undocumented options
- Full feature parity across all providers
- Experimental surfaces described in [STABILITY.md](./STABILITY.md)

## Production Guidance

For production adoption:

- prefer `@zhivex-ai/sdk` unless you need lower-level composition
- choose providers based on the README capability matrix, not package presence alone
- use `inspectProviderAgentSupport()` or `createProviderSupportMatrix()` when provider/model choices need runtime validation
- wrap production agents with `createSafetyPolicy()` when tool side effects, secrets, or token budgets matter
- isolate Tier C or provider-specific escape hatches behind your own service boundary
- review changesets and release notes when upgrading shared contracts in `@zhivex-ai/core`

## Release Communication Expectations

When a published package changes in an observable way, Zhivex should:

- ship a changeset
- describe the affected package scope
- mention compatibility implications when shared contracts change
- review whether `@zhivex-ai/sdk` re-exports and downstream provider dependencies need coordinated updates
