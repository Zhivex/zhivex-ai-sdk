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
  includeToolInputs: false
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

Trace helpers inspect saved state. They do not call models or tools.

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

## Local CLI Inspection

`@zhivex-ai/sdk` includes local dry-run utilities for saved states and ledgers:

```bash
zhivex-ai agents ledger --state agent-run-state.json --out run-ledger.json
zhivex-ai agents inspect --ledger run-ledger.json
zhivex-ai agents diff --base previous-ledger.json --target current-ledger.json
zhivex-ai agents golden --ledger run-ledger.json --name happy-path --out golden-trace.json
zhivex-ai agents eval --golden golden-trace.json --ledger run-ledger.json --out agent-eval.json
```

These commands do not execute models or tools.

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

```ts
import { Agent, createOtelAgentObserver } from "@zhivex-ai/sdk";

const observer = await createOtelAgentObserver();

const agent = new Agent({
  model,
  onTelemetryEvent: observer
});
```

Agent telemetry events include run start/finish, step start/finish, approvals, memory loads, guardrails, state saves, handoffs, subagent starts, subagent finishes, and tool approval decisions.

## Recommended Pipeline

1. Persist `AgentRunState` in an app-owned store.
2. Export redacted audit and tool audit records.
3. Export compact trace summaries and cost estimates.
4. Promote reviewed successful runs into golden traces.
5. Run fixtures in CI before publishing agent changes.
6. Use provider support drift reports when provider capabilities are part of routing decisions.

## Competitive Boundary

Zhivex provides portable artifacts and CLI inspection. It does not currently ship a hosted observability UI like LangSmith or Mastra Studio. The intended integration point is your app's logging, warehouse, dashboard, or existing observability platform.
