# @zhivex-ai/agents

Agent-first facade for the Zhivex AI SDK runtime.

Use this package when an application wants the portable agent layer without the broader generation, media, artifact, and provider utility surface from `@zhivex-ai/sdk`.

## Install

```bash
bun add @zhivex-ai/agents @zhivex-ai/openai zod
```

Provider packages stay opt-in. Use `@zhivex-ai/openai`, `@zhivex-ai/anthropic`, `@zhivex-ai/gemini`, `@zhivex-ai/vertex`, `@zhivex-ai/qwen`, `@zhivex-ai/bedrock`, or another supported provider to create concrete models.

## Quick Start

```ts
import { Agent } from "@zhivex-ai/agents";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const agent = new Agent({
  model: openai("gpt-5"),
  instructions: "Be concise and use tools when they help.",
  maxSteps: 4
});

const result = await agent.run({
  prompt: "Summarize today's customer escalations."
});

console.log(result.outputText);
console.log(result.state);
```

`Agent` is a stable ergonomic facade over the same core runtime used by `createAgent()` and `runAgent()`. Use `agent.toDefinition()` when a plain object definition is needed by lower-level helpers.

## Entry Points

The package uses explicit entry points so production applications can keep operational, control-plane, realtime, beta, and testing dependencies intentional:

| Import | Stability | Purpose |
| --- | --- | --- |
| `@zhivex-ai/agents` | Stable | Agent execution, tools, HITL, safety, streaming, handoffs, and subagents |
| `@zhivex-ai/agents/ops` | Stable | Stores, memory, tracing, evaluation, replay, costs, and provider-support reports |
| `@zhivex-ai/agents/control-plane` | Stable | Capsules, approval queues, ledgers, governance policy, durable approval resume, and capability routing |
| `@zhivex-ai/agents/beta` | Mixed compatibility | Stable control-plane alias plus remaining Beta harness, audit, and hosted-tool helpers |
| `@zhivex-ai/agents/realtime` | Stable | Live/realtime agent streaming |
| `@zhivex-ai/agents/testing` | Stable | Deterministic model and tool test doubles |

Beta APIs may change between minor releases. Provider-specific realtime options and upstream preview model availability are not promoted by the stable shared realtime contract.

## What This Package Covers

- Stable agent runtime: `Agent`, `createAgent()`, `runAgent()`, `resumeAgent()`, and `streamAgent()`.
- Tool loops: local callable tools, tool-choice support, tool execution options, and approval policies.
- Human-in-the-loop: provider, local-tool, and promoted subagent approval requests, approval queues, replay-bound decisions, and resumable states.
- Typed runs: validated ephemeral context, tool guardrails, and schema-validated final output.
- Durable harnesses: capsule fingerprints, app-provided execution-environment enforcement, and replay-visible context compaction.
- Memory and stores from `/ops`: in-memory, file, SQLite, and Postgres run stores and memory stores.
- Multi-agent patterns: handoffs, subagents as tools, parallel agent groups, and hierarchical traces.
- Durable subagents: stores with atomic idempotency claims reuse a completed child after a failed parent checkpoint instead of repeating child tools.
- Production safety: stable safety policies and budget guards in the root; beta governance policies and audit records under `/beta`.
- Observability and evaluation from `/ops`: trace collectors, run snapshots, replay, cost estimates, and evaluation fixtures.
- Provider inspection from `/ops`, with beta capability routing and model selection under `/beta`.
- Beta control plane from `/beta`: capsules, tool policies, approval queue items, ledgers, golden traces, and inspectable run records.

## Tools

```ts
import { Agent, tool } from "@zhivex-ai/agents";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const agent = new Agent({
  model: openai("gpt-5"),
  maxSteps: 3,
  tools: {
    lookupAccount: tool({
      name: "lookupAccount",
      schema: z.object({ accountId: z.string() }),
      execute: async ({ accountId }) => ({
        accountId,
        status: "active"
      })
    })
  }
});

const result = await agent.run({
  prompt: "Check account acct_123 before answering."
});
```

## Streaming

```ts
const stream = agent.stream({
  prompt: "Give me a live status update."
});

for await (const chunk of stream.textStream) {
  process.stdout.write(chunk);
}

const final = await stream.collect();
console.log(final.state);
```

For server responses, use `toUIAgentStreamResponse()` to expose lifecycle-aware agent streams to browser clients.

## Human Approval

When a provider emits an approval request, or a local tool uses `requiresApproval: true` with `approvalMode: "interrupt"`, the run returns `waiting_approval` and keeps pending requests in `state.pendingApprovals`. Persist the state, collect a user decision, and resume:

```ts
const waiting = await agent.run({ prompt: "Deploy the staging build." });

if (waiting.status === "waiting_approval") {
  const resumed = await agent.resume({
    state: waiting.state,
    approvals: waiting.state.pendingApprovals.map((request) => ({
      provider: request.provider,
      approvalRequestId: request.id,
      approve: true
    }))
  });

  console.log(resumed.outputText);
}
```

Local-tool batches are preflighted before any side effect. On resume, the runtime revalidates the tool input and its approval binding; use `approvalVersion` and an optional `toolApprovalSigner` to invalidate or authenticate persisted decisions. Local approval records are kept in `state.approvalHistory`, not provider messages. A policy can allow, finally deny, or request review with `{ approved: false, approvalRequired: true }`.

`Agent<TModel, TContext, TOutput>` supports `contextSchema`, typed tool execution context, tool input/output guardrails, and `outputSchema`. The parsed context—including Zod transforms and defaults—is shared consistently with policies, guardrails, and tool execution. Supply ephemeral context again on resume. Prompted structured output includes the generated JSON Schema in the model instructions and validates the terminal JSON locally; a completed validated result is available as `result.finalOutput`.

If a subagent pauses for approval, the parent exposes a `kind: "subagent"` request and embeds the resumable child checkpoint in `state.childRuns`. Resume the parent normally; it continues the same child run without forwarding the child approval protocol to the parent model.

Use `createAgentApprovalQueue()` when the application needs queue items with approval tokens and resume URLs.

```ts
import { createAgentApprovalQueue } from "@zhivex-ai/agents/control-plane";
```

## Production State

Use in-memory stores for tests, file stores for local development, and SQL stores for production runtimes that must survive process restarts:

```ts
import { Agent } from "@zhivex-ai/agents";
import { createPostgresAgentMemoryStore, createPostgresAgentRunStore } from "@zhivex-ai/agents/ops";

const agent = new Agent({
  model,
  store: createPostgresAgentRunStore({ client: postgresClient }),
  memory: createPostgresAgentMemoryStore({ client: postgresClient })
});

const result = await agent.run({
  prompt: "Process the request once.",
  scope: { tenantId: "acme", userId: "user-7" },
  idempotencyKey: "request-42"
});
```

For app-facing multi-turn sessions, use `createRunner()` from `@zhivex-ai/sdk`; `@zhivex-ai/agents` intentionally stays focused on the agent runtime facade.

Run stores claim an `idempotencyKey` before model or tool execution and persist every transition with a monotonic revision. Concurrent duplicates share the same run, while a stale resume or cancellation raises `ConflictError`. `scope` is the tenant/user isolation boundary and must accompany later lookup, resume, and cancellation operations.

SQLite and Postgres support renewable worker leases, expired-run recovery, model/tool checkpoints, paginated run queries, retention cleanup, and a durable tool journal. The journal reuses completed results and refuses to repeat an indeterminate effect. Forward `context.idempotencyKey` and `context.abortSignal` from every side-effecting tool to the external API. The file store is a local-development backend with best-effort cross-process coordination.

Store keys are canonical opaque digests of the full identity tuple, so delimiter-containing tenant, user, session, workflow, artifact, run, and memory identifiers remain isolated. File stores create new directories and files with private permissions (`0700`/`0600`). Matching legacy delimiter-based records remain readable and are removed after a successful migrated write.

Active workers observe durable cancellation and abort in-flight provider/tool work. Streams and persisted state are bounded: stream overflow is explicit, step request snapshots are incremental, and `policy.maxStateBytes` defaults to 4 MiB. Telemetry and memory failures are isolated by default and can be reported through `hookFailurePolicy.onError`.

Read-only governance is fail-closed: a tool must declare a non-empty explicit permission set that contains only `read`; missing permission metadata requires review. Production trace collectors retain bounded runs/events and expire old entries. Ledgers redact snapshot, timeline, audit, trace, metadata, and output payloads by default; enable each sensitive family only for an approved server-side destination.

New states use `AGENT_RUN_STATE_SCHEMA_VERSION`. `normalizeAgentRunState()` accepts legacy states without a version or revision, while rejecting unknown future schema versions; `migrateAgentRunState()` is the explicit application-boundary helper.

Capsules created through `createAgentCapsule()` bind a canonical harness fingerprint to the run. Agents may also define `executionEnvironment` to acquire and authorize an app-owned boundary, plus `compaction` to replace an old context prefix with a durable summary before a provider request. The environment adapter is responsible for real isolation; this package does not provide a managed sandbox.

## Provider Tiers

Use provider support helpers before routing important agent workloads:

```ts
import { createAgentCapabilityRouter } from "@zhivex-ai/agents/control-plane";

const router = createAgentCapabilityRouter([openai("gpt-5"), anthropic("claude-sonnet-5")]);
const selected = router.select({
  minTier: "tier-b",
  approvals: true,
  remoteMcp: true
});
```

Tier A means native agent building blocks such as approval-capable remote MCP or equivalent hosted tools. Tier B is strong portable tool-loop support with provider-specific gaps. Tier C is useful for basic tool loops, but not full agent positioning.

## Realtime And Testing

Keep realtime dependencies explicit through the dedicated stable entry point:

```ts
import { streamLiveAgent } from "@zhivex-ai/agents/realtime";
```

Tests can use deterministic doubles without adding them to the production root surface:

```ts
import { createMockLanguageModel, createMockTool } from "@zhivex-ai/agents/testing";
```

## Migrating Root Imports

Earlier versions exposed operations, control-plane helpers, realtime, and mocks from the package root. Move those imports to their owning entry point:

```ts
// Before
import {
  createAgentControlPlane,
  createInMemoryAgentRunStore,
  createMockLanguageModel,
  streamLiveAgent
} from "@zhivex-ai/agents";

// After
import { createInMemoryAgentRunStore } from "@zhivex-ai/agents/ops";
import { createAgentControlPlane } from "@zhivex-ai/agents/control-plane";
import { streamLiveAgent } from "@zhivex-ai/agents/realtime";
import { createMockLanguageModel } from "@zhivex-ai/agents/testing";
```

There is no runtime compatibility shim: unsupported root imports now fail during type checking or module loading instead of silently coupling stable code to a less-stable API.

## When To Use `@zhivex-ai/sdk`

Use `@zhivex-ai/sdk` when you also need the broader high-level API: `generateText()`, `generateObject()`, embeddings, media generation, artifacts, declarative workflows, `Runner + SessionService`, and the CLI.

Use `@zhivex-ai/agents` when you want a narrow stable runtime, and opt into `/ops`, `/beta`, `/realtime`, or `/testing` only where the application needs those capabilities.
