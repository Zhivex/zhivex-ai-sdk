# Agent Release Readiness

Use this checklist when a release is positioned around the agent runtime or `@zhivex-ai/agents`.

## Public Surface

Confirm these entry points are intentionally exposed and classified:

```bash
bun test packages/core/tests/api-stability.test.ts packages/core/tests/api-type-snapshot.test.ts
```

Required stable root entry points from `@zhivex-ai/agents`:

- `Agent`
- `createAgent`
- `runAgent`
- `resumeAgent`
- `streamAgent`
- `createRunner` and session services from `@zhivex-ai/sdk`
- production safety, redaction, budget, approvals, handoffs, subagents, and UI streaming

Required stable operations entry points from `@zhivex-ai/agents/ops`:

- agent run stores and memory stores
- trace collectors, snapshots, replay, and cost helpers
- evaluation fixtures and reports
- provider-support inspection and matrix reports

Beta entry points from `@zhivex-ai/agents/beta` may remain beta if their docs say so:

- control-plane capsules
- approval queues
- run ledgers
- golden traces
- capability router

`streamLiveAgent` is Stable and remains isolated under the dedicated `@zhivex-ai/agents/realtime` entry point so the agent root stays narrow. Deterministic mocks belong under the stable `@zhivex-ai/agents/testing` entry point; neither belongs in the root.

Declarative workflows and the in-memory/file workflow state services are stable surfaces in `@zhivex-ai/sdk`; they are intentionally not re-exported by `@zhivex-ai/agents/beta`. SQL workflow state services, workflow evaluations, artifact helpers, and CLI workflow commands remain Beta.

## Focused Test Gate

Run the focused agent suite before the full repo gate:

```bash
bun test \
  packages/core/tests/agent.test.ts \
  packages/core/tests/agent-production.test.ts \
  packages/core/tests/agent-state.test.ts \
  packages/core/tests/bounded-broadcast.test.ts \
  packages/core/tests/budget-preflight.test.ts \
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

The production runtime gate must include a concurrent idempotency repro, expired-lease recovery, crash-after-tool recovery without repeated side effects, active cancellation, tenant-scope isolation, bounded-stream overflow, state-size rejection, and telemetry/memory hook isolation. Validate SQL concurrency with SQLite or Postgres semantics; the file backend is not the production concurrency reference.

Then run the standard release gate:

```bash
bun run typecheck
bun run test
bun run build
bun run smoke:packages
```

After the build, verify the actual emitted entry points without network access:

```bash
bun run packages/agents/tests/dist-entrypoints.smoke.ts
```

The root build removes every package `dist/` directory before TypeScript emits files. Do not bypass it with a package-local incremental build when packing a release; stale modules from removed source files must never enter npm tarballs.

Run provider smoke when credentials are available:

```bash
bun run smoke:providers
```

Before certifying an agent-focused release, run the fail-closed live agent gate
against Gemini, DeepSeek, Qwen, and a disposable Postgres database:

```bash
ZHIVEX_POSTGRES_INTEGRATION_URL=postgres://user:password@127.0.0.1:5432/database \
bun run test:integration:agents
```

The gate defaults to `gemini,deepseek,qwen`; override the exact set with
`ZHIVEX_AGENT_LIVE_PROVIDERS=gemini,deepseek,qwen`. It fails instead of
skipping when any requested provider credential or the Postgres URL is missing.
For every provider it validates a real forced tool call, local approval wait,
process/client restart, approval resume, exactly-once tool execution, durable
tool journal, streaming lifecycle, and final-state persistence. It also checks
real Postgres idempotency claims, compare-and-swap, leases, and concurrent tool
journal ownership with separate database connections.
The latest recorded matrix and scope are in
[`AGENT_LIVE_CERTIFICATION.md`](./AGENT_LIVE_CERTIFICATION.md).

Realtime/live-agent certification is a separate fail-closed gate. With the three
provider credentials in `.env`, run:

```bash
bun --env-file=.env run test:integration:agents-realtime
```

The dedicated command sets `ZHIVEX_LIVE_AGENT_CERTIFICATION=1`; when active, the
suite fails rather than skipping if Gemini, Qwen, or OpenAI credentials are
missing. It exercises `streamLiveAgent()` through all three real realtime
providers, requires one local tool execution, requires a non-empty response after
the tool result, and verifies session closure within 45 seconds. Model overrides
are optional and documented in
[`AGENT_REALTIME_CERTIFICATION.md`](./AGENT_REALTIME_CERTIFICATION.md). A green
gate is required release evidence for the Stable realtime/live contract.

Before publishing, repeat the approval/restart/journal path from tarballs
installed in an isolated Bun consumer:

```bash
ZHIVEX_POSTGRES_INTEGRATION_URL=postgres://user:password@127.0.0.1:5432/database \
bun run smoke:packages:agents-live
```

This second gate packs `core`, `agents`, Gemini, DeepSeek, and Qwen, installs
those tarballs through `file:` dependencies, and executes only their public npm
entrypoints. It is also fail-closed for the database and provider credentials.

The general installed-package gate also runs an offline deterministic realtime
consumer through the packed `@zhivex-ai/core`, `@zhivex-ai/sdk`, and
`@zhivex-ai/agents/realtime` entrypoints:

```bash
bun run smoke:packages
```

It constructs `CallbackRealtimeSession`, executes `streamLiveAgent`, emits an
initial tool-call response, returns one tool result, waits for the non-empty
post-tool response, observes both response-complete events, and proves the
connection closes. This detects packaging, entrypoint, and tool-continuation
regressions without claiming live provider certification.

Before releasing workflow changes or promoting a remaining SQL persistence
service, run the opt-in live workflow certification with Gemini or Qwen and a
disposable Postgres database:

```bash
ZHIVEX_INTEGRATION_PROVIDER=gemini \
ZHIVEX_POSTGRES_INTEGRATION_URL=postgres://user:password@127.0.0.1:5432/database \
bun run test:integration:workflows

ZHIVEX_INTEGRATION_PROVIDER=qwen \
ZHIVEX_POSTGRES_INTEGRATION_URL=postgres://user:password@127.0.0.1:5432/database \
bun run test:integration:workflows
```

The Postgres suite creates uniquely named `zhivex_it_*` tables, validates
restart/resume, compare-and-swap conflicts, artifact durability, and tenant
isolation, then drops those tables. Keep the database URL opt-in so normal test
runs cannot target an application database accidentally.

Run the deterministic public workflow example as a credential-free smoke:

```bash
bun run examples/sdk/workflow.ts
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

The package README for `@zhivex-ai/agents` should be a standalone npm landing page: install, quick start, tools, streaming, human approvals, stores, provider tiers, entry-point stability, root-import migration, and when to use the broader SDK.

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
- `@zhivex-ai/agents`: agent facade exports, subpath metadata, or README changes.
- provider packages: only when their agent capabilities, hosted tools, MCP, realtime, or support tiers change.

New stable public exports should normally be a minor bump. Bug fixes and documentation-only package README updates can be patch bumps unless they are part of a broader minor release.
