# Zhivex AI SDK

Zhivex AI SDK is a TypeScript monorepo for Bun and Node that provides a unified, provider-agnostic API for modern LLM workflows.

It is designed around a small shared contract in `@zhivex-ai/core` and thin provider adapters on top of it, so application code can stay stable while models and vendors change underneath.

## Stability And Support

The SDK now documents its public contract and release expectations more explicitly:

- [STABILITY.md](./STABILITY.md)
- [SUPPORT.md](./SUPPORT.md)
- [VERSIONING.md](./VERSIONING.md)

For production integrations, prefer supported public package entrypoints and use the provider capability matrix below as the source of truth for cross-provider behavior.

Runtime exports from `@zhivex-ai/core` are also classified by a verifiable API manifest:

```ts
import { getApiStability } from "@zhivex-ai/sdk";

console.log(getApiStability("createWorkflow")?.stability); // "beta"
```

Runtime export drift is guarded by that manifest, and public declaration drift is guarded by type snapshot tests for `@zhivex-ai/core` and `@zhivex-ai/sdk`.

The first stable promotion is intentionally narrow: `Runner + SessionService` is Stable, while declarative workflows, artifacts, workflow state services, and the CLI remain Beta.

### Installing The Stable Package

The current stable package is published on npm under the `latest` dist-tag:

```bash
bun add @zhivex-ai/sdk
```

Use `@next` only for prerelease validation:

```bash
bun add @zhivex-ai/sdk@next
```

Use the SDK from server runtimes: Node.js, Bun, Next.js route handlers/server actions, API servers, or background workers. Browser React clients should call your backend instead of importing provider-backed runners directly, because provider credentials, tools, database clients, and durable stores must stay server-side.

For local development, file-backed stores are convenient. For serverless and production deployments, prefer database-backed services such as `createPostgresSessionService()` over file stores, because serverless filesystems are usually ephemeral and not shared across instances.

## Start Here

Use these guides when adopting the SDK in a real app:

- [Quickstart](./docs/QUICKSTART.md): install the stable package and run a multi-turn `Runner`.
- [Agents Guide](./docs/AGENTS.md): build portable, resumable, governable agents with tools, approvals, streaming, stores, tracing, evaluations, and provider routing.
- [Next.js Runner Guide](./docs/NEXTJS.md): route handler plus React client shape.
- [Production Guide](./docs/PRODUCTION.md): store choices, server-only boundaries, identity mapping, safety, observability, workflows, and artifacts.
- [Workflows Guide](./docs/WORKFLOWS.md): deterministic multi-step agent workflows, durable state, replay, and workflow evaluations.
- [Agent Observability Guide](./docs/OBSERVABILITY.md): traces, audit records, ledgers, golden traces, evaluations, and local inspection.
- [Workspace Agents Guide](./docs/WORKSPACE_AGENTS.md): shell/apply-patch harnesses, app-owned execution boundaries, approvals, and safety requirements.
- [Migration Guide](./docs/MIGRATION.md): move from direct provider SDKs, Vercel AI SDK core usage, or simple tool loops.
- [RAG Guide](./docs/RAG.md): lightweight retrieval contracts, semantic memory boundaries, and app-owned vector store recipes.
- [Examples](./examples/README.md): runnable TypeScript examples, including a deterministic runner/session example and a Next.js reference.

Production adoption path:

1. Start with `Runner + SessionService`.
2. Use `createPostgresSessionService()` for shared/serverless production state.
3. Keep provider credentials, tools, database clients, and safety policies on the server.
4. Wrap tool-using agents with `createProductionSafetyPolicy()` before exposing them to real users.
5. Export redacted trace summaries and tool-call audit records from server-side runs.
6. Use app-owned retrievers/vector stores for long-term semantic memory.

## Why Zhivex AI SDK

- Unified primitives for text generation, streaming, structured output, tools, multimodal messages, and embeddings.
- Consistent message and event contracts across providers.
- Provider adapters that focus on API translation instead of re-implementing business logic.
- ESM-first TypeScript packages intended for server runtimes such as Bun and modern Node.js.
- Incremental adoption: install only the providers your application uses.

## Supported Packages

### Aggregator

- `@zhivex-ai/sdk`: recommended entry point for most applications. Re-exports the public high-level API from `core`.

### Core

- `@zhivex-ai/core`: shared types, message helpers, runtime utilities, stream helpers, middleware, model catalog, and generation primitives.

### Agents

- `@zhivex-ai/agents`: agent-first facade over `core` for applications that only need the portable agent runtime, stores, memory, safety, tracing, evaluation, and provider support helpers.

### Providers

- `@zhivex-ai/openai`
- `@zhivex-ai/meta`
- `@zhivex-ai/azure-openai`
- `@zhivex-ai/anthropic`
- `@zhivex-ai/gemini`
- `@zhivex-ai/vertex`
- `@zhivex-ai/qwen`
- `@zhivex-ai/kimi`
- `@zhivex-ai/deepseek`
- `@zhivex-ai/openrouter`
- `@zhivex-ai/bedrock`
- `@zhivex-ai/ollama`

### Routing

- `@zhivex-ai/gateway`: policy-based routing and fallback layer across registered provider adapters.

## Installation

Install the SDK plus the provider packages you need:

```bash
bun add @zhivex-ai/sdk @zhivex-ai/openai
```

If you use structured output or tool schemas in your application code, install `zod` as well:

```bash
bun add zod
```

Additional providers are opt-in:

```bash
bun add @zhivex-ai/anthropic
bun add @zhivex-ai/meta
bun add @zhivex-ai/gemini
bun add @zhivex-ai/vertex
bun add @zhivex-ai/qwen
bun add @zhivex-ai/kimi
bun add @zhivex-ai/deepseek
bun add @zhivex-ai/openrouter
bun add @zhivex-ai/azure-openai
bun add @zhivex-ai/bedrock
bun add @zhivex-ai/ollama
bun add @zhivex-ai/gateway
bun add @zhivex-ai/agents
```

If you prefer working directly with the shared contract:

```bash
bun add @zhivex-ai/core @zhivex-ai/openai
```

## Examples

The repository includes runnable examples under [`examples/`](./examples/README.md) covering:

- high-level SDK flows
- agent runtime, lifecycle streaming, and UI/SSE transport
- structured output, tools, embeddings, UI helpers, and middleware
- provider-specific setup for each adapter package
- gateway routing and fallback

## Quick Start

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  prompt: "Describe Zhivex AI SDK in one sentence."
});

console.log(result.text);
console.log(result.usage);
```

The high-level API accepts either a `prompt` or explicit `messages`, and returns normalized output including text, messages, finish reason, usage, tool results, and execution steps.

## Provider Compatibility

The SDK aims to keep the application-facing contract stable, but capability parity is not identical across providers yet. Use this matrix as the source of truth for the currently implemented SDK behavior.

Status shorthand:

- `yes`: implemented in the SDK adapter.
- `model-dependent`: implemented, but gated by the selected model family.
- `endpoint-dependent`: implemented only on a specific provider endpoint or API mode.
- `env/live-tested`: included in the integration registry and skipped unless credentials are present.

<!-- provider-matrix:start -->
| Provider | `streamText` | Tools | `toolChoice` | Structured output | Embeddings | Audio in | Audio out | Realtime sessions | Browser tokens | Reasoning | Web search | Hosted tools / MCP | Agent tier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | `effort` | yes | model-dependent Responses hosted tools, remote MCP, shell/apply patch harness | Tier A |
| Meta | yes | yes | yes | native | no | no | no | no | no | `effort` | yes | Responses web search, tool search, Files API, prompt caching | Tier B |
| Azure OpenAI | yes | yes | yes | native | yes | yes | yes | yes | yes | `effort` | yes | model-dependent Responses hosted tools, remote MCP, shell/apply patch harness | Tier A |
| Anthropic | yes | yes | yes | prompted | no | no | no | no | no | model-dependent | yes | native MCP, web search, code execution | Tier B |
| Gemini | yes | yes | yes | native | yes | yes | yes | yes | yes | model-dependent | yes | native | Tier B |
| Vertex | yes | yes | yes | native | yes | yes | yes | yes | no | model-dependent | yes | native | Tier B |
| OpenRouter | yes | yes | yes | native | no | no | no | no | no | `effort` + `budgetTokens` | yes | server tools | Tier C |
| Qwen | yes | yes | yes | native | yes | no | no | no | no | model-dependent | yes | Responses web search, web extractor, code interpreter, file search, remote MCP, image search; Cloud files, batch, media, speech, realtime | Tier B |
| Kimi | yes | yes | yes | native | no | no | no | no | no | model-dependent | Formula tool | Formula tools via Chat Completions | Tier C |
| DeepSeek | yes | yes | yes | JSON object | no | no | no | no | no | `effort` | no | no | Tier B |
| Bedrock | yes | yes | endpoint-dependent | native | no | no | no | no | no | endpoint-dependent | endpoint-dependent | Converse baseline or Mantle/OpenAI-compatible Responses hosted tools and remote MCP | Tier C / A by runtime |
| Ollama | yes | yes | no | native | yes | no | no | no | no | no | no | no | Tier C |
<!-- provider-matrix:end -->

Compatibility notes:

- `structured output` means the SDK can use the shared `generateObject()` / `streamObject()` contract. `native` means schema-aware provider support; `prompted` means SDK fallback prompting instead of provider-native schema enforcement.
- `Realtime sessions` means the provider package exposes `realtimeModel().connect()` through the shared `RealtimeSession` contract. `Browser tokens` means the provider also exposes `realtimeModel().createBrowserToken()` for short-lived client-side credentials.
- Gemini, Vertex, Azure OpenAI, and the current OpenAI `gpt-realtime`, `gpt-realtime-2`, and `gpt-realtime-mini` models support `session.sendMedia()` for image inputs such as `image/jpeg`, which is useful for browser camera-frame loops. Older OpenAI realtime preview models such as `gpt-4o-realtime-preview` and `gpt-4o-mini-realtime-preview` do not currently support image input.
- Gemini and Vertex also expose Google generative media endpoints through `generateImage()`, `generateVideo()`, and `generateMusic()` where the selected model and endpoint support them, including Gemini Image / Nano Banana, Imagen, Veo, and Lyria.
- Gemini exposes Files API, File Search stores, URL Context, Context Caching, Batch API, Interactions, hosted Google tools, and raw prediction helpers. Vertex exposes Context Caching, Batch API, hosted Google tools, and generic prediction helpers for publisher / Model Garden endpoints. Full Model Garden coverage is through `predictionModel()` and raw responses, not hand-written wrappers per model.
- `model-dependent` means the provider package exposes the shared capability, but the exact accepted config depends on the selected model family. OpenAI and Azure OpenAI expose model-specific agent capabilities at runtime; for example Responses computer use is accepted on `gpt-5.5` and the current `gpt-5.4` family, while `tool_search` remains limited to the supported `gpt-5.4` variants in this SDK and unsupported combinations are rejected before a request is sent. Anthropic reasoning currently maps `effort` on Claude Sonnet 5, Claude Fable 5, Claude Mythos 5, Claude Opus 4.5, Opus 4.6, Sonnet 4.6, and Opus 4.7+ including Opus 4.8, while `budgetTokens` remains available only on Anthropic models that still accept manual thinking such as Claude Haiku 4.5. Claude Fable 5 and Claude Mythos 5 always use adaptive thinking, so the adapter does not send redundant `thinking: { type: "adaptive" }` for common `reasoning.effort` and rejects `thinking.disabled` or manual thinking budgets before the request is sent. Gemini and Vertex reasoning currently map `effort` for Gemini 3 models and `budgetTokens` for Gemini 2.5 and earlier models. Qwen reasoning currently maps to `enable_thinking` plus optional `thinking_budget` on supported model families such as `qwen3.7-plus`, `qwen3.7-max`, `qwen-plus`, `qwen-turbo`, `qwq`, and `qwen3*`. Kimi reasoning currently maps to `thinking.enabled/disabled` for `kimi-k2.6`, `kimi-k2.5`, and legacy thinking models; `kimi-k2.7-code` and `kimi-k2.7-code-highspeed` are always-thinking models and reject disabled thinking plus non-default sampling controls before a request is sent. DeepSeek reasoning maps `effort` to `thinking` plus `reasoning_effort` for `deepseek-v4-flash` and `deepseek-v4-pro`.
- Bedrock native Converse supports common `toolChoice` values by mapping specific tools and required tools to AWS-native `toolConfig`, and by omitting tool configuration for `toolChoice: "none"`. Bedrock native Converse uses the AWS SDK credential chain by default; it also supports Amazon Bedrock API keys through `AWS_BEARER_TOKEN_BEDROCK` or `createBedrock({ region, apiKey })` for development and exploration. Bedrock OpenAI-compatible mode uses a Mantle/OpenAI-compatible base URL and sends Requests to `/responses`; pass AWS's `OPENAI_API_KEY` / `OPENAI_BASE_URL` values explicitly as `apiKey` / `baseURL` if you use that naming. In the SDK's agent matrix, Bedrock Tier A applies to `createBedrock({ runtime: "openai" })`, which exposes Responses hosted tools, remote MCP, and approval requests. AWS-native AgentCore MCP is exposed separately as SDK-managed MCP tools for Converse or any shared agent loop; it does not promote Converse itself to a provider-emitted approval runtime.
- Kimi thinking mode has an extra provider rule reflected in the SDK: when reasoning is enabled, forced tool choice is not supported and `toolChoice` must remain `auto` or `none`.
- DeepSeek is Tier B for portable tool loops plus documented thinking mode on `deepseek-v4-flash` and `deepseek-v4-pro`; it does not expose hosted tools, remote MCP, web search, embeddings, audio, or realtime sessions in this adapter.
- Kimi Formula tools are exposed as public helpers in `@zhivex-ai/kimi`. The SDK loads or declares Formula tool schemas, maps them into Chat Completions function tools, tracks `function.name -> formula_uri`, and executes the official Formula fiber after a Kimi tool call.
- `Hosted tools / MCP` refers to provider-native hosted tools or SDK-level MCP mappings, not local callable tools defined with `tool()`. Kimi Formula helpers are called out separately because they are official provider tools executed through Formula fibers. For OpenRouter this currently means server tools such as `openrouter:web_search`.
- `Agent tier` summarizes how far the provider currently goes for the agent runtime:
- `Tier A`: native agent building blocks including approval-capable remote MCP or equivalent hosted tools.
- `Tier B`: strong tool-using agent support, but with more provider-specific gaps or fewer hosted-agent features.
- `Tier C`: usable for basic tool loops, but not yet something the SDK should market as full agent support.

## Core Capabilities

### Text Generation

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const result = await generateText({
  model: anthropic("claude-sonnet-5"),
  system: "Be concise and technical.",
  prompt: "Explain what a provider adapter does."
});

console.log(result.text);
```

### Agent Runtime

For reusable multi-step assistants, `Agent` is the stable agent-first API. It wraps the shared tool loop and exposes `run()`, `stream()`, `resume()`, and `toDefinition()` while preserving the same serializable state contract used by `createAgent()` and `runAgent()`.

Relevant runnable examples:

- [`examples/sdk/full-agent.ts`](./examples/sdk/full-agent.ts)
- [`examples/sdk/agent-runtime.ts`](./examples/sdk/agent-runtime.ts)
- [`examples/sdk/agent-stream.ts`](./examples/sdk/agent-stream.ts)

```ts
import { Agent, tool } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const weatherAgent = new Agent({
  model: openai("gpt-5"),
  instructions: "Be concise and use tools when they help.",
  maxSteps: 4,
  tools: {
    weather: tool({
      name: "weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, forecast: "sunny" })
    })
  }
});

const run = await weatherAgent.run({
  prompt: "How's the weather in Madrid?"
});

console.log(run.status);
console.log(run.outputText);
console.log(run.state);
```

What the runtime guarantees:

- `Agent.run()` and `runAgent()` always return the final `state`, including `steps`, `toolResults`, `messages`, `usage`, and `pendingApprovals`.
- `state` is JSON-serializable and can be persisted by your app.
- `Agent` and `createAgent()` keep reusable defaults such as `instructions`, `tools`, `maxSteps`, `reasoning`, and provider options in one place.
- `Agent.resume()` and `resumeAgent()` continue from a previous `state` instead of rebuilding the run manually.
- Production states include `queued`, `running`, `waiting_approval`, `cancel_requested`, `cancelled`, `timed_out`, `failed`, and `completed`. The legacy `suspended` status is still accepted when loading old persisted runs, but new approval waits use `waiting_approval`.

Prefer `Agent` for new application code and docs. Use `createAgent()` / `runAgent()` when you want a functional API, plain object definitions, or compatibility with existing code.

### Runner And Sessions

`createRunner()` adds a small application/session layer on top of the existing agent runtime. It keeps `runAgent()` as the execution engine while a `SessionService` stores multi-turn session events and the latest resumable `AgentRunState`.

```ts
import { createAgent, createInMemorySessionService, createRunner } from "@zhivex-ai/sdk";

const agent = createAgent({
  model: openai("gpt-5"),
  instructions: "Keep answers concise."
});

const runner = createRunner({
  appName: "travel-assistant",
  agent,
  sessionService: createInMemorySessionService()
});

const first = await runner.run({
  userId: "user_123",
  sessionId: "trip-planning",
  prompt: "Remember that I prefer museums."
});

const next = await runner.run({
  userId: "user_123",
  sessionId: first.session.sessionId,
  prompt: "Plan tomorrow afternoon."
});

console.log(next.session.events.map((event) => event.type));
console.log(next.output.outputText);
```

The in-memory service is useful for local apps and tests. For app runtimes that need to survive process restarts, use a durable session service:

```ts
import { createFileSessionService, createRunner } from "@zhivex-ai/sdk";

const runner = createRunner({
  appName: "travel-assistant",
  agent,
  sessionService: createFileSessionService({
    directory: "./tmp/agent-sessions"
  })
});
```

The SDK also exposes `createSqliteSessionService()` and `createPostgresSessionService()` for production applications that already provide compatible database clients. These services store the full `AgentSession` JSON, including events and the latest resumable `AgentRunState`. This layer is SDK-only: it does not introduce workspaces, project API keys, BYOK storage, billing, or an HTTP server.

Durable session records are schema-versioned. New sessions are saved with `schemaVersion: 1`; legacy session JSON without a version is normalized when loaded, while records from a future schema version fail fast.

Durable records also include a `revision` counter. Pass `expectedRevision` to save operations when your app wants optimistic concurrency; if the stored revision changed, the SDK raises `ConflictError`. Omitting `expectedRevision` keeps the compatible last-write-wins behavior.

For explicit migration/validation, use `migrateAgentSessionRecord(record)`. File-backed session stores can be pruned locally with `pruneFileSessionStore({ directory, keepLast, olderThanMs, dryRun })`.

### Agent Control Plane

`Agent Control Plane` is a Beta layer for production agent operations. It does not replace `createAgent()` or `Runner`; it packages the operational metadata around them so applications can inspect, govern, replay, and route agent runs without binding the product to a single provider.

The first Beta surface includes:

- `createAgentCapsule()`: portable manifest for an agent, its tools, MCP servers, skills, evals, policy, provider, and agent tier.
- `createAgentToolPolicy()`: permission/risk-aware tool approval policy for read-only, supervised, write-deny, or allow-all modes.
- `createAgentApprovalQueue()`: provider approval waits as app-facing queue items with approval tokens and resume URLs.
- `createAgentRunLedger()`: normalized audit, trace, replay timeline, tool audit, summary, and cost record for a run.
- `diffAgentRunLedgers()` and `promoteAgentGoldenTrace()`: compare run behavior and turn a successful run into a regression fixture.
- `selectAgentModel()` and `createAgentCapabilityRouter()`: choose models by capabilities such as approvals, remote MCP, structured output, reasoning, streaming, web search, or minimum agent tier.
- `createAgentControlPlane()`: small facade that runs/resumes/streams an agent and returns a ledger-backed run record.

```ts
import {
  createAgent,
  createAgentCapsule,
  createAgentControlPlane,
  createAgentToolPolicy,
  createAgentRunLedger,
  createAgentCapabilityRouter
} from "@zhivex-ai/sdk";

const agent = createAgent({
  id: "finance-risk",
  model,
  tools,
  toolApprovalPolicy: createAgentToolPolicy({ mode: "read-only" })
});

const capsule = createAgentCapsule({
  id: "finance-risk",
  name: "Finance Risk Agent",
  version: "0.1.0",
  agent,
  skills: [{ id: "reconciliation", path: ".agents/skills/reconciliation/SKILL.md" }],
  policy: { toolPolicyMode: "read-only", redaction: true }
});

const router = createAgentCapabilityRouter([openai("gpt-5"), anthropic("claude-sonnet-5")]);
const selected = router.select({ minTier: "tier-b", approvals: true, remoteMcp: true });

const controlPlane = createAgentControlPlane({ agent: { ...agent, model: selected.model } });
const record = await controlPlane.run({ prompt: "Reconcile account acct_123." });

const ledger = createAgentRunLedger(record.state, {
  includeInput: false,
  includeOutput: false
});

console.log(capsule.manifest.agentTier);
console.log(ledger.audit.toolCalls);
```

The control-plane layer is intentionally SDK-only. Workspaces, billing, project keys, auth, rate limits, and queues remain application-owned or Gateway-owned concerns. Treat provider capability routing as a runtime snapshot: it helps select the best candidate, but does not remove the need for provider-specific integration tests.

### Declarative Workflows

`createWorkflow()` and `runWorkflow()` run agent workflows on top of `Runner`. The Beta workflow surface supports sequential task steps, parallel groups, and bounded task loops. Each task calls a runner, can read previous step outputs, and can persist its own `outputKey` into the workflow state.

```ts
import { createWorkflow, runWorkflow } from "@zhivex-ai/sdk";

const workflow = createWorkflow({
  id: "candidate-review",
  steps: [
    {
      id: "intake",
      runner,
      prompt: "Summarize the candidate profile.",
      outputKey: "intake"
    },
    {
      id: "review",
      runner,
      prompt: ({ outputs }) => `Review this intake: ${outputs.intake}`,
      outputKey: "review"
    }
  ]
});

const result = await runWorkflow(workflow, {
  userId: "user_123",
  sessionId: "candidate_456"
});

console.log(result.status);
console.log(result.outputs.review);
```

If a step pauses for approval, the workflow returns `waiting_approval` with a serializable `state`. Call `runWorkflow()` again with that state and approval responses to resume the pending step. `replayWorkflowRun()` inspects a saved workflow state without calling models or tools.

Workflows can also persist their latest state. For compact apps, `SessionService` can keep the state under session metadata. For production-style local state, use a dedicated `WorkflowStateService`:

```ts
import {
  createFileSessionService,
  createFileWorkflowStateService,
  createWorkflow,
  loadWorkflowState,
  runWorkflow
} from "@zhivex-ai/sdk";

const sessionService = createFileSessionService({
  directory: ".zhivex/sessions"
});
const workflowStateService = createFileWorkflowStateService({
  directory: ".zhivex/workflow-states"
});

const workflow = createWorkflow({
  id: "candidate-review",
  persistence: {
    appName: "candidate-review",
    sessionService,
    workflowStateService
  },
  steps: [
    { id: "intake", runner, prompt: "Summarize the candidate.", outputKey: "intake" },
    { id: "review", runner, prompt: ({ outputs }) => `Review: ${outputs.intake}`, outputKey: "review" }
  ]
});

const result = await runWorkflow(workflow, {
  userId: "user_123",
  sessionId: "candidate_456"
});

const persisted = await loadWorkflowState(workflow, {
  userId: "user_123",
  sessionId: "candidate_456"
});

const resumed = await runWorkflow(workflow, {
  userId: "user_123",
  sessionId: "candidate_456",
  resumeFromPersistedState: true,
  approvals
});
```

`WorkflowStateService` is the recommended durable workflow-state path. When `workflowStateService` is configured, the full state is stored by `appName`, `userId`, `sessionId`, and workflow key while the session keeps only a lightweight reference. Without it, the compatibility fallback stores state under `session.metadata.workflowRuns[workflow.id]`. Use `persistence.metadataKey` or `persistence.workflowKey` if your app needs a different namespace for the fallback or key.

Workflow run states and dedicated workflow state records are also schema-versioned. New records use `schemaVersion: 1`, and legacy records without a version are normalized on load.

Workflow steps can also fan out with a parallel group. Child steps run concurrently, preserve result order, and write their own `outputKey` values for later sequential steps:

```ts
const workflow = createWorkflow({
  steps: [
    {
      id: "research",
      kind: "parallel",
      failFast: false,
      steps: [
        { id: "market", runner, prompt: "Analyze market", outputKey: "market" },
        { id: "legal", runner, prompt: "Analyze legal risk", outputKey: "legal" }
      ]
    },
    {
      id: "synthesis",
      runner,
      prompt: ({ outputs }) => `Synthesize: ${outputs.market}\n${outputs.legal}`
    }
  ]
});
```

Use a loop step when a single task should iterate until a condition is met or `maxIterations` is reached:

```ts
const workflow = createWorkflow({
  steps: [
    {
      id: "rewrite-loop",
      kind: "loop",
      maxIterations: 3,
      step: {
        id: "rewrite",
        runner,
        prompt: ({ outputs }) => `Improve this draft: ${outputs.draft ?? "initial"}`,
        outputKey: "draft"
      },
      until: ({ outputs }) => String(outputs.draft ?? "").includes("approved")
    }
  ]
});
```

Loop iterations are recorded in the loop result's `children`. If an iteration pauses for approval, pass the saved workflow `state` and approval responses back to `runWorkflow()` to resume that pending iteration.

For local regression suites, workflow evaluations mirror the agent evaluation helpers:

```ts
import {
  compareWorkflowEvaluationReports,
  createWorkflowEvaluationFixture,
  createWorkflowEvaluationDiffReport,
  createWorkflowEvaluationReport,
  runWorkflowEvaluationFixture
} from "@zhivex-ai/sdk";

const fixture = createWorkflowEvaluationFixture({
  name: "candidate-review-workflow",
  dataset: [
    {
      name: "happy-path",
      input: { userId: "user_123", sessionId: "candidate_456" },
      expectations: {
        status: "completed",
        outputContains: { review: "recommended" },
        stepStatuses: { review: "completed" },
        timelineContains: ["workflow-start", "workflow-finish"]
      }
    }
  ]
});

const evaluation = await runWorkflowEvaluationFixture(fixture, { workflow });
const report = createWorkflowEvaluationReport(evaluation);

console.log(report.passRate);

const diff = createWorkflowEvaluationDiffReport(
  compareWorkflowEvaluationReports(previousReport, report)
);
```

### Artifacts

`ArtifactService` stores JSON-serializable artifacts for a session, workflow run, workflow step, or agent run. The first Beta service implementations are in-memory and file-backed:

```ts
import { createFileArtifactService } from "@zhivex-ai/sdk";

const artifacts = createFileArtifactService({
  directory: ".zhivex/artifacts"
});

const report = await artifacts.saveArtifact({
  appName: "candidate-review",
  userId: "user_123",
  sessionId: "candidate_456",
  workflowRunId: workflowResult.state.runId,
  workflowStepId: "review",
  name: "review-report.json",
  contentType: "application/json",
  data: {
    recommendation: "advance",
    reasons: ["skills match", "salary aligned"]
  }
});

const sessionArtifacts = await artifacts.listArtifacts({
  appName: "candidate-review",
  userId: "user_123",
  sessionId: "candidate_456"
});

const savedReport = await artifacts.loadArtifact({
  appName: "candidate-review",
  userId: "user_123",
  sessionId: "candidate_456",
  id: report.id
});
```

The file-backed service writes one JSON file per artifact with a path-safe filename derived from `appName`, `userId`, `sessionId`, and `id`. The SDK also exposes `createSqliteArtifactService()` and `createPostgresArtifactService()` for production applications that already provide compatible database clients.

Binary artifacts use a formal metadata convention: store base64 as `data`, set `encoding: "base64"`, and optionally include `size` and `sha256`. When base64 metadata is omitted, `saveArtifact()` calculates `size` and `sha256`; when metadata is provided, the SDK validates it against the decoded bytes. Native streaming/binary storage is intentionally left for a later artifact phase.

```ts
import { createBase64ArtifactData } from "@zhivex-ai/sdk";

await artifacts.saveArtifact({
  appName: "candidate-review",
  userId: "user_123",
  sessionId: "candidate_456",
  name: "resume.pdf",
  contentType: "application/pdf",
  ...createBase64ArtifactData(pdfBytes)
});
```

For real binary storage, file-backed artifacts can write metadata and bytes separately. `loadArtifact()` returns the JSON metadata, while `loadBinaryArtifact()` returns the bytes:

```ts
const binary = await artifacts.saveBinaryArtifact({
  appName: "candidate-review",
  userId: "user_123",
  sessionId: "candidate_456",
  name: "resume.pdf",
  contentType: "application/pdf",
  data: pdfBytes
});

const loaded = await artifacts.loadBinaryArtifact({
  appName: "candidate-review",
  userId: "user_123",
  sessionId: "candidate_456",
  id: binary.id
});
```

The file store writes blobs under a path-safe `blobs/` subdirectory and calculates `size` and `sha256` for `saveBinaryArtifact()`. SQLite and Postgres stores keep binary payloads as base64 JSON compatibility records in this Beta cut. For heavy production binaries, prefer app-owned blob/object storage with durable artifact metadata in SQL until native SQL/blob streaming is introduced; `createExternalArtifactReference()` creates the standard metadata shape for that pattern.

Artifact records are schema-versioned as well. New artifacts use `schemaVersion: 1`; old JSON artifacts without a version are accepted and normalized, but future versions are rejected until the SDK has an explicit migration path.

Artifact writes support the same optional optimistic concurrency guard via `expectedRevision`. SQLite and Postgres use database compare-and-swap updates for that guard; the file-backed store is intended for local/dev use and checks the revision before writing but is not a cross-process lock. Integrity helpers can verify SDK-managed binary/base64 artifacts without re-running workflows. External artifact references point at app-owned storage, so verify the external object in the application storage layer:

```ts
import { verifyArtifactIntegrity } from "@zhivex-ai/sdk";

const integrity = await verifyArtifactIntegrity(artifacts, {
  appName: "candidate-review",
  userId: "user_123",
  sessionId: "candidate_456",
  id: binary.id
});
```

For file-backed artifact stores, `inspectFileArtifactStore()` detects orphan blobs, invalid metadata, and metadata that references missing blobs. `cleanupFileArtifactStore()` deletes only orphan blobs.

Workflow helpers can persist outputs, dry replay timelines, and evaluation reports as artifacts explicitly:

```ts
import {
  saveWorkflowEvaluationReportAsArtifact,
  saveWorkflowOutputsAsArtifacts,
  saveWorkflowReplayAsArtifact
} from "@zhivex-ai/sdk";

await saveWorkflowOutputsAsArtifacts(workflowResult, {
  artifactService: artifacts,
  appName: "candidate-review"
});

await saveWorkflowReplayAsArtifact(workflowResult, {
  artifactService: artifacts,
  appName: "candidate-review"
});

await saveWorkflowEvaluationReportAsArtifact(evaluation, {
  artifactService: artifacts,
  appName: "candidate-review",
  userId: "user_123",
  sessionId: "candidate_456",
  workflowRunId: workflowResult.state.runId
});
```

These helpers do not change `runWorkflow()` behavior. They are explicit persistence calls, so applications can choose which outputs or reports become durable artifacts.

### CLI / Dev UX

`@zhivex-ai/sdk` includes a Beta `zhivex-ai` CLI for local SDK state. Inspection commands are dry: they read JSON files, replay workflow state, and build reports without executing models or tools. Execution commands import an app-owned local module, so the app remains responsible for constructing runners, models, tools, and credentials.

```bash
zhivex-ai init agent --dir support-agent --provider openai --model gpt-5
zhivex-ai doctor --dir support-agent --provider openai

zhivex-ai sessions list --dir .zhivex/sessions
zhivex-ai sessions show --dir .zhivex/sessions --app candidate-review --user user_123 --session candidate_456

zhivex-ai artifacts list --dir .zhivex/artifacts --app candidate-review --user user_123 --session candidate_456
zhivex-ai artifacts show --dir .zhivex/artifacts --app candidate-review --user user_123 --session candidate_456 --id art_123
zhivex-ai artifacts verify --dir .zhivex/artifacts --app candidate-review --user user_123 --session candidate_456 --id art_123
zhivex-ai artifacts inspect --dir .zhivex/artifacts
zhivex-ai artifacts cleanup --dir .zhivex/artifacts --dry-run

zhivex-ai workflow replay --state workflow-state.json
zhivex-ai workflow report --evaluation workflow-evaluation.json
zhivex-ai workflow compare --base previous-report.json --target current-report.json
zhivex-ai workflow run --module ./workflow.mjs --input workflow-input.json --state-out workflow-state.json
zhivex-ai workflow eval --module ./workflow.mjs --workflow-export workflow --fixture workflow-fixture.json --report-out workflow-report.json

zhivex-ai workflow replay --state workflow-state.json --save-artifact --artifacts-dir .zhivex/artifacts --app candidate-review
zhivex-ai workflow report --evaluation workflow-evaluation.json --save-artifact --artifacts-dir .zhivex/artifacts --app candidate-review --user user_123 --session candidate_456
zhivex-ai workflow-states list --dir .zhivex/workflow-states --app candidate-review --user user_123 --session candidate_456
zhivex-ai workflow-states show --dir .zhivex/workflow-states --app candidate-review --user user_123 --session candidate_456 --workflow default
zhivex-ai sessions workflow-state show --dir .zhivex/sessions --app candidate-review --user user_123 --session candidate_456 --workflow default
zhivex-ai artifacts prune --dir .zhivex/artifacts --keep-last 100
zhivex-ai workflow-states prune --dir .zhivex/workflow-states --older-than-ms 2592000000

zhivex-ai agents ledger --state agent-run-state.json --out run-ledger.json
zhivex-ai agents inspect --ledger run-ledger.json
zhivex-ai agents diff --base previous-ledger.json --target current-ledger.json
zhivex-ai agents golden --ledger run-ledger.json --name happy-path --out golden-trace.json
zhivex-ai agents eval --golden golden-trace.json --ledger run-ledger.json --out agent-eval.json
```

Output is JSON pretty-printed by default. `init agent` scaffolds a Bun-first agent project with file-backed local sessions, a production safety policy, a provider package, a smoke-test tool, and scripts for doctor/inspect/ledger. `doctor` checks runtime, package metadata, provider dependencies, provider environment variables, TypeScript config, and local store readiness. Use `workflow-states list/show` for first-class durable workflow state inspection; `sessions workflow-state show` remains available for legacy session-metadata fallback state. The `agents` inspection and evaluation commands are dry local control-plane utilities over saved run states and ledgers; they never execute models or tools. Prune commands are dry-run by default; pass `--execute` to delete. The CLI is intentionally local-only and does not introduce auth, workspaces, or Gateway calls.

### Realtime Sessions

The shared realtime contract lets provider adapters expose low-latency audio/text sessions without changing the rest of your app architecture.

```ts
import { tool } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const session = await openai.realtimeModel!("gpt-realtime").connect({
  instructions: "Keep answers short.",
  tools: {
    weather: tool({
      name: "weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, forecast: "sunny" })
    })
  }
});

await session.sendText("How is Madrid today?");

for await (const event of session.eventStream()) {
  if (event.type === "realtime-text-delta") {
    process.stdout.write(event.textDelta);
  }
}
```

OpenAI's current realtime audio models use the same shared contract:

```ts
const voiceAgent = await openai.realtimeModel!("gpt-realtime-2").connect({
  instructions: "Resolve the user's request while keeping latency low.",
  reasoning: { effort: "high" },
  outputAudioMediaType: "audio/pcm",
  voice: "marin"
});

const translation = await openai.realtimeModel!("gpt-realtime-translate").connect({
  translation: {
    sourceLanguage: "en",
    targetLanguage: "es"
  },
  outputAudioMediaType: "audio/pcm"
});

const transcription = await openai.realtimeModel!("gpt-realtime-whisper").connect({
  inputTranscription: {
    language: "es",
    includeLogprobs: true,
    delay: "low"
  },
  inputAudioMediaType: "audio/pcm",
  inputSampleRateHz: 24_000,
  noiseReduction: { type: "near_field" }
});
```

Gemini 3.5 Live Translate uses the same shared translation shape for low-latency speech-to-speech translation:

```ts
const liveTranslate = await gemini.realtimeModel!("gemini-3.5-live-translate-preview").connect({
  mode: "translation",
  translation: {
    sourceLanguage: "en",
    targetLanguage: "pl"
  },
  inputAudioTranscription: true,
  outputAudioTranscription: true,
  outputAudioMediaType: "audio/pcm",
  providerOptions: {
    apiVersion: "v1alpha",
    translationConfig: {
      echoTargetLanguage: true
    }
  }
});
```

Current shared provider coverage for realtime sessions:

- OpenAI
- Azure OpenAI
- Gemini
- Vertex

Notes:

- Providers that require auth headers during the WebSocket handshake, such as OpenAI server-side sessions and Vertex, should be given a custom `realtimeConnectionFactory` in Node/Bun.
- Browser-token helpers are currently exposed for OpenAI, Azure OpenAI, and Gemini.
- Gemini, Vertex, and Azure OpenAI sessions support `sendMedia()` for image inputs such as `image/jpeg`.
- OpenAI supports `sendMedia()` for image inputs on `gpt-realtime`, `gpt-realtime-2`, and `gpt-realtime-mini`, but not on the older `gpt-4o-*-realtime-preview`, `gpt-realtime-translate`, or `gpt-realtime-whisper` models.
- OpenAI `gpt-realtime-translate` uses realtime translation mode and requires `translation.targetLanguage`; OpenAI `gpt-realtime-whisper` uses realtime transcription mode and emits transcript events without model audio output.
- Gemini and Vertex Live sessions can opt into typed `inputAudioTranscription`, `outputAudioTranscription`, `mediaResolution`, `affectiveDialog`, `proactiveAudio`, and `reasoning` setup fields where the selected model supports them. Gemini `gemini-3.1-flash-live-preview` rejects `affectiveDialog` and `proactiveAudio` before opening a WebSocket. For Gemini API preview-only Live features, pass `providerOptions: { apiVersion: "v1alpha" }`.
- Gemini and Vertex `gemini-3.5-live-translate-preview` sessions map `translation.targetLanguage` to Google Live `translationConfig.targetLanguageCode`, emit translated audio plus assistant transcript events, and reject tools, text input, image input, reasoning, and system instructions before the request is sent. Vertex availability still depends on the selected project, region, and model access.
- Advanced provider-specific session fields can still be passed through `RealtimeSessionConfig.providerOptions`.

For browser-driven interview-style flows, you can send camera frames through the shared contract on providers that support realtime image input:

```ts
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const session = await gemini.realtimeModel!("gemini-3.1-flash-live-preview").connect({
  instructions: "Observe the camera feed and give concise interview feedback.",
  outputAudioMediaType: "audio/pcm",
  inputAudioTranscription: true,
  outputAudioTranscription: true,
  mediaResolution: "MEDIA_RESOLUTION_LOW",
  providerOptions: {
    apiVersion: "v1alpha"
  }
});

await session.sendMedia({
  data: jpegFrameBase64,
  mediaType: "image/jpeg"
});
```

### Live Agent Runtime

`streamLiveAgent()` sits one level above raw realtime sessions. It wires a realtime-capable model to local tools, tool approval policies, guardrails, telemetry, and optional state persistence.

```ts
import { streamLiveAgent, tool } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";
import { z } from "zod";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const live = streamLiveAgent(
  {
    id: "voice-weather",
    model: gemini.realtimeModel!("gemini-live-2.5-flash-native-audio"),
    instructions: "Speak briefly and use tools when needed.",
    tools: {
      weather: tool({
        name: "weather",
        schema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, forecast: "sunny" })
      })
    }
  },
  {
    prompt: "How is Madrid today?"
  }
);

for await (const chunk of live.textStream) {
  process.stdout.write(chunk);
}

const result = await live.collect();
console.log(result.outputText);
```

### Agent Persistence And Memory

The agent runtime now supports pluggable run stores and memory stores. Use a run store when you want to save and reload full `AgentRunState` snapshots by `runId`, and use a memory store when you want fresh runs to inherit compact prior context automatically.

```ts
import {
  createAgent,
  createFileAgentRunStore,
  createInMemoryAgentMemoryStore,
  runAgent
} from "@zhivex-ai/sdk";

const agent = createAgent({
  model: openai("gpt-5"),
  store: createFileAgentRunStore({
    directory: "./tmp/agent-runs"
  }),
  memory: createInMemoryAgentMemoryStore()
});

const first = await runAgent(agent, {
  prompt: "Remember that I prefer museums in Madrid."
});

const resumed = await runAgent(agent, {
  runId: first.state.runId
});

console.log(resumed.state.runId);
```

The default in-memory and file-backed helpers are intentionally small. They are meant to give applications a stable contract they can later replace with Redis, Postgres, S3, or any other storage layer.

The SDK now also ships durable SQL-backed helpers:

- `createSqliteAgentRunStore()`
- `createSqliteAgentMemoryStore()`
- `createPostgresAgentRunStore()`
- `createPostgresAgentMemoryStore()`

These helpers intentionally depend on small driver interfaces instead of bundling a database client into `@zhivex-ai/core`. In practice that means you can pair them with:

- SQLite drivers that expose `db.exec()` plus `db.prepare()` or `db.query()`, such as `better-sqlite3` or Bun SQLite
- Postgres clients or pools that expose `query(sql, params)`, such as `pg`

### Durable Agent Runs

Built-in run stores support compatible durability primitives for production agent services: schema-versioned state, idempotent run creation, and cooperative cancellation.

```ts
import { cancelAgentRun, createAgent, createPostgresAgentRunStore, runAgent } from "@zhivex-ai/sdk";

const store = createPostgresAgentRunStore({ client: pgPool });
const agent = createAgent({
  model: openai("gpt-5"),
  store
});

const first = await runAgent(agent, {
  prompt: "Draft the customer reply.",
  idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined
});

await cancelAgentRun(store, first.state.runId, {
  reason: "User cancelled the request."
});
```

- New runs are persisted with `state.schemaVersion === 1`.
- Legacy states without `schemaVersion` are normalized when loaded or resumed.
- `idempotencyKey` requires an agent run store that implements `findByIdempotencyKey()`. The built-in in-memory, file, SQLite, and Postgres stores support it.
- Reusing an existing `idempotencyKey` returns the existing run state instead of creating a duplicate run.
- `cancelAgentRun()` marks the saved state as `cancel_requested` by default. Pass `{ mode: "final" }` to write a terminal `cancelled` state.
- Cancellation is durable and cooperative. It gives workers/providers a stable marker to observe, but it does not promise to stop external side effects that already started.
- Add `policy: { timeoutMs, onTimeout }` to `createAgent()` or `runAgent()` to enforce an SDK-level runtime timeout. The default timeout result is `timed_out`; `onTimeout: "cancel-requested"` writes `cancel_requested` instead. The timeout is propagated to providers through `AbortSignal`.

### Agent Handoffs

For multi-agent workflows, create a handoff from one completed run and pass it into another agent. The runtime preserves the parent run relationship in `state.parentRunId` and records the handoff on the downstream state.

```ts
import { createAgentHandoff, runAgent, runAgentHandoff } from "@zhivex-ai/sdk";

const plannerResult = await runAgent(plannerAgent, {
  prompt: "Plan a museum afternoon in Madrid."
});

const handoff = createAgentHandoff({
  source: plannerResult,
  toAgentId: "booking-agent"
});

const bookingResult = await runAgentHandoff(bookingAgent, handoff);
console.log(bookingResult.state.parentRunId);
```

### Native Subagents

Agents can also expose specialist agents as callable subagent tools. The parent run records child run summaries in `state.childRuns`, and replay/trace helpers include those child links without re-running the child agent.

```ts
import { createAgent, runAgent } from "@zhivex-ai/sdk";

const researcher = createAgent({
  id: "researcher",
  model: openai("gpt-5-mini"),
  instructions: "Research the requested topic and return concise findings."
});

const coordinator = createAgent({
  id: "coordinator",
  model: openai("gpt-5"),
  subagents: [
    {
      name: "research",
      agent: researcher,
      description: "Delegate focused research to the researcher subagent."
    }
  ],
  maxSteps: 3
});

const result = await runAgent(coordinator, {
  prompt: "Answer with help from the research specialist."
});

console.log(result.state.childRuns?.[0]?.parentRunId);
```

### Subagent Production Controls

For production subagent workflows, use a shared durable run store when parent and child runs need to be audited or cancelled together. Built-in stores can look up child runs by `parentRunId`, and `cancelAgentRunTree()` marks the parent plus all persisted descendants as `cancel_requested` by default. Pass `{ mode: "final" }` when the workflow is known to be terminally cancelled.

```ts
import {
  cancelAgentRunTree,
  createAgent,
  createPostgresAgentRunStore,
  runAgent
} from "@zhivex-ai/sdk";

const store = createPostgresAgentRunStore({ client: pgPool });

const researcher = createAgent({
  id: "researcher",
  model: openai("gpt-5-mini"),
  store
});

const coordinator = createAgent({
  id: "coordinator",
  model: openai("gpt-5"),
  store,
  subagents: [{ name: "research", agent: researcher }]
});

const run = await runAgent(coordinator, {
  prompt: "Coordinate the research task."
});

const childRuns = await store.findByParentRunId?.(run.state.runId);
await cancelAgentRunTree(store, run.state.runId, {
  reason: "Workflow cancelled by the user."
});
```

`createBudgetGuard()` includes `state.childRuns` by default when enforcing step, tool-call, tool-error, and token limits. Pass `includeChildRuns: false` for parent-only limits.

### Hierarchical Agent Traces

Use tree helpers when a persisted parent run needs to be exported with its descendants. These helpers are dry: they load saved state and never call models or tools.

```ts
import { createAgentRunTreeSnapshot, createHierarchicalAgentTrace } from "@zhivex-ai/sdk";

const tree = await createAgentRunTreeSnapshot(store, run.state.runId);
const trace = await createHierarchicalAgentTrace(store, run.state.runId, {
  includeMessages: false
});

console.log(tree?.totalRuns, trace?.root.children.length);
```

### Multi-Agent Evaluations

Evaluation expectations can assert child-run behavior in addition to parent output.

```ts
const result = await runAgentEvaluation(
  [
    {
      name: "research workflow",
      input: { prompt: "Answer with research." },
      expectations: {
        childRunCount: 1,
        childAgents: ["researcher"],
        childStatuses: ["completed"],
        childToolNames: ["research"],
        childOutputContains: ["source"]
      }
    }
  ],
  { agent: coordinator }
);
```

`createAgentEvaluationReport()` includes child-run totals, child agent counts, and child status counts.

### Parallel Agent Groups

Use `runAgentGroup()` for explicit fan-out from code when you do not want to depend on the model emitting subagent tool calls.

```ts
import { runAgentGroup } from "@zhivex-ai/sdk";

const group = await runAgentGroup(
  [
    { name: "research", agent: researcher },
    { name: "critic", agent: critic }
  ],
  {
    prompt: "Analyze this task independently.",
    parentRunId: run.state.runId,
    stopOnError: true
  }
);
```

With `stopOnError: false`, groups keep all-settled behavior and report every member result. With `stopOnError: true`, the first thrown error or member output with `status: "failed"` or `status: "timed_out"` aborts pending members cooperatively through `AbortSignal`; aborted members are returned as rejected outputs with a stable fail-fast error message.

Use `handoff` for sequential ownership transfer, `subagents` for model-driven delegation inside an agent loop, and `runAgentGroup()` for deterministic fan-out from application code.

### Subagent Defaults

`prepareSubagentsForAgent()` returns a compatible agent definition where subagents inherit missing operational defaults from the parent, such as store, memory, telemetry, tool approvals, and tool execution settings. It does not mutate the original parent or child definitions.

```ts
import { prepareSubagentsForAgent } from "@zhivex-ai/sdk";

const productionCoordinator = prepareSubagentsForAgent(coordinator, {
  store,
  onTelemetryEvent: observer
});
```

### Agent Telemetry

Agents can now emit lifecycle telemetry without wrapping the underlying language model yourself. Attach `onTelemetryEvent` to an agent definition when you want hooks for run start/finish, step start/finish, approval requests, memory loads, state saves, handoffs, and subagent runs.

```ts
const agent = createAgent({
  model: openai("gpt-5"),
  onTelemetryEvent(event) {
    console.log(event.type);
  }
});
```

If a provider emits an MCP approval request, the run moves to `waiting_approval` instead of failing. You can inspect pending approvals with `getAgentApprovalRequests()` and continue with `resumeAgent()`. Persisted legacy states with `status: "suspended"` are still accepted for compatibility.

```ts
import { createAgent, getAgentApprovalRequests, resumeAgent, runAgent } from "@zhivex-ai/sdk";

const waiting = await runAgent(weatherAgent, {
  prompt: "Search the docs through MCP."
});

if (waiting.status === "waiting_approval") {
  const [approval] = getAgentApprovalRequests(waiting.messages);

  const resumed = await resumeAgent(weatherAgent, {
    state: waiting.state,
    approvals: [
      {
        provider: approval.provider,
        approvalRequestId: approval.id,
        approve: true
      }
    ]
  });

  console.log(resumed.outputText);
}
```

This approval flow currently matters most for `Tier A` providers such as OpenAI and Azure OpenAI, where remote MCP servers can request explicit user approval mid-run.

For OpenTelemetry-oriented setups, the SDK now also exposes explicit OTEL helpers:

- `createOtelObserver()`
- `createOtelAgentObserver()`
- `createOtelTelemetryMiddleware()`

Those helpers are optional and do not add a required dependency to `@zhivex-ai/core`. Install `@opentelemetry/api` in your application if you want the SDK to create tracers for you automatically, or inject your own tracer-compatible object.

```ts
import { createAgent, createOtelAgentObserver, createOtelTelemetryMiddleware, wrapLanguageModel } from "@zhivex-ai/sdk";

const otelAgentObserver = await createOtelAgentObserver();
const otelModelMiddleware = await createOtelTelemetryMiddleware();

const model = wrapLanguageModel(openai("gpt-5"), [otelModelMiddleware]);

const agent = createAgent({
  model,
  onTelemetryEvent: otelAgentObserver
});
```

### Trace Artifacts And Cost Summaries

For portable debugging and dashboards, trace helpers create serializable artifacts from saved run state or from live agent telemetry. They do not re-run models or tools.

```ts
import {
  createAgentTraceArtifact,
  createProductionTraceCollector,
  estimateAgentRunCost,
  summarizeAgentTrace
} from "@zhivex-ai/sdk";

const trace = createAgentTraceArtifact(savedRunState, {
  includeMessages: false,
  includeToolInputs: false
});

const summary = summarizeAgentTrace(trace, {
  pricing: { inputCostPer1kTokens: 1, outputCostPer1kTokens: 2, currency: "USD" }
});

console.log(summary.latency.durationMs);
console.log(estimateAgentRunCost(savedRunState, { costPer1kTokens: 0.6 }).totalCost);

const collector = createProductionTraceCollector();
const agent = createAgent({
  model: openai("gpt-5"),
  onTelemetryEvent: collector.observer
});
```

Use `includeMessages` and `includeToolInputs` only when you need full payloads in exported traces. By default the artifact keeps metadata, lifecycle events, usage, approvals, errors, tool results, and an output preview without copying large message/tool-input payloads.

See [Production Guide](./docs/PRODUCTION.md#observability-export-path) and `examples/sdk/observability-export.ts` for a JSONL export pattern with redacted trace artifacts, tool-call audit records, and reproducible cost/latency summaries.

For SDK-defined local tools, you can now attach a `toolApprovalPolicy` at the agent or request level. The policy runs before local tool execution and can allow or deny the call with a reason:

```ts
const agent = createAgent({
  model: openai("gpt-5"),
  toolApprovalPolicy({ toolCall }) {
    if (toolCall.name === "shell") {
      return {
        approved: false,
        reason: "Shell access is disabled in this environment."
      };
    }

    return { approved: true };
  }
});
```

Agents also support first-class input and output guardrails. A triggered guardrail fails the run, persists the failed state, and emits telemetry:

```ts
const agent = createAgent({
  model: openai("gpt-5"),
  inputGuardrails: [
    async ({ messages }) => {
      const hasSecrets = messages.some((message) =>
        message.parts.some((part) => part.type === "text" && part.text.includes("api key"))
      );

      return hasSecrets
        ? {
            triggered: true,
            reason: "Requests containing secrets are blocked."
          }
        : undefined;
    }
  ]
});
```

For UI transport, `streamAgent()` now emits agent lifecycle events as well as the underlying text/tool/provider-data stream. You can send that directly over SSE with `toUIAgentStreamResponse()`:

```ts
import { streamAgent, toUIAgentStreamResponse } from "@zhivex-ai/sdk";

const result = streamAgent(weatherAgent, {
  prompt: "Search the docs through MCP."
});

return toUIAgentStreamResponse(result);
```

Agent stream events currently include:

- `agent-run-start`
- `agent-step-start`
- `agent-step-finish`
- `agent-approval-request`
- `agent-approval-resolved`
- `agent-run-finish`

Those events are exposed both through `streamAgent().eventStream` and through UI/SSE helpers such as `toUIAgentStreamResponse()` and `toUIMessageStream()`.

When you need to reason about provider-specific agent features at runtime, inspect `model.capabilities.agentCapabilities` or use helpers such as `getAgentCapabilities()`, `getAgentSupportTier()`, `inspectProviderAgentSupport()`, `createProviderSupportMatrix()`, `renderProviderSupportMatrix()`, `createProviderSupportDriftReport()`, and `getHostedToolClass()`. Hosted tools now carry a normalized `toolClass` like `web-search`, `file-search`, `remote-mcp`, `computer-use`, `code-execution`, `shell`, `apply-patch`, `tool-search`, `web-extraction`, or `skill`.

```ts
import {
  createProviderSupportDriftReport,
  createProviderSupportMatrix,
  getAgentCapabilities,
  getAgentSupportTier,
  renderProviderSupportMatrix
} from "@zhivex-ai/sdk";

const capabilities = getAgentCapabilities(openai("gpt-5"));
const matrix = createProviderSupportMatrix([
  openai("gpt-5"),
  openai("gpt-4o-mini")
]);

console.log(getAgentSupportTier(openai("gpt-5")));
console.log(capabilities);
console.log(renderProviderSupportMatrix(matrix));
console.log(createProviderSupportDriftReport(matrix, { entries: [{ provider: "openai", agentTier: "tier-a" }] }));
```

Use the agent tiers as release guidance, not just metadata:

- `Tier A`: choose this when you need approvals, remote MCP, or the strongest hosted-agent story.
- `Tier B`: good default for portable tool-using agents, especially with local tools or SDK-managed MCP clients.
- `Tier C`: keep expectations narrower; these providers work well for basic loops, but you should avoid marketing them as full hosted-agent support.

### Safety Policies

Safety policies are stable composition helpers for production agent services. They wrap the existing `toolApprovalPolicy`, guardrail, and `toolExecution` hooks instead of changing the runtime contract.

```ts
import { applySafetyPolicyToAgent, createAgent, createProductionSafetyPolicy } from "@zhivex-ai/sdk";

const safeAgent = applySafetyPolicyToAgent(
  createAgent({
    model: openai("gpt-5"),
    tools: registry.toToolSet(),
    maxSteps: 6
  }),
  createProductionSafetyPolicy()
);
```

`createProductionSafetyPolicy()` is the recommended first production preset; use `createSafetyPolicy()` directly when a product needs a custom policy shape. Available presets are `permissive`, `review-sensitive`, and `locked-down`. The approval helper treats `requiresApproval`, Advanced Tool Registry permissions/audit metadata, hosted tool classes, and sensitive tool names as policy inputs. Redaction helpers cover common API keys, bearer/basic auth tokens, optional email addresses, and custom regex rules. Budget guards fail the run through normal guardrail behavior when configured limits are exceeded.

For finance, HR, and other audited agent services, the Beta production-agent kit adds opt-in helpers for redacted audit export and conservative read-only tool policies:

```ts
import {
  createAgentAuditRecord,
  createReadOnlyToolApprovalPolicy,
  createSensitiveDataPolicy,
  createToolAuditRecords
} from "@zhivex-ai/sdk";

const redaction = createSensitiveDataPolicy();
const toolApprovalPolicy = createReadOnlyToolApprovalPolicy();

const agentRecord = createAgentAuditRecord(result.state, {
  redaction,
  includeMetadata: true
});
const toolRecords = createToolAuditRecords(result.state, {
  redaction,
  includeInput: false,
  includeOutput: false
});
```

The audit helpers intentionally omit full messages and tool payloads by default. Keep the generated records server-side and export them to your own log, queue, warehouse, or SIEM.

### Agent Replay And Evaluation

For deterministic debugging, `createAgentRunSnapshot()` and `replayAgentRun()` inspect a saved `AgentRunState` without calling a model or re-running tools. For regression suites, `runAgentEvaluation()` executes small datasets against an agent and `judgeAgentEvaluation()` can score the result with either a deterministic function or a `LanguageModel`.

```ts
import {
  createAgentEvaluationFixture,
  createAgentEvaluationReport,
  createAgentRunSnapshot,
  createMockLanguageModel,
  judgeAgentEvaluation,
  replayAgentRun,
  runAgentEvaluationFixture
} from "@zhivex-ai/sdk";

const replay = replayAgentRun(savedRunState);
console.log(createAgentRunSnapshot(savedRunState));
console.log(replay.timeline);

const fixture = createAgentEvaluationFixture({
  name: "weather-regression",
  dataset: [
    {
      name: "weather-answer",
      input: { prompt: "Weather in Madrid?" },
      expectations: {
        status: "completed",
        outputContains: "Madrid",
        toolCalls: ["weather"]
      }
    }
  ]
});

const evaluation = await runAgentEvaluationFixture(fixture, { agent: weatherAgent });
const report = createAgentEvaluationReport(evaluation);

const judged = await judgeAgentEvaluation(evaluation, (result) => ({
  score: result.ok ? 1 : 0,
  feedback: result.ok ? "All cases passed." : "Review failing cases."
}));

const modelJudge = createMockLanguageModel({
  responses: [
    {
      messages: [{ role: "assistant", parts: [{ type: "text", text: "{\"score\":1,\"feedback\":\"ok\"}" }] }],
      text: "{\"score\":1,\"feedback\":\"ok\"}"
    }
  ]
});

console.log(report.passRate);
```

The initial replay helper is intentionally dry: it reconstructs a timeline from saved state and does not execute side effects.

### Streaming

`streamText()` exposes both a text-only stream for simple UX flows and a lower-level event stream for advanced handling.

```ts
import { streamText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Answer in two short sentences."
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

const final = await result.collect();
console.log(final.finishReason);
```

### Reasoning Configuration

Use the shared `reasoning` option when you want to control reasoning behavior without coupling your app to provider-specific request fields.

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-5"),
  prompt: "Compare BFS and DFS for pathfinding.",
  maxTokens: 600,
  reasoning: {
    effort: "high"
  }
});

console.log(result.text);
```

Provider compatibility for the common `reasoning` option:

- OpenAI and Azure OpenAI: support `effort`
- OpenRouter: supports `effort` and `budgetTokens`
- Anthropic:
  - Claude Sonnet 5 supports `effort`, adaptive thinking, files, fast mode, and mid-conversation system messages; omit explicit `temperature`, `top_p`, and `top_k`
  - Claude Fable 5 and Claude Mythos 5 support `effort`; adaptive thinking is always on, so the adapter sends only `output_config.effort` for common reasoning requests
  - Claude Mythos 5 remains limited-availability upstream; use it only for approved Anthropic accounts
  - Claude Fable 5 server-side refusal fallback is available with `providerOptions.fallbacks`; the adapter adds the required `server-side-fallback-2026-06-01` beta header automatically
  - Claude Opus 4.7 and later, including Claude Opus 4.8, support `effort`; `budgetTokens` is rejected
  - Claude Opus 4.5, Claude Opus 4.6, and Claude Sonnet 4.6 support `effort`
  - Claude Haiku 4.5 supports extended thinking through `budgetTokens`; it does not use the modern `effort` mapping
  - `budgetTokens` remains available only on Anthropic models that still accept manual thinking
  - Claude Sonnet 5, Claude Fable 5, Claude Mythos 5, and Claude Opus 4.8 accept provider-specific `providerOptions.speed = "fast"` for fast mode
- Gemini and Vertex:
  - Gemini 3 models support `effort`
  - Gemini 2.5 and earlier models support `budgetTokens`
- Qwen:
  - supported on reasoning-capable model families such as `qwen3.7-plus`, `qwen3.7-max`, `qwen-plus`, `qwen-turbo`, `qwq`, and `qwen3*`
  - maps to `enable_thinking`, and `budgetTokens` maps to `thinking_budget`
- Kimi:
  - supported on thinking-capable models such as `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`, `kimi-k2.5`, and legacy `kimi-k2-thinking`
  - maps to Kimi `thinking.enabled/disabled`
  - `kimi-k2.7-code` and `kimi-k2.7-code-highspeed` do not support disabling thinking, custom `temperature`, custom `top_p`, or `n` values other than `1`
  - `budgetTokens` is not supported in the common mapping
  - when reasoning is enabled, `toolChoice` must stay `auto` or `none`
- DeepSeek:
  - supported on `deepseek-v4-flash` and `deepseek-v4-pro`
  - maps `effort` to DeepSeek `thinking` and `reasoning_effort`
  - `effort: "none"` disables thinking mode
  - `budgetTokens` is not supported in the common mapping
- Ollama and Bedrock: not supported

Claude Fable 5 refusal fallback:

```ts
const result = await generateText({
  model: anthropic("claude-fable-5"),
  prompt: "Help me assess this request.",
  reasoning: { effort: "high" },
  providerOptions: {
    fallbacks: [{ model: "claude-opus-4-8" }]
  }
});

console.log(result.providerFinishReason, result.text);
```

When a provider or model does not support the requested `reasoning` field, the SDK throws an explicit error instead of silently ignoring it. For the broader matrix, see [Provider Compatibility](#provider-compatibility).

For Qwen, Kimi, and DeepSeek, the SDK also preserves provider reasoning state across multi-step loops by storing `reasoning_content` inside assistant `provider-data` parts and replaying it on subsequent requests when needed.

### HTTP Responses and UI Streams

The SDK can convert streaming results into Web `Response` objects for server frameworks and edge runtimes.

```ts
import { streamText, toTextStreamResponse } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Stream a short answer."
});

return toTextStreamResponse(result);
```

For richer event payloads and UI-oriented transport:

```ts
import { streamText, toUIMessageStreamResponse } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamText({
  model: openai("gpt-4o-mini"),
  prompt: "Stream a short answer."
});

return toUIMessageStreamResponse(result);
```

### Structured Output

Structured generation supports `native`, `prompted`, and `auto` modes. `native` should be preferred when the selected provider/model supports schema-constrained responses.

```ts
import { generateObject } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";
import { z } from "zod";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const recipe = await generateObject({
  model: gemini("gemini-3.5-flash"),
  prompt: "Return JSON with title and servings.",
  mode: "native",
  schema: z.object({
    title: z.string(),
    servings: z.number()
  })
});

console.log(recipe.object);
console.log(recipe.objectMode);
```

### Structured Output Streaming

```ts
import { streamObject } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";
import { z } from "zod";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = streamObject({
  model: openai("gpt-4o-mini"),
  prompt: "Return JSON with title and servings.",
  mode: "native",
  schema: z.object({
    title: z.string(),
    servings: z.number()
  })
});

for await (const partial of result.partialObjectStream) {
  console.log(partial);
}

const final = await result.collect();
console.log(final.object);
```

### Tool Calling

Tools are modeled in the shared contract, and the SDK preserves a multi-step loop through `maxSteps`.

```ts
import { generateText, tool, user } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { z } from "zod";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const result = await generateText({
  model: anthropic("claude-sonnet-5"),
  messages: [user("What is the weather in Madrid?")],
  maxSteps: 2,
  tools: {
    weather: tool({
      name: "weather",
      description: "Get weather by city",
      schema: z.object({
        city: z.string()
      }),
      execute: async ({ city }) => ({
        city,
        forecast: "sunny"
      })
    })
  }
});

console.log(result.text);
console.log(result.toolResults);
```

Provider-hosted tools use the same `tools` registry through `hostedTool`. This lets providers expose native capabilities such as OpenAI/Azure Responses tools or Gemini/Vertex built-ins without breaking the common contract.

OpenRouter server tools are available through the same hosted-tool mechanism:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenRouter, openRouterWebSearchTool } from "@zhivex-ai/openrouter";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY
});

const result = await generateText({
  model: openrouter("openai/gpt-4o-mini"),
  prompt: "What were the major AI announcements this week?",
  tools: {
    web: openRouterWebSearchTool({
      max_results: 5,
      allowed_domains: ["openai.com", "anthropic.com"]
    })
  }
});

console.log(result.text);
```

OpenAI and Azure OpenAI can expose Responses agent tools through provider helpers. `shell` and `apply_patch` are SDK-managed local harness tools, so they require an explicit approval policy by default:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI, openAIApplyPatchTool, openAIShellTool } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-5"),
  prompt: "Inspect package scripts and propose a tiny patch.",
  maxSteps: 4,
  toolApprovalPolicy({ toolCall }) {
    return toolCall.name === "shell" && String(toolCall.input).includes("npm")
      ? { approved: false, reason: "Use bun in this repository." }
      : { approved: true };
  },
  tools: {
    shell: openAIShellTool({ cwd: process.cwd(), timeoutMs: 10_000 }),
    patch: openAIApplyPatchTool({
      async applyOperation(operation) {
        return {
          operation,
          applied: false,
          message: "Patch review mode; apply it in your own workspace runner."
        };
      }
    })
  }
});

console.log(result.text);
console.log(result.toolResults);
```

Anthropic exposes Claude web search by default with `web_search_20260209` and now has a native code execution helper:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { anthropicCodeExecutionTool, anthropicWebSearchTool, createAnthropic } from "@zhivex-ai/anthropic";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const result = await generateText({
  model: anthropic("claude-sonnet-5"),
  prompt: "Research this API change and verify the migration with code.",
  tools: {
    web: anthropicWebSearchTool(),
    code: anthropicCodeExecutionTool()
  }
});

console.log(result.text);
```

Qwen now uses the DashScope-compatible Responses API by default, including hosted web search, web extraction, code interpreter, file search, remote MCP, and image search tools. Current catalog examples prefer `qwen3.7-plus` for multimodal reasoning, `qwen3.7-max` for text reasoning, and `qwen-image-2.0-pro` for image generation. Pass `providerOptions: { apiMode: "chat" }` only when you need the legacy Chat Completions path.

```ts
import { generateText } from "@zhivex-ai/sdk";
import {
  createQwen,
  qwenCodeInterpreterTool,
  qwenFileSearchTool,
  qwenMcpTool,
  qwenWebExtractorTool,
  qwenWebSearchTool
} from "@zhivex-ai/qwen";

const qwen = createQwen({
  apiKey: process.env.DASHSCOPE_API_KEY
});

const result = await generateText({
  model: qwen("qwen3.7-plus"),
  prompt: "Find current docs, extract the relevant page, and check a sample with code.",
  tools: {
    search: qwenWebSearchTool(),
    extract: qwenWebExtractorTool(),
    code: qwenCodeInterpreterTool(),
    files: qwenFileSearchTool({ vector_store_ids: ["store_1"] }),
    maps: qwenMcpTool({
      server_label: "amap-maps",
      server_protocol: "sse",
      server_url: "https://dashscope-intl.aliyuncs.com/api/v1/mcps/amap-maps/sse",
      headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` }
    })
  }
});

console.log(result.text);
```

### MCP

The SDK now exposes MCP helpers across the providers that support it:

- `@zhivex-ai/core` and `@zhivex-ai/sdk`: `createMcpToolSet()` wraps an MCP client that can `listTools()` and `callTool()` into local callable tools.
- `@zhivex-ai/core` and `@zhivex-ai/sdk`: `createToolRegistry()` and `createMcpToolRegistry()` help compose local tools, MCP-derived tools, and hosted tools into one registry before converting to a `ToolSet`.
- `@zhivex-ai/openai` and `@zhivex-ai/azure-openai`: remote MCP servers map to native Responses API MCP tools, including approval request/response flow.
- `@zhivex-ai/anthropic`: MCP toolsets map to Anthropic `mcp_servers` plus `mcp_toolset`.
- `@zhivex-ai/gemini` and `@zhivex-ai/vertex`: `geminiMcpTools()` and `vertexMcpTools()` re-export the shared MCP wrapper for SDK-managed MCP clients.
- `@zhivex-ai/bedrock`: `createBedrockAgentCoreMcpClient()` and `createBedrockAgentCoreMcpToolSet()` expose AWS-native AgentCore Runtime or Gateway MCP endpoints as SDK-managed callable tools. This is separate from `runtime: "openai"` hosted MCP and approvals.

Use the shared helper when you already have an MCP client in-process:

```ts
import { createMcpToolSet, generateText } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const tools = await createMcpToolSet(myMcpClient);

const result = await generateText({
  model: gemini("gemini-3.5-flash"),
  prompt: "Use the MCP tools if needed.",
  tools
});
```

For AWS-native remote tools on Bedrock Converse, point the Bedrock AgentCore MCP client at either a runtime ARN or an explicit AgentCore/Gateway endpoint and pass the resulting toolset into the shared agent loop:

```ts
import { runAgent } from "@zhivex-ai/sdk";
import { createBedrock, createBedrockAgentCoreMcpToolSet } from "@zhivex-ai/bedrock";

const bedrock = createBedrock({
  region: process.env.AWS_REGION
});

const tools = await createBedrockAgentCoreMcpToolSet(
  {
    runtimeArn: process.env.AGENTCORE_RUNTIME_ARN,
    region: process.env.AWS_REGION,
    bearerToken: process.env.AGENTCORE_BEARER_TOKEN
  },
  {
    toolNamePrefix: "agentcore_"
  }
);

const result = await runAgent(
  {
    model: bedrock("anthropic.claude-3-5-sonnet-20240620-v1:0"),
    tools,
    maxSteps: 4
  },
  {
    prompt: "Use the AWS AgentCore tools when useful."
  }
);
```

When you want a richer composition surface, build a registry first and materialize it with `toToolSet()` only at the edge:

```ts
import { createMcpToolRegistry, createToolRegistry, toToolSet, tool } from "@zhivex-ai/sdk";

const localTools = createToolRegistry({
  weather: tool({
    name: "weather",
    schema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, forecast: "sunny" })
  })
});

const mcpTools = await createMcpToolRegistry(myMcpClient, {
  toolNamePrefix: "docs_"
});

const tools = toToolSet(localTools.merge(mcpTools));
```

### Advanced Tool Registry

The experimental advanced registry adds stronger tool metadata, permission labels, audit fields, HTTP-backed tools, fixture helpers, inspection helpers, and local test helpers while still converting back to the stable `ToolSet` contract.

```ts
import {
  createAdvancedToolRegistry,
  createHttpTool,
  createToolPermissionPreset,
  inspectToolRegistry,
  recordToolTestFixture,
  runToolTestFixture,
  tool
} from "@zhivex-ai/sdk";
import { z } from "zod";

const registry = createAdvancedToolRegistry([
  {
    tool: tool({
      name: "weather",
      schema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, forecast: "sunny" })
    }),
    source: "local",
    ...createToolPermissionPreset("read-only")
  },
  createHttpTool({
    name: "crm_update",
    description: "Update CRM notes through an application-owned service.",
    schema: z.object({ customerId: z.string(), note: z.string() }),
    url: "https://api.example.com/tools/crm-update",
    headers: {
      authorization: `Bearer ${process.env.CRM_TOOL_TOKEN}`
    }
  })
]);

const fixture = await recordToolTestFixture(registry, [
  { toolName: "weather", input: { city: "Madrid" } }
]);
const results = await runToolTestFixture(registry, fixture);
const inspection = inspectToolRegistry(registry);

const tools = registry.toToolSet();
```

`toToolSet()` preserves compatibility with `generateText()`, `runAgent()`, `streamAgent()`, and provider adapters. Sensitive permissions such as `write`, `filesystem`, `code-execution`, `shell`, and `external-side-effect`, as well as `high` or `critical` audit risk, mark the materialized tool as `requiresApproval`.

For OpenAI and Azure OpenAI remote MCP servers, use the provider helpers and pass approval responses back as `provider-data` parts:

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createOpenAI, openAIMcpApprovalResponse, openAIRemoteMcpTool } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-5"),
  prompt: "Search the docs through MCP.",
  tools: {
    docs: openAIRemoteMcpTool({
      server_label: "docs",
      server_url: "https://example.com/mcp"
    })
  }
});

const approval = result.messages
  .at(-1)
  ?.parts.find((part) => part.type === "provider-data" && part.provider === "openai");

if (approval) {
  await generateText({
    model: openai("gpt-5"),
    messages: [
      ...result.messages,
      {
        role: "user",
        parts: [
          openAIMcpApprovalResponse({
            approval_request_id: "mcpr_123",
            approve: true
          })
        ]
      }
    ],
    tools: {
      docs: openAIRemoteMcpTool({
        server_label: "docs",
        server_url: "https://example.com/mcp"
      })
    }
  });
}
```

If you are already on the shared agent runtime, prefer `runAgent()` / `resumeAgent()` for the same flow. That keeps approvals in `state.pendingApprovals` and avoids rebuilding the follow-up message yourself.

```ts
import { generateText, hostedTool, user } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-5"),
  messages: [user("Summarize today's AI news and cite sources.")],
  tools: {
    web: hostedTool({
      name: "web",
      provider: "openai",
      type: "web_search"
    })
  }
});

console.log(result.text);
```

When the selected model supports tool selection, you can control it through the common `toolChoice` option instead of dropping to provider-specific request fields.

```ts
const forcedToolResult = await generateText({
  model: anthropic("claude-sonnet-5"),
  messages: [user("What is the weather in Madrid?")],
  tools: {
    weather: tool({
      name: "weather",
      schema: z.object({
        city: z.string()
      }),
      execute: async ({ city }) => ({
        city,
        forecast: "sunny"
      })
    })
  },
  toolChoice: {
    type: "tool",
    toolName: "weather"
  }
});
```

### Multimodal Messages

Use explicit messages when you need full control over roles, parts, or multimodal inputs.

```ts
import { generateText, user } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateText({
  model: openai("gpt-4o-mini"),
  messages: [
    user([
      { type: "text", text: "Describe this image." },
      { type: "image", image: "https://example.com/cat.jpg" }
    ])
  ]
});

console.log(result.text);
```

### Embeddings

```ts
import { embedMany } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await embedMany({
  model: openai.embeddingModel("text-embedding-3-small"),
  value: ["Zhivex AI SDK", "Unified providers"]
});

console.log(result.embeddings.length);
```

Ollama also supports the shared embeddings contract through its `/api/embed` endpoint:

```ts
import { embed } from "@zhivex-ai/sdk";
import { createOllama } from "@zhivex-ai/ollama";

const ollama = createOllama();

const result = await embed({
  model: ollama.embeddingModel("embeddinggemma"),
  value: "Zhivex AI SDK"
});

console.log(result.embeddings[0]?.length);
```

Gemini supports multimodal embedding values through `gemini-embedding-2`; other embedding providers remain text-only unless their adapter explicitly documents media support.

```ts
import { embed } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const imageEmbedding = await embed({
  model: gemini.embeddingModel("gemini-embedding-2"),
  value: {
    uri: "gs://my-bucket/product-photo.png",
    mediaType: "image/png"
  }
});

console.log(imageEmbedding.embeddings[0]?.length);
```

For RAG-backed agents, use `chunkText()`, `embedRetrievalDocuments()`, `retrieveContext()`, and `createRetrievalContextMessage()` with an app-owned vector store. See [RAG Guide](./docs/RAG.md).

### Audio

Use the shared audio primitives when you want a provider-agnostic contract for transcription or text-to-speech.

```ts
import { generateSpeech, transcribeAudio } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const transcript = await transcribeAudio({
  model: openai.transcriptionModel("gpt-4o-mini-transcribe"),
  audio: {
    data: "BASE64_AUDIO",
    mediaType: "audio/wav",
    filename: "sample.wav"
  }
});

const speech = await generateSpeech({
  model: openai.speechModel("gpt-4o-mini-tts"),
  input: transcript.text
});

console.log(transcript.text);
console.log(speech.mediaType, speech.audio.length);
```

Audio-capable chat models can also receive and return audio through normal language-model generation:

```ts
import { audioPart, generateText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const answer = await generateText({
  model: openai("gpt-audio-mini"),
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text: "Summarize this recording." },
        audioPart({
          data: "BASE64_AUDIO",
          mediaType: "audio/wav"
        })
      ]
    }
  ],
  providerOptions: {
    modalities: ["text", "audio"],
    audio: { voice: "alloy", format: "wav" }
  }
});

console.log(answer.text);
console.log(answer.audio?.[0]?.mediaType);
```

Gemini language models can receive audio parts for understanding and summarization through `generateText()`:

```ts
import { audioPart, generateText } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const summary = await generateText({
  model: gemini("gemini-3.5-flash"),
  messages: [
    {
      role: "user",
      parts: [
        { type: "text", text: "Summarize this recording." },
        audioPart({
          data: "BASE64_AUDIO",
          mediaType: "audio/wav"
        })
      ]
    }
  ]
});

console.log(summary.text);
```

For Gemini audio output, use `speechModel()` with `generateSpeech()` for TTS or `realtimeModel()` for Live sessions; regular Gemini `generateText()` keeps audio output disabled.

### Generative Media

Use the shared media primitives with Google models that expose image, video, or music generation.

```ts
import { generateImage, generateMusic, generateVideo } from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";

const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY
});

const image = await generateImage({
  model: gemini.imageGenerationModel!("gemini-3.1-flash-image"),
  prompt: "Create a crisp product shot of a matte black espresso cup"
});

const video = await generateVideo({
  model: gemini.videoGenerationModel!("veo-3.1-generate-preview"),
  prompt: "A cinematic dolly shot through a quiet modern library"
});

const music = await generateMusic({
  model: gemini.musicGenerationModel!("lyria-3-clip-preview"),
  prompt: "Create a 30-second optimistic acoustic intro"
});

console.log(image.images[0]?.mediaType);
console.log(video.videos[0]?.uri);
console.log(music.audio[0]?.mediaType);
```

### Google Files, Retrieval, Batch, Interactions, And Raw Prediction

Gemini and Vertex expose Google-native surfaces in two layers:

| Surface | Gemini | Vertex |
| --- | --- | --- |
| Files API | high-level | not exposed by the same Vertex contract |
| File Search stores | high-level + hosted tool | hosted tool only when the selected Vertex endpoint supports it |
| URL Context | hosted tool | hosted tool |
| Context Caching | high-level | high-level |
| Batch API | high-level | high-level |
| Interactions / Deep Research | high-level | not exposed by the same Vertex contract |
| Model Garden / publisher prediction | raw/prediction | raw/prediction |

```ts
import {
  createBatch,
  createContextCache,
  createFileSearchStore,
  createInteraction,
  generateText,
  googleComputerUseTool,
  googleFileSearchTool,
  googleUrlContextTool,
  predictRaw,
  uploadFile
} from "@zhivex-ai/sdk";
import { createGemini } from "@zhivex-ai/gemini";
import { createVertex } from "@zhivex-ai/vertex";

const gemini = createGemini({ apiKey: process.env.GEMINI_API_KEY });

const file = await uploadFile({
  provider: gemini,
  data: "SDK notes",
  mediaType: "text/plain",
  displayName: "notes.txt"
});

const store = await createFileSearchStore({ provider: gemini, displayName: "Docs" });

await generateText({
  model: gemini("gemini-3.5-flash"),
  prompt: "Answer from the indexed docs and this URL.",
  tools: {
    docs: googleFileSearchTool([store.name]),
    urls: googleUrlContextTool()
  }
});

await createContextCache({
  provider: gemini,
  modelId: "gemini-3.5-flash",
  contents: [{ role: "user", parts: [{ type: "file", data: file.uri ?? file.name, mediaType: "text/plain" }] }]
});

await createBatch({
  provider: gemini,
  modelId: "gemini-3.5-flash",
  requests: [{ request: { contents: [{ parts: [{ text: "Summarize this." }] }] } }]
});

await createInteraction({
  provider: gemini,
  modelId: "gemini-3.5-flash",
  input: "Run a deep research style interaction."
});

const computer = await createInteraction({
  provider: gemini,
  modelId: "gemini-3.5-flash",
  input: "Open the dashboard and find the failed checkout.",
  tools: {
    computer: googleComputerUseTool({ environment: "browser" })
  }
});

await createInteraction({
  provider: gemini,
  modelId: "gemini-3.5-flash",
  previousInteractionId: computer.id,
  input: [
    {
      screenshot: "data:image/png;base64,...",
      function_response: {
        name: "computer_use",
        response: { status: "clicked" }
      }
    }
  ],
  tools: {
    computer: googleComputerUseTool({ environment: "browser" })
  }
});

const vertex = createVertex({
  apiKey: process.env.GOOGLE_API_KEY
});

const productionVertex = createVertex({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1"
});

await generateText({
  model: vertex("gemini-3.5-flash"),
  prompt: "Use the API-key quickstart path."
});

const raw = await predictRaw({
  model: productionVertex.predictionModel!("publisher-model-id"),
  instances: [{ prompt: "provider-specific request" }],
  parameters: { temperature: 0.2 }
});

console.log(raw.rawResponse);
```

Vertex authentication follows Google's current guidance: use `apiKey`, `VERTEX_API_KEY`, or `GOOGLE_API_KEY` for testing, and use ADC/service-account credentials in production. `createVertex({ projectId, location })` resolves ADC automatically, while `authClient`, `getAccessToken`, and `accessToken` remain available for explicit integrations. See Google's docs for [API keys](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys), the [Vertex AI quickstart](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start?usertype=apikey), and [Vertex AI authentication](https://docs.cloud.google.com/vertex-ai/docs/authentication).

Naming note: Google now presents this product surface as [Gemini Enterprise Agent Platform, formerly Vertex AI](https://cloud.google.com/products/gemini-enterprise-agent-platform), and its migration docs say Vertex AI is transitioning to become part of Agent Platform. The SDK keeps `@zhivex-ai/vertex`, `createVertex()`, and provider id `"vertex"` for compatibility while Google Cloud's public API surface still uses Vertex/`aiplatform.googleapis.com` endpoints.

Use `predictionModel()` for Vertex Model Garden and other Google publisher endpoints that do not have a stable shared helper yet. The SDK keeps `rawResponse` available so consumers can handle model-specific contracts without the core API overpromising portability.

### Grounded Web Search

`generateGroundedText()` runs a grounded generation request and returns normalized sources alongside the final answer.

```ts
import { generateGroundedText } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const result = await generateGroundedText({
  model: openai.groundedLanguageModel("gpt-4o-search-preview"),
  prompt: "What changed recently in multi-provider AI SDKs?"
});

console.log(result.text);
console.log(result.sources);
```

## Switching Providers

The application-facing API remains the same. In most cases, switching providers only requires replacing the adapter factory and model identifier.

```ts
import { generateText } from "@zhivex-ai/sdk";
import { createAnthropic } from "@zhivex-ai/anthropic";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const prompt = "Respond in one short sentence.";

const fromOpenAI = await generateText({
  model: openai("gpt-4o-mini"),
  prompt
});

const fromAnthropic = await generateText({
  model: anthropic("claude-sonnet-5"),
  prompt
});

console.log(fromOpenAI.text);
console.log(fromAnthropic.text);
```

## Gateway Routing

`@zhivex-ai/gateway` is the optional SDK-local routing and fallback package for multi-provider setups. It is separate from the main `@zhivex-ai/sdk` facade and separate from any Zhivex-hosted Gateway API. See [`packages/gateway/README.md`](./packages/gateway/README.md) for routing examples and package-specific behavior.

`generateObject()` and `streamObject()` now route through the same gateway metadata path as text generation. Native object mode requires `structuredOutput`; prompted object mode requires `jsonMode`; auto mode accepts either capability and skips targets that cannot satisfy object output before making a provider call.

## Public API Surface

The recommended package, `@zhivex-ai/sdk`, re-exports the high-level primitives from `core`, including:

- `generateText`, `streamText`
- `generateObject`, `streamObject`
- `transcribeAudio`, `generateSpeech`
- `generateGroundedText`
- `embed`, `embedMany`
- message helpers such as `system`, `user`, `assistant`, `tool`, `textPart`
- shared types such as `ReasoningConfig`, `GenerateTextOptions`, and `GenerateObjectOptions`
- stream and HTTP helpers such as `toTextStreamResponse`, `toUIMessageStreamResponse`, `toSSEStream`, and related UI serialization utilities
- middleware and runtime helpers such as telemetry, caching, circuit breakers, and `wrapLanguageModel`

If you are building custom adapters or lower-level integrations, use `@zhivex-ai/core` directly.

If you are building an agent-focused service and do not want the full aggregator surface, use `@zhivex-ai/agents`. It re-exports the current agent contracts from `core`; it does not define a separate runtime.

## Repository Layout

```text
packages/
  core/           Shared contracts, runtime helpers, streams, middleware, catalog
  sdk/            Aggregated public API
  agents/         Agent-first facade over the core runtime
  openai/         OpenAI adapter
  azure-openai/   Azure OpenAI adapter
  anthropic/      Anthropic adapter
  gemini/         Gemini adapter
  vertex/         Vertex AI adapter
  qwen/           Qwen adapter
  kimi/           Kimi adapter
  deepseek/       DeepSeek adapter
  openrouter/     OpenRouter adapter
  bedrock/        AWS Bedrock adapter
  ollama/         Ollama adapter
  gateway/        Routing and fallback package
```

## Development

The repository uses Bun workspaces, TypeScript project references, and Vitest.

```bash
bun install
bun run typecheck
bun run test
bun run build
```

The integration layer now includes provider-specific tests plus capability-first suites under [`packages/core/tests/`](./packages/core/tests). These capability suites exercise the shared contract across any providers that have credentials available in the current environment.

Maintainer-only release and provider-smoke workflows live under [`docs/maintainers/`](./docs/maintainers/README.md).

## Design Principles

- `core` is the single source of truth for shared contracts, capabilities, errors, and high-level helpers.
- Provider packages should translate between external APIs and the shared contract, while keeping provider-specific behavior explicit.
- New capabilities should be introduced in the shared contract first, then implemented by adapters as supported.
- Unsupported features should be represented through capabilities or explicit errors rather than implicit behavior.

## License

MIT
