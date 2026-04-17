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
- `@zhivex-ai/openai`
- `@zhivex-ai/azure-openai`
- `@zhivex-ai/anthropic`
- `@zhivex-ai/gemini`
- `@zhivex-ai/vertex`
- `@zhivex-ai/bedrock`
- `@zhivex-ai/ollama`
- `@zhivex-ai/openrouter`
- `@zhivex-ai/qwen`
- `@zhivex-ai/kimi`
- `@zhivex-ai/gateway`

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
- isolate Tier C or provider-specific escape hatches behind your own service boundary
- review changesets and release notes when upgrading shared contracts in `@zhivex-ai/core`

## Release Communication Expectations

When a published package changes in an observable way, Zhivex should:

- ship a changeset
- describe the affected package scope
- mention compatibility implications when shared contracts change
- review whether `@zhivex-ai/sdk` re-exports and downstream provider dependencies need coordinated updates
