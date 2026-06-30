# Agent Release Readiness

Use this checklist when a release is positioned around the agent runtime or `@zhivex-ai/agents`.

## Public Surface

Confirm these entry points are intentionally exposed and classified:

```bash
bun test packages/core/tests/api-stability.test.ts packages/core/tests/api-type-snapshot.test.ts
```

Required stable agent entry points:

- `Agent`
- `createAgent`
- `runAgent`
- `resumeAgent`
- `streamAgent`
- agent run stores and memory stores
- `createRunner` and session services from `@zhivex-ai/sdk`
- production safety, redaction, budget, trace, replay, and evaluation helpers

Beta agent-ops entry points may remain beta if their docs say so:

- control-plane capsules
- approval queues
- run ledgers
- golden traces
- capability router
- declarative workflows and workflow state services

## Focused Test Gate

Run the focused agent suite before the full repo gate:

```bash
bun test \
  packages/core/tests/agent.test.ts \
  packages/core/tests/runner.test.ts \
  packages/core/tests/workflow.test.ts \
  packages/core/tests/agent-control-plane.test.ts \
  packages/core/tests/agent-evaluation.test.ts \
  packages/core/tests/workflow-evaluation.test.ts \
  packages/core/tests/observability.test.ts \
  packages/agents/tests/agents.test.ts \
  packages/sdk/tests/sdk.test.ts \
  packages/core/tests/api-stability.test.ts \
  packages/core/tests/api-type-snapshot.test.ts
```

Then run the standard release gate:

```bash
bun run typecheck
bun run test
bun run build
```

Run provider smoke when credentials are available:

```bash
bun run smoke:providers
```

## Example Smoke

These deterministic examples should run without provider credentials:

```bash
bun run examples/sdk/full-agent.ts
bun run examples/agents/full-agent.ts
bun run examples/agents/approval-hitl.ts
bun run examples/sdk/agent-control-plane.ts
bun run examples/sdk/runner-session.ts
bun run examples/sdk/rag-agent.ts
```

If a deterministic example imports from workspace source, that is intentional for repo-local smoke. Public docs should still show package imports such as `@zhivex-ai/sdk` or `@zhivex-ai/agents`.

## Docs Gate

Before publishing, verify that these docs describe the same agent surface:

- `README.md`
- `docs/AGENTS.md`
- `docs/NEXTJS.md`
- `docs/WORKFLOWS.md`
- `docs/OBSERVABILITY.md`
- `docs/WORKSPACE_AGENTS.md`
- `docs/QUICKSTART.md`
- `docs/PRODUCTION.md`
- `docs/MIGRATION.md`
- `packages/agents/README.md`
- `packages/sdk/README.md`
- `examples/README.md`
- `examples/next-runner/README.md`

The package README for `@zhivex-ai/agents` should be a standalone npm landing page: install, quick start, tools, streaming, human approvals, stores, provider tiers, and when to use the broader SDK.

The Next.js example should include both simple JSON and streaming route handlers so the release has a concrete UI integration story.

## Competitive Positioning

Use this framing in release notes:

- Zhivex: portable multi-provider agents, provider capability routing, explicit resumable state, local stores, safety policies, evaluation, trace/audit artifacts, and Gateway-friendly routing.
- OpenAI Agents SDK: strongest OpenAI-native sandbox, voice/realtime, hosted tools, and platform integration.
- Vercel AI SDK: strongest React/UI streaming developer experience.
- LangGraph: strongest graph/checkpoint orchestration and LangSmith platform path.
- Mastra: strongest full TypeScript app framework and Studio-style local product experience.

Do not claim full parity with sandbox/workspace UI platforms unless the release includes first-class workspace execution, snapshots, and operator UI.

## Changeset Scope

Create or update a changeset when the release changes public agent behavior, exports, docs, or package metadata:

- `@zhivex-ai/core`: shared runtime contract changes.
- `@zhivex-ai/sdk`: aggregator exports, docs, CLI, Runner, workflows, or examples.
- `@zhivex-ai/agents`: agent facade exports or README changes.
- provider packages: only when their agent capabilities, hosted tools, MCP, realtime, or support tiers change.

New stable public exports should normally be a minor bump. Bug fixes and documentation-only package README updates can be patch bumps unless they are part of a broader minor release.
