# Production Guide

This SDK is a runtime library. Your application still owns auth, tenancy, billing, provider credentials, rate limits, and HTTP contracts.

If you are moving from direct provider SDKs, Vercel AI SDK core usage, or a custom tool loop, start with the [Migration Guide](./MIGRATION.md) and then apply the production path below. For long-term semantic memory and retrieval-augmented generation, see the [RAG Guide](./RAG.md).

## Recommended Architecture

```text
Client
  -> your API route/server action
    -> auth and tenant lookup
    -> provider/model selection
    -> Runner or Workflow
    -> durable SessionService / WorkflowStateService / ArtifactService
```

Keep this boundary:

- Browser: UI, user input, display state.
- App/API server: SDK usage, provider credentials, tools, stores, policy.
- Database/object store: durable session, workflow state, artifact metadata, blobs.

## Production Runner Path

For most chat or multi-turn agent products, start with `Runner + SessionService`.

```ts
import { createAgent, createPostgresSessionService, createRunner } from "@zhivex-ai/sdk";
import { createOpenAI } from "@zhivex-ai/openai";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const agent = createAgent({
  model: openai("gpt-4o-mini"),
  instructions: "You are a concise support assistant."
});

const sessionService = createPostgresSessionService({
  client: postgresClient
});

const runner = createRunner({
  appName: "support-api",
  agent,
  sessionService
});
```

`postgresClient` is app-owned. The SDK expects a compatible client with a `query(sql, params)` method; it does not import or require a specific database driver. This keeps the package dependency surface small and lets the application decide whether it uses `pg`, `postgres`, Neon, Supabase, or another Postgres-compatible client.

Use the runner from server code:

```ts
const result = await runner.run({
  userId: authenticatedUser.id,
  sessionId: request.sessionId,
  prompt: request.message,
  eventMetadata: {
    route: "POST /api/chat"
  }
});

return {
  sessionId: result.session.sessionId,
  status: result.output.status,
  text: result.output.outputText
};
```

The application resolves `authenticatedUser`, workspace, billing, provider credentials, rate limits, and model selection before calling the SDK.

## Store Choices

Use the lowest durable store that matches the runtime:

| Runtime | Recommended store |
| --- | --- |
| Unit tests | in-memory |
| Local scripts | file-backed |
| Local app demo | file-backed or SQLite |
| Long-running Node service | Postgres or SQLite |
| Serverless / Vercel | Postgres |
| Large binary artifacts | file/in-memory for SDK-managed blobs, or app-owned object storage with external artifact references |

File-backed stores are intentionally simple and inspectable, but they rely on local disk. In serverless production, that disk may disappear or differ between instances.

`createPostgresSessionService()` lazily creates its session table by default. Use `tableName` when a product needs an app-specific table name, and keep migrations or database ownership in the application if your deployment process requires strict schema control.

## Identity Mapping

The SDK uses application-level identifiers:

- `appName`: logical application or tenant namespace.
- `userId`: app-resolved user identifier.
- `sessionId`: app-visible conversation/session key.

In a SaaS API, you can map these from your own control plane:

```ts
const runner = createRunner({
  appName: workspace.id,
  agent,
  sessionService
});

const result = await runner.run({
  userId: authenticatedUser.id,
  sessionId: request.sessionId,
  prompt: request.message
});
```

Do not put workspace, API key, billing, or BYOK rules inside the SDK layer. Resolve them before constructing the agent/runner.

## Concurrency

Durable records include `revision`. Stores support compatible last-write-wins by default, and optimistic concurrency when you pass `expectedRevision`.

```ts
const session = await sessionService.loadSession(lookup);

if (session) {
  await sessionService.saveSession(updatedSession, {
    expectedRevision: session.revision
  });
}
```

If the stored revision changed, the SDK raises `ConflictError`.

## Safety Path

For agents with tools, apply a safety policy before creating the runner. This composes existing guardrails, approval policy, redaction, and budget limits without changing the agent runtime contract.

```ts
import { applySafetyPolicyToAgent, createProductionSafetyPolicy } from "@zhivex-ai/sdk";

const safeAgent = applySafetyPolicyToAgent(
  agent,
  createProductionSafetyPolicy()
);
```

`createProductionSafetyPolicy()` is a stable preset for first production deployments. It uses `review-sensitive`, email redaction, and conservative budget defaults. Pass the same options accepted by `createSafetyPolicy()` when a product needs to override or disable a layer. Use `locked-down` when every tool call should require approval. Use `permissive` only for trusted internal tools or local development.

For audited domains, add the Beta production-agent kit on top of the stable policy:

```ts
import {
  createAgentAuditRecord,
  createReadOnlyToolApprovalPolicy,
  createSensitiveDataPolicy,
  createToolAuditRecords
} from "@zhivex-ai/sdk";

const redaction = createSensitiveDataPolicy();
const toolApprovalPolicy = createReadOnlyToolApprovalPolicy();

const agentAudit = createAgentAuditRecord(result.state, { redaction });
const toolAudit = createToolAuditRecords(result.state, { redaction });
```

`createReadOnlyToolApprovalPolicy()` blocks write/side-effect-looking tools by default and can be used directly as an agent or request `toolApprovalPolicy`. Audit records omit full tool input/output unless explicitly included.

## Observability Export Path

Agent runs already produce enough SDK data for production dashboards without adding a required telemetry backend. Keep observability server-side, attach a collector or OTEL observer to the agent, and export only redacted records to your log, queue, warehouse, or tracing vendor.

```ts
import {
  createAgent,
  createAgentTraceArtifact,
  createProductionTraceCollector,
  estimateAgentRunCost,
  runAgent,
  summarizeAgentTrace
} from "@zhivex-ai/sdk";

const collector = createProductionTraceCollector({
  includeToolInputs: true,
  outputPreviewLength: 500
});

const agent = createAgent({
  model,
  onTelemetryEvent: collector.observer,
  tools
});

const result = await runAgent(agent, {
  userId: authenticatedUser.id,
  prompt: request.message
});

const trace =
  collector.getTrace(result.state.runId) ??
  createAgentTraceArtifact(result.state, {
    includeToolInputs: true,
    outputPreviewLength: 500
  });

const summary = summarizeAgentTrace(trace, {
  pricing: {
    inputCostPer1kTokens: 1,
    outputCostPer1kTokens: 3,
    currency: "USD"
  }
});

const costFromSavedState = estimateAgentRunCost(result.state, {
  costPer1kTokens: 0.6,
  currency: "USD"
});
```

Use the summary for stable dashboard dimensions:

| Field | Source |
| --- | --- |
| `runId`, `agentId` | `summary` |
| `sessionId`, `userId`, workspace | app-owned request/session context |
| `provider`, `modelId` | `summary` |
| `status`, `steps`, `toolCalls`, `toolErrors`, `approvals` | `summary` |
| `latency.durationMs` | `summary` |
| `usage`, `cost` | `summary`, reproducible with `estimateAgentRunCost()` |

Export a separate tool-call audit record when a run uses local or provider tools. A minimal record usually needs `runId`, `agentId`, `step`, `toolName`, `toolCallId`, `status`, redacted `input`, redacted `output`, and `error`.

Redaction should happen before data leaves the API process. Keep `includeMessages` and `includeToolInputs` disabled unless the destination is approved for sensitive payloads, or redact the trace first. Typical product redaction rules mask keys such as `email`, `apiKey`, `authorization`, `token`, and `secret`, plus email-like substrings inside strings. Preserve metric keys such as `inputTokens`, `outputTokens`, and `totalTokens` so cost dashboards stay useful.

For JSONL exports, write one line per summary, trace artifact, and tool-call audit record:

```ts
const records = [
  { type: "agent_trace_summary", ...summary },
  { type: "agent_trace_artifact", ...trace },
  ...toolAuditRecords
];

for (const record of records) {
  await observabilitySink.write(JSON.stringify(redact(record)) + "\n");
}
```

Use OTEL helpers when your application already has OpenTelemetry configured:

```ts
import { createOtelAgentObserver, createOtelTelemetryMiddleware, wrapLanguageModel } from "@zhivex-ai/sdk";

const agent = createAgent({
  model: wrapLanguageModel(model, [await createOtelTelemetryMiddleware()]),
  onTelemetryEvent: await createOtelAgentObserver()
});
```

See `examples/sdk/observability-export.ts` for a runnable local example that captures a trace, produces a cost/latency summary, builds tool-call audit records, and redacts sensitive fields before emitting JSONL.

## Workflows

Use workflows when the process has named steps:

```text
intake -> research -> review -> final
```

Use `WorkflowStateService` for durable workflow state. Session metadata fallback exists for compatibility and compact apps, but the first-class state service is the recommended production shape.

## Artifacts

Use artifacts for outputs you want to keep, inspect, or attach to workflow steps:

- workflow final reports
- intermediate JSON outputs
- generated files
- evaluation reports
- replay timelines

For large production binaries, prefer app-owned blob storage and keep an SDK artifact record as metadata:

For base64 artifacts stored directly through `saveArtifact()`, set `encoding: "base64"`. The SDK calculates missing `size` and `sha256` metadata and validates any values you provide.

```ts
import { createExternalArtifactReference } from "@zhivex-ai/sdk";

const externalFile = createExternalArtifactReference({
  uri: "s3://bucket/path/contract.pdf",
  metadata: {
    storageProvider: "s3"
  }
});

await artifactService.saveArtifact({
  appName,
  userId,
  sessionId,
  name: "contract.pdf",
  contentType: "application/pdf",
  ...externalFile,
  metadata: {
    ...externalFile.metadata,
    kind: "external-file"
  }
});
```

## Operational Checklist

- Use server-side SDK imports only.
- Keep provider keys in server environment variables or your secret manager.
- Use Postgres for shared production session state.
- Keep `Runner + SessionService` as the default chat/multi-turn surface.
- Wrap tool-using agents with `createSafetyPolicy()` before exposing them to real users.
- Use workflows only when named steps and replay/eval matter.
- Store artifacts explicitly; `runWorkflow()` does not auto-save them.
- Keep semantic/RAG memory in an app-owned retriever or vector store.
- Log `runId`, `sessionId`, `status`, and provider/model identifiers.
- Log or export trace/cost summaries when the agent performs tool calls or uses expensive models.
- Treat Beta surfaces behind an app-owned abstraction until they are promoted.
