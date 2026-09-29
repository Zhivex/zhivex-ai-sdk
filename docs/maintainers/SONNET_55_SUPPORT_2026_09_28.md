# Claude Sonnet 5.5 support — September 28, 2026

## Scope

The direct Anthropic adapter accepts `claude-sonnet-5-5`, with adaptive thinking by default and shared effort `none` mapped to `between_tools`. Requests with unsupported thinking fields/efforts, forced tools, old computer tools, or incompatible advisor pairings fail locally. Progress and binding controls, opaque history, default server fallback, and native structured output use the existing Messages transport.

Vertex reuses this contract with Google authentication and provider identity. Sonnet 5.5 thinking beta flags go in the request body, and computer/browser toolsets are available. Existing Vertex restrictions still apply to server fallback, advisor tools, on-demand compaction, and mid-conversation tool changes. The SDK catalog has separate direct and Google routes, with verified token/cache pricing only for the direct route. The legacy core catalog remains frozen.

## Validation

- `bun run docs:check`: passed.
- `bun run typecheck`: passed, including repository examples.
- `bun run test`: 224 files passed, 3 skipped; 3,120 tests passed, 4 skipped.
- `bun run build`: passed from regenerated dist output.
- `ZHIVEX_SONNET55_LIVE=1 bun --env-file=.env run test:integration packages/anthropic/tests/sonnet55.integration.test.ts`: 5 passed, no skips, against `https://api.anthropic.com/v1` and model `claude-sonnet-5-5`.

The first full unit run was blocked by sandbox `listen EPERM` on existing loopback WebSocket tests. The complete suite passed when run with local socket permissions.

The direct live smoke verifies text and usage with `between_tools`, adaptive streaming, native JSON Schema output, an automatic client-tool loop with continuation, and progress/binding beta acceptance with append-only history replay. It uses a 1,024-token output limit per call, no retries, a 45-second request timeout, and a maximum of three tool-loop steps. No credential values or raw live payloads are included in this report.

## Evidence boundaries

Vertex has mocked contract coverage; Google Cloud access was not live-certified. Computer/advisor tools, default server fallback, and compaction were not live-certified by the five-test direct smoke. Progress/binding acceptance and history replay do not prove every account-specific signature failure mode. Bedrock and other Claude hosts are not certified by this work. Per-message effort and inline tool definitions have no dedicated shared helpers.

This is checkout validation, not an npm publication or installed-package certification. The changeset prepares Anthropic, Vertex, and SDK packages for the protected release workflow; no versions were published.

## Primary sources

- [Sonnet 5.5 specifications and pricing](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
- [Sonnet 5.5 breaking changes](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5)
- [Advisor model compatibility](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#model-compatibility)
- [Sonnet 5.5 on Google Cloud](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/sonnet-5-5)
