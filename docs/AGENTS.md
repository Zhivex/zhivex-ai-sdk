# Agents Guide

This guide is the adoption path for the agent-focused release of Zhivex AI SDK.

Zhivex agents are designed for server-side TypeScript applications that need portable tool-using agents across providers, resumable state, human approvals, memory, tracing, evaluations, and provider capability routing.

Related guides:

- [Next.js Runner Guide](./NEXTJS.md): server route handlers and streaming UI shape.
- [Workflows Guide](./WORKFLOWS.md): deterministic multi-step agent workflows.
- [Agent Observability Guide](./OBSERVABILITY.md): traces, audit records, ledgers, golden traces, and evaluations.
- [Workspace Agents Guide](./WORKSPACE_AGENTS.md): shell/apply-patch harnesses, approvals, and app-owned execution boundaries.

## Choose The Entry Point

Use `Agent` for new agent code:

```ts
import { Agent } from "@zhivex-ai/sdk";
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
  prompt: "Plan the next support response."
});
```

Use `createAgent()` and `runAgent()` when you prefer a functional API, plain object definitions, or compatibility with existing integrations:

```ts
import { createAgent, runAgent } from "@zhivex-ai/sdk";

const agent = createAgent({ model, instructions: "Keep answers short." });
const result = await runAgent(agent, { prompt: "Summarize this case." });
```

Use `@zhivex-ai/agents` instead of `@zhivex-ai/sdk` when you want the smaller agent-only facade. Use `@zhivex-ai/sdk` when the app also needs `Runner`, workflows, artifacts, embeddings, media generation, or the CLI.

## Runtime Contract

Every agent run returns a serializable `state`:

- `messages`: normalized messages and tool results.
- `steps`: model calls with request/response snapshots.
- `toolResults`: executed local tool results.
- `pendingApprovals`: provider approval requests that need a human decision.
- `usage`: normalized token usage when providers return it.
- `status`: `completed`, `waiting_approval`, `failed`, `timed_out`, `cancel_requested`, or another production state.

Persist the state in your app, or attach an SDK run store:

```ts
import { Agent, createPostgresAgentRunStore } from "@zhivex-ai/sdk";

const agent = new Agent({
  model,
  store: createPostgresAgentRunStore({ client: postgresClient })
});
```

## Tools And Safety

Tools are app-owned functions with Zod schemas:

```ts
import { Agent, applySafetyPolicyToAgent, createProductionSafetyPolicy, tool } from "@zhivex-ai/sdk";
import { z } from "zod";

const baseAgent = new Agent({
  model,
  maxSteps: 4,
  tools: {
    lookupOrder: tool({
      name: "lookupOrder",
      schema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => ({ orderId, status: "shipped" })
    })
  }
});

const agent = applySafetyPolicyToAgent(
  baseAgent.toDefinition(),
  createProductionSafetyPolicy()
);
```

Use approval policies for write, network, filesystem, code-execution, shell, payment, deployment, or other external side-effect tools. Use redaction policies before exporting traces or audit records.

## Human-In-The-Loop

Provider approval waits and local approval policies use the same resumable state pattern:

```ts
const waiting = await agent.run({ prompt: "Use the remote MCP server." });

if (waiting.status === "waiting_approval") {
  const approved = await agent.resume({
    state: waiting.state,
    approvals: waiting.state.pendingApprovals.map((request) => ({
      provider: request.provider,
      approvalRequestId: request.id,
      approve: true
    }))
  });

  console.log(approved.outputText);
}
```

For app-facing queues, use `createAgentApprovalQueue()` to turn pending requests into items with approval tokens, reasons, expiration, and resume URLs.

## Streaming And UI

Use `agent.stream()` for lifecycle-aware streaming:

```ts
const stream = agent.stream({ prompt: "Draft a status update." });

for await (const text of stream.textStream) {
  process.stdout.write(text);
}

const final = await stream.collect();
```

Use `toUIAgentStreamResponse()` for server routes that need UI stream chunks with agent lifecycle events, approval requests, tool progress, and final state.

## Sessions

`Agent` runs are single-run primitives. For user-facing multi-turn apps, wrap an agent in `Runner + SessionService` from `@zhivex-ai/sdk`:

```ts
import { Agent, createFileSessionService, createRunner } from "@zhivex-ai/sdk";

const runner = createRunner({
  appName: "support-copilot",
  agent: new Agent({ model, instructions: "Help support agents reply." }),
  sessionService: createFileSessionService({
    directory: ".zhivex/sessions"
  })
});
```

Use Postgres sessions for production serverless deployments.

## Multi-Agent Patterns

Use the smallest pattern that matches the workflow:

- Handoffs: sequential ownership transfer from one agent to another.
- Subagents: model-driven delegation inside an agent loop through generated tool calls.
- `runAgentGroup()`: deterministic fan-out from application code.
- Workflows: explicit deterministic control flow with sequential, parallel, and loop steps.

Use subagents when the model should decide whether to delegate. Use workflows when your app already knows the step order.

## Evaluation And Operations

Production agent work should produce inspectable artifacts:

- `createAgentRunSnapshot()` and `replayAgentRun()` for deterministic review.
- `createAgentTraceArtifact()` and `summarizeAgentTrace()` for trace summaries.
- `createAgentAuditRecord()` and `createToolAuditRecords()` for redacted audit logs.
- `createAgentRunLedger()` for control-plane records that combine snapshot, replay, audit, tool audit, trace, summary, and optional cost.
- `createAgentEvaluationFixture()` and `runAgentEvaluationFixture()` for regression suites.
- `promoteAgentGoldenTrace()` for turning a successful run into a regression baseline.

The CLI in `@zhivex-ai/sdk` can inspect saved states and ledgers locally:

```bash
zhivex-ai agents ledger --state agent-run-state.json --out run-ledger.json
zhivex-ai agents inspect --ledger run-ledger.json
zhivex-ai agents golden --ledger run-ledger.json --name happy-path --out golden-trace.json
```

## Provider Positioning

Zhivex is strongest when the agent must be portable across providers:

| Capability | Zhivex AI SDK | OpenAI Agents SDK | Vercel AI SDK | LangGraph | Mastra |
| --- | --- | --- | --- | --- | --- |
| Multi-provider agent contract | Strong | OpenAI-first | Strong JS provider ecosystem | Integration-based | Router/framework-based |
| Human approvals | Runtime state + queues | Native HITL | Tool approval flows | Interrupts/checkpoints | Approval APIs |
| Durable state | Run/session/workflow stores | Sessions | App persistence | Checkpointing focus | Storage/framework services |
| UI streaming | Agent/UI stream helpers | Realtime/voice focus | Best React/UI DX | Event streaming | Streaming APIs + Studio |
| Graph orchestration | Beta workflows | Code orchestration | Code patterns | Strongest graph runtime | Strong workflows |
| Product UI/Studio | Local CLI/artifacts | OpenAI platform | DevTools | LangSmith | Mastra Studio |

Use Zhivex when provider portability, capability routing, Gateway alignment, explicit state, and local control-plane artifacts matter more than a managed platform UI.

## Release Readiness Checklist

Before cutting an agent-focused release:

1. Run focused agent tests: `bun test packages/core/tests/agent.test.ts packages/core/tests/runner.test.ts packages/core/tests/workflow.test.ts packages/core/tests/agent-control-plane.test.ts packages/agents/tests/agents.test.ts`.
2. Run API stability and type snapshot tests.
3. Run `bun run typecheck`, `bun run test`, and `bun run build`.
4. Verify the provider matrix still describes current adapter behavior.
5. Confirm the changeset includes every published package with changed exports or docs.
