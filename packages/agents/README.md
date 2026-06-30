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

## What This Package Covers

- Stable agent runtime: `Agent`, `createAgent()`, `runAgent()`, `resumeAgent()`, and `streamAgent()`.
- Tool loops: local callable tools, tool-choice support, tool execution options, and approval policies.
- Human-in-the-loop: provider approval requests, approval response parts/messages, approval queues, and resumable states.
- Memory and stores: in-memory, file, SQLite, and Postgres run stores and memory stores.
- Multi-agent patterns: handoffs, subagents as tools, parallel agent groups, and hierarchical traces.
- Production safety: safety policies, budget guards, read-only approval policies, redaction, and audit records.
- Observability and evaluation: trace collectors, run snapshots, replay, cost estimates, golden traces, evaluation fixtures, and ledgers.
- Provider routing: support matrices, agent capability routing, model selection, hosted-tool summaries, and provider drift reports.
- Beta control plane: capsules, tool policies, approval queue items, ledgers, golden traces, and inspectable control-plane run records.

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

When a provider emits an approval request, the run returns `waiting_approval` and keeps pending requests in `state.pendingApprovals`. Persist the state, collect a user decision, and resume:

```ts
const waiting = await agent.run({ prompt: "Use the remote MCP server." });

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

Use `createAgentApprovalQueue()` when the application needs queue items with approval tokens and resume URLs.

## Production State

Use in-memory stores for tests, file stores for local development, and SQL stores for production runtimes that must survive process restarts:

```ts
import { Agent, createPostgresAgentRunStore, createPostgresAgentMemoryStore } from "@zhivex-ai/agents";

const agent = new Agent({
  model,
  store: createPostgresAgentRunStore({ client: postgresClient }),
  memory: createPostgresAgentMemoryStore({ client: postgresClient })
});
```

For app-facing multi-turn sessions, use `createRunner()` from `@zhivex-ai/sdk`; `@zhivex-ai/agents` intentionally stays focused on the agent runtime facade.

## Provider Tiers

Use provider support helpers before routing important agent workloads:

```ts
import { createAgentCapabilityRouter } from "@zhivex-ai/agents";

const router = createAgentCapabilityRouter([openai("gpt-5"), anthropic("claude-sonnet-5")]);
const selected = router.select({
  minTier: "tier-b",
  approvals: true,
  remoteMcp: true
});
```

Tier A means native agent building blocks such as approval-capable remote MCP or equivalent hosted tools. Tier B is strong portable tool-loop support with provider-specific gaps. Tier C is useful for basic tool loops, but not full agent positioning.

## When To Use `@zhivex-ai/sdk`

Use `@zhivex-ai/sdk` when you also need the broader high-level API: `generateText()`, `generateObject()`, embeddings, media generation, artifacts, declarative workflows, `Runner + SessionService`, and the CLI.

Use `@zhivex-ai/agents` when you want the smallest public package surface for portable agents, stores, safety, tracing, evaluation, provider support, and control-plane helpers.
