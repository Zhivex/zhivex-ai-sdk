# Agent Observability Guide

Zhivex AI SDK keeps observability app-owned. The SDK provides stable trace, replay, evaluation, audit, and ledger artifacts that your product can write to logs, queues, warehouses, dashboards, or SIEM tools.

## What To Capture

For production agent runs, capture at least:

- run id, agent id, provider, model id, status, started/updated timestamps
- token usage and estimated cost
- step count, tool call count, tool error count
- pending or resolved approvals
- redacted output preview
- redacted tool audit records for side-effecting tools
- replay snapshots for reproducible debugging

Avoid exporting raw prompts, tool inputs, tool outputs, provider error bodies, secrets, credentials, personal contact data, or payment identifiers unless your product has a clear policy for them.

## Trace Summaries

```ts
import { createAgentTraceArtifact, estimateAgentRunCost, summarizeAgentTrace } from "@zhivex-ai/sdk";

const trace = createAgentTraceArtifact(result.state, {
  includeMessages: false,
  includeToolInputs: false,
  includeToolOutputs: false,
  includeApprovalArguments: false,
  includeOutputText: false,
  redaction: { includeEmails: true }
});

const summary = summarizeAgentTrace(trace, {
  latencyPercentiles: [0.5, 0.95]
});

const cost = estimateAgentRunCost(result.state, {
  inputCostPer1kTokens: 0.01,
  outputCostPer1kTokens: 0.03,
  currency: "USD"
});
```

Trace helpers inspect saved state. They do not call models or tools. Full output text, tool payloads, and approval arguments are omitted by default; every sensitive payload family requires an explicit `include*` opt-in.

## Audit Records

Use audit records for compliance-friendly exports:

```ts
import { createAgentAuditRecord, createToolAuditRecords } from "@zhivex-ai/sdk";

const runAudit = createAgentAuditRecord(result.state, {
  includeMetadata: true,
  redaction: {
    includeEmails: true
  }
});

const toolAudit = createToolAuditRecords(result.state, {
  includeInput: false,
  includeOutput: false,
  includeMetadata: true
});
```

Keep full tool payloads server-side unless a user or compliance workflow explicitly needs them.

## Ledgers And Golden Traces

For agent operations, a ledger combines snapshot, replay timeline, audit, tool audit, trace, summary, and optional cost:

```ts
import { createAgentRunLedger, promoteAgentGoldenTrace } from "@zhivex-ai/sdk";

const ledger = createAgentRunLedger(result.state, {
  includeTimeline: true,
  includeInput: false,
  includeOutput: false,
  pricing: {
    inputCostPer1kTokens: 0.01,
    outputCostPer1kTokens: 0.03,
    currency: "USD"
  }
});

const golden = promoteAgentGoldenTrace(ledger, {
  name: "support-happy-path"
});
```

Golden traces are regression fixtures. Promote them from reviewed successful runs, not from arbitrary production traffic.

Ledgers are fail-closed by default: snapshot messages/output, replay timeline payloads, audit metadata, tool inputs/outputs, approval arguments, trace payloads, and full output text are omitted or redacted unless the corresponding `include*` option is explicitly enabled. `includeTimeline` is also opt-in. Keep a single reviewed option set for the entire ledger so a permissive nested trace cannot bypass the outer export policy.

`createProductionTraceCollector()` bounds retained runs and events and expires inactive runs. Its defaults retain at most 1,000 runs, 1,000 events per run, and 24 hours of inactive data; lower these limits for high-volume or sensitive workloads.

## Local CLI Inspection

`@zhivex-ai/sdk` includes local dry-run utilities for saved states and ledgers:

```bash
zhivex-ai agents ledger --state agent-run-state.json --out run-ledger.json
zhivex-ai agents ledger --state agent-run-state.json --out full-run-ledger.json --include-output-text
zhivex-ai agents inspect --ledger run-ledger.json
zhivex-ai agents diff --base previous-ledger.json --target current-ledger.json
zhivex-ai agents golden --ledger run-ledger.json --name happy-path --out golden-trace.json
zhivex-ai agents eval --golden golden-trace.json --ledger run-ledger.json --out agent-eval.json
```

These commands do not execute models or tools. Ledger generation omits full output text and output previews by default; `--include-output-text` is an explicit opt-in for a reviewed local destination.

## Evaluation Fixtures

Use deterministic fixtures to catch regressions in tool use, status, child-agent behavior, and output shape:

```ts
import {
  createAgentEvaluationFixture,
  createAgentEvaluationReport,
  runAgentEvaluationFixture
} from "@zhivex-ai/sdk";

const fixture = createAgentEvaluationFixture({
  name: "support-agent",
  dataset: [
    {
      name: "lookup-before-answer",
      input: { prompt: "Check ticket_123." },
      expectations: {
        status: "completed",
        outputContains: "ticket_123",
        toolCalls: ["lookupTicket"]
      }
    }
  ]
});

const evaluation = await runAgentEvaluationFixture(fixture, { agent });
const report = createAgentEvaluationReport(evaluation);
```

For non-deterministic quality checks, add a judge function or model-based judge, but keep hard expectations for safety and workflow invariants.

## OpenTelemetry Hooks

Attach telemetry observers when you need live lifecycle events:

```bash
bun add @opentelemetry/api
```

`@opentelemetry/api` is an optional peer of `@zhivex-ai/core`. Applications that do not create OTEL observers do not need to install it. The SDK and exporter remain app-owned; use your existing tracer provider, processors, exporters, context manager, and resource configuration.

```ts
import { metrics, trace } from "@opentelemetry/api";
import {
  Agent,
  createOtelAgentObserver,
  createOtelObserver,
  createOtelTelemetryMiddleware,
  createOtelWorkflowObserver,
  runWorkflow,
  wrapLanguageModel
} from "@zhivex-ai/sdk";

const tracer = trace.getTracer("my-app");
const meter = metrics.getMeter("my-app");
const otel = await createOtelObserver({ tracer });
const agentObserver = await createOtelAgentObserver({ observer: otel, meter });
const workflowObserver = await createOtelWorkflowObserver({ observer: otel, meter });

const agent = new Agent({
  id: "support-agent-v3",
  name: "Support Agent",
  model: wrapLanguageModel(model, [await createOtelTelemetryMiddleware({ observer: otel, meter })]),
  onTelemetryEvent: agentObserver
});

await runWorkflow({
  id: "support-pipeline-v2",
  name: "support_pipeline",
  steps,
  onTelemetryEvent: workflowObserver
}, { userId: "user_123" });
```

Agent telemetry events include run start/finish, step start/finish, provider and local-tool approval requests/resolutions, memory loads, agent/tool guardrails, state saves, handoffs, subagent starts, subagent finishes, and tool approval decisions. Local approval payloads are persisted in agent state rather than provider messages; keep full arguments and outputs redacted unless an approved sink explicitly needs them.

### OTEL GenAI v1 contract

`OTEL_GENAI_CONTRACT_VERSION` is `1`. `OTEL_GENAI_SEMCONV_REVISION` pins the exact upstream Development revision used to audit the mapping. The dedicated OpenTelemetry GenAI repository does not currently publish a usable schema URL, so Zhivex deliberately omits `schemaUrl` instead of attaching an unresolvable value. Upstream changes do not silently change this contract.

The default span names follow the OpenTelemetry GenAI semantic conventions where a standard operation exists:

| Operation | Default span name | Kind |
| --- | --- | --- |
| Agent run | `invoke_agent {agentName}` or `invoke_agent` | `INTERNAL` |
| Agent step | `agent_step` | `INTERNAL` |
| Model generation or stream | `chat {modelId}` | `CLIENT` |
| Local tool execution | `execute_tool {toolName}` | `INTERNAL` |
| Workflow invocation | `invoke_workflow {workflowName}` or `invoke_workflow` | `INTERNAL` |
| Workflow step | `workflow_step {stepId}` | `INTERNAL` |

Set `spanNamePrefix` to retain an application-specific naming scheme. Prefixed agent spans use `{prefix}.run` and `{prefix}.step`; model spans use `{prefix}.generate`, `{prefix}.stream`, and `{prefix}.tool`.

Zhivex emits the standard `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.*`, `gen_ai.response.*`, `gen_ai.usage.*`, `gen_ai.agent.name`, `gen_ai.tool.*`, `gen_ai.workflow.name`, and `gen_ai.conversation.id` attributes only where the corresponding convention applies. `AgentDefinition.id` remains `zhivex.agent_id`; it is not mislabeled as `gen_ai.agent.id`, which upstream reserves for provider-assigned hosted-agent identifiers. Provider names normalize known values such as `xai` → `x_ai` and `kimi` → `moonshot_ai`.

The adapters create the recommended histograms when a meter or registered global meter provider is available:

| Metric | Unit | Emission boundary |
| --- | --- | --- |
| `gen_ai.client.token.usage` | `{token}` | Input and output usage returned by model calls |
| `gen_ai.client.operation.duration` | `s` | Generate and stream completion/error |
| `gen_ai.client.operation.time_to_first_chunk` | `s` | First non-terminal streaming chunk only |
| `gen_ai.client.operation.time_per_output_chunk` | `s` | Every streaming chunk after the first |
| `gen_ai.invoke_agent.duration` | `s` | One in-process agent invocation |
| `gen_ai.invoke_agent.inference_calls` | `{inference_call}` | Inference calls attributed to that invocation |
| `gen_ai.invoke_agent.tool_calls` | `{tool_call}` | Client-side tool calls attributed to that invocation |
| `gen_ai.execute_tool.duration` | `s` | One local tool execution |
| `gen_ai.invoke_workflow.duration` | `s` | One end-to-end workflow invocation |

All histograms use the explicit bucket boundaries recommended by the pinned upstream revision. Stream chunk telemetry is timing-only and emitted incrementally; it never accumulates an unbounded chunk array.

Telemetry delivery is fail-open. Exceptions from tracers, spans, meters, or exporters do not replace a model, tool, agent, or workflow result, and the wrapped business operation is never retried by the telemetry layer.

Agent and workflow invocation spans begin before context or persisted-state resolution, so setup, store, lease, validation, and preflight failures still produce an error span and duration sample while preserving the original application error.

Workflow step execution activates its span context, and agent execution activates the agent-run context. When the factories share the same OpenTelemetry context manager, the resulting tree is `workflow → workflow step → agent → model/tool`; agent lifecycle step spans remain explicit children of the agent span. Explicit start/end timestamps keep span durations aligned with their duration metrics, including persisted-state reads and approval resumes.

Failed spans record the exception, set `error.type`, and use OTEL `ERROR` status. Normal cancellation and approval suspension close deterministically without being mislabeled as failures. A terminal event closes orphaned child spans, span handles are idempotent, and per-run queues prevent duplicate or out-of-order lifecycle events from double-ending spans.

Prompt text, messages, system instructions, tool arguments, tool results, and model output are never attached by these helpers. Guardrail event metadata is restricted to a bounded scalar allowlist under `zhivex.guardrail.metadata.*`; arbitrary keys, nested objects, and `gen_ai.*` injection are discarded. Upstream's `gen_ai.client.inference.operation.details` content event is opt-in and is not emitted. `gen_ai.evaluation.result` is also not synthesized automatically; evaluation reports remain app-owned and can be exported explicitly by the application's event/log pipeline.

## Recommended Pipeline

1. Persist `AgentRunState` in an app-owned store.
2. Export redacted audit and tool audit records.
3. Export compact trace summaries and cost estimates.
4. Promote reviewed successful runs into golden traces.
5. Run fixtures in CI before publishing agent changes.
6. Use provider support drift reports when provider capabilities are part of routing decisions.

## Competitive Boundary

Zhivex provides portable artifacts and CLI inspection. It does not currently ship a hosted observability UI like LangSmith or Mastra Studio. The intended integration point is your app's logging, warehouse, dashboard, or existing observability platform.
