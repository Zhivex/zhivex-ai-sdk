# Agents recipes

Start with the [Agents guide](../AGENTS.md), [Workflows guide](../WORKFLOWS.md), and [production guidance](../PRODUCTION.md). This page contains extended API recipes; those guides define the adoption path and operational requirements.

[Documentation index](../README.md)

## Agent Runtime

For reusable multi-step assistants, `Agent` is the stable agent-first API. It wraps the shared tool loop and exposes `run()`, `stream()`, `resume()`, and `toDefinition()` while preserving the same serializable state contract used by `createAgent()` and `runAgent()`.

Relevant runnable examples:

- [`examples/sdk/full-agent.ts`](../../examples/sdk/full-agent.ts)
- [`examples/sdk/agent-runtime.ts`](../../examples/sdk/agent-runtime.ts)
- [`examples/sdk/agent-stream.ts`](../../examples/sdk/agent-stream.ts)

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
- Multi-step `usage` is the aggregate across every model call, and each step keeps an immutable request snapshot with its actual model-call timing.
- `state` is JSON-serializable and can be persisted by your app.
- `Agent` and `createAgent()` keep reusable defaults such as `instructions`, `tools`, `maxSteps`, `reasoning`, and provider options in one place.
- `Agent.resume()` and `resumeAgent()` continue from a previous `state` instead of rebuilding the run manually.
- Production states include `queued`, `running`, `waiting_approval`, `cancel_requested`, `cancelled`, `timed_out`, `failed`, and `completed`. The legacy `suspended` status is still accepted when loading old persisted runs, but new approval waits use `waiting_approval`.

Prefer `Agent` for new application code and docs. Use `createAgent()` / `runAgent()` when you want a functional API, plain object definitions, or compatibility with existing code.

## Runner And Sessions

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

## Agent Control Plane

`Agent Control Plane` is a Stable layer for production agent operations. It does not replace `createAgent()` or `Runner`; it packages the operational metadata around them so applications can inspect, govern, replay, and route agent runs without binding the product to a single provider. The focused facade is exported from `@zhivex-ai/agents/control-plane`; `@zhivex-ai/agents/beta` remains a compatibility alias and also contains governance helpers that are still Beta.

The Stable control-plane surface includes:

- `createAgentCapsule()`: portable manifest for an agent, its tools, MCP servers, skills, evals, policy, provider, and agent tier. Its canonical SHA-256 fingerprint is bound to new durable runs.
- `createAgentToolPolicy()`: permission/risk-aware tool approval policy for read-only, supervised, write-deny, or allow-all modes. Supervised mode pauses tools marked `requiresApproval`, high-risk tools, and tools with network or write-like permissions unless the application explicitly allowlists the tool or permission.
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

const router = createAgentCapabilityRouter([openai("gpt-5"), anthropic("claude-sonnet-5")]);
const selected = router.select({ minTier: "tier-b", approvals: true, remoteMcp: true });

const agent = createAgent({
  id: "finance-risk",
  model: selected.model,
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

const controlPlane = createAgentControlPlane({ agent: capsule.agent });
const record = await controlPlane.run({ prompt: "Reconcile account acct_123." });

const ledger = createAgentRunLedger(record.state, {
  includeInput: false,
  includeOutput: false
});

console.log(capsule.manifest.agentTier);
console.log(capsule.manifest.fingerprint);
console.log(ledger.audit.toolCalls);
```

The control-plane layer is intentionally SDK-only. Workspaces, billing, project keys, auth, rate limits, and queues remain application-owned or Gateway-owned concerns. Treat provider capability routing as a runtime snapshot: it helps select the best candidate, but does not remove the need for provider-specific integration tests.

Resume a capsule-owned run with the same capsule definition. A changed capsule fingerprint is rejected before model or tool execution. Legacy states can only be attached to a fingerprint through the explicit `policy.allowLegacyHarnessResume` migration escape hatch.

Durable subagent calls derive a stable child idempotency key when the configured run store supports atomic idempotency claims. If the child completes but the parent checkpoint fails, retrying the parent reuses that child run instead of repeating its tools. Effectful integrations should still honor the execution idempotency key they receive.

The `read-only` tool policy only auto-approves tools that explicitly declare read permissions; missing permission metadata is denied. Run ledgers omit replay timelines, metadata, messages, tool payloads, approval arguments, and output text unless their corresponding opt-in is enabled. Included ledger fields, including run errors, tool errors, and cancellation reasons, are passed through the configured redaction policy.

Approval queue tokens are cryptographically random opaque values. Persist the queue item and token server-side, authorize the caller in the application, and use `controlPlane.resumeApproval()` to validate token, expiry, request fingerprint, and pending state before atomically consuming the approval through the durable run store. Never treat `resumeUrl` alone as authorization.

## Declarative Workflows

`createWorkflow()` and `runWorkflow()` run agent workflows on top of `Runner`. The Stable workflow surface supports sequential task steps, parallel groups, and bounded task loops. Each task calls a runner, can read previous step outputs, and can persist its own `outputKey` into the workflow state.

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

The `WorkflowStateService` contract and its in-memory, file-backed, SQLite, and Postgres implementations are Stable. SQLite is certified against `bun:sqlite`; Postgres restart/resume, compare-and-swap, durability, tenant isolation, and installed-package behavior run in a dedicated fail-closed CI job. Keep database clients, migrations, credentials, and application authorization/tenancy policy application-owned.

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

See the [canonical workflow example](../WORKFLOWS.md) for this configuration.

Loop iterations are recorded in the loop result's `children`. If an iteration pauses for approval, pass the saved workflow `state` and approval responses back to `runWorkflow()` to resume that pending iteration.

The workflow evaluation/report helpers are Stable. For local regression suites, they mirror the agent evaluation helpers:

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

## Artifacts

`ArtifactService` is a Stable, schema-versioned contract for JSON and binary artifacts associated with a session, workflow run, workflow step, or agent run. Built-in implementations cover in-memory, file-backed, SQLite, and Postgres storage:

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

The file-backed service writes one JSON file per artifact with a collision-resistant canonical key derived from `appName`, `userId`, `sessionId`, and `id`. Session, artifact, and workflow-state stores transparently fall back to legacy keys and migrate them on write. Newly created local-store directories use mode `0700` and files use `0600` on POSIX systems. The SDK also exposes `createSqliteArtifactService()` and `createPostgresArtifactService()` for production applications that already provide compatible database clients.

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

The file store writes blobs under a path-safe `blobs/` subdirectory and calculates `size` and `sha256` for `saveBinaryArtifact()`. If the caller supplies `sha256`, every built-in store verifies it against the bytes before persisting and stores the canonical lowercase digest. Blob paths are SDK-managed: callers cannot set them, and file-store metadata that points outside the expected blob location is rejected before any read, prune, or delete. SQLite and Postgres stores keep binary payloads as base64 JSON compatibility records. For heavy production binaries, prefer app-owned blob/object storage with durable artifact metadata in SQL until native SQL/blob streaming is introduced; `createExternalArtifactReference()` creates the standard metadata shape for that pattern.

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

Every built-in service applies configurable byte limits to JSON, text, base64, binary, metadata, and complete records. See the [Stable Artifact Service contract](../ARTIFACTS.md) for default limits, integrity semantics, backend guarantees, and external-storage boundaries.

## CLI / Dev UX

`@zhivex-ai/sdk` includes a Stable `zhivex-ai` CLI for local SDK state. Inspection commands are dry: they read JSON files, replay workflow state, and build reports without executing models or tools. Execution commands import an app-owned local module, so the app remains responsible for constructing runners, models, tools, and credentials.

```bash
zhivex-ai init agent --dir support-agent --provider openai --model gpt-5
zhivex-ai doctor --dir support-agent --provider openai
zhivex-ai init agent --dir deepseek-agent --provider deepseek
zhivex-ai doctor --dir deepseek-agent --provider deepseek
zhivex-ai init agent --dir zai-agent --provider zai
zhivex-ai doctor --dir zai-agent --provider zai

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
zhivex-ai agents ledger --state agent-run-state.json --out full-run-ledger.json --include-output-text
zhivex-ai agents inspect --ledger run-ledger.json
zhivex-ai agents diff --base previous-ledger.json --target current-ledger.json
zhivex-ai agents golden --ledger run-ledger.json --name happy-path --out golden-trace.json
zhivex-ai agents eval --golden golden-trace.json --ledger run-ledger.json --out agent-eval.json
```

Output is JSON pretty-printed by default. JSON output files are written with mode `0600`, and `init agent` creates its new project directory with mode `0700` on POSIX systems. The scaffold creates both `.env.example` and a private `.env` with mode `0600`, preserves an existing `.env`, and adds the local secret paths to `.gitignore`; `doctor` warns when `.env` permissions are unsafe. `init agent` scaffolds a Bun-first agent project with file-backed local sessions, a production safety policy, a provider package, a smoke-test tool, and scripts for doctor/inspect/ledger. Generated source safely quotes provider and model values. Use `workflow-states list/show` for first-class durable workflow state inspection; `sessions workflow-state show` remains available for legacy session-metadata fallback state. The `agents` inspection and evaluation commands are dry local control-plane utilities over saved run states and ledgers; they never execute models or tools. The CLI ledger command omits full output text and previews by default; pass `--include-output-text` only for an approved local destination. Prune commands are dry-run by default; pass `--execute` to delete. The CLI is intentionally local-only and does not introduce auth, workspaces, or Gateway calls.

The CLI rejects unknown or duplicate flags and unexpected positionals, supports `--name value` and `--name=value`, and exposes schema-versioned package metadata through `zhivex-ai version` or `zhivex-ai --version`. The [Stable CLI contract](../CLI.md) defines command compatibility, output and exit behavior, and safety boundaries.

## Agent Persistence And Memory

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

## Durable Agent Runs

Built-in run stores support compatible durability primitives for production agent services: schema-versioned state, atomic idempotency claims, optimistic concurrency, and cooperative cancellation.

```ts
import { cancelAgentRun, createAgent, createPostgresAgentRunStore, runAgent } from "@zhivex-ai/sdk";

const store = createPostgresAgentRunStore({ client: pgPool });
const agent = createAgent({
  model: openai("gpt-5"),
  store
});

const first = await runAgent(agent, {
  prompt: "Draft the customer reply.",
  scope: { tenantId: "acme", userId: "user-7" },
  idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined
});

await cancelAgentRun(store, first.state.runId, {
  scope: first.state.scope,
  reason: "User cancelled the request."
});
```

- New runs use `AGENT_RUN_STATE_SCHEMA_VERSION` and start with a monotonic `revision`.
- Legacy states without `schemaVersion` or `revision` are normalized when loaded or resumed. Future schema versions are rejected instead of being silently coerced. Use `normalizeAgentRunState()` or `migrateAgentRunState()` at application storage boundaries.
- `idempotencyKey` requires an agent run store that implements the atomic `claimIdempotencyKey()` contract. The built-in in-memory, file, SQLite, and Postgres stores support it.
- Concurrent requests with the same `idempotencyKey` share one `runId`; only the winner starts model or tool side effects. A duplicate returns the current persisted state, including `running` while the winner is still executing.
- Every persisted transition uses revision compare-and-swap. A stale concurrent resume, cancellation, or update throws `ConflictError` before starting another model/tool step.
- `scope: { tenantId, userId?, namespace? }` isolates run IDs, idempotency keys, parent indexes, memory, leases, and tool journals. Pass the same scope to run, resume, lookup, and cancellation operations.
- Active workers hold renewable leases. An expired lease can be recovered by another worker; a live lease prevents duplicate model/tool work. The runtime checkpoints every model response before tools and every tool batch before the next model call.
- Capsule-owned runs persist their harness fingerprint. Resuming with a different capsule id, version, or fingerprint fails before model or tool execution.
- `executionEnvironment` acquires an app-provided execution boundary per run, preauthorizes the complete tool-call batch, reauthorizes immediately before each call, and persists the environment fingerprint for safe resume. The SDK supplies the contract and enforcement hooks, not a managed sandbox service.
- `compaction` can summarize an old message prefix before a provider request while preserving leading system messages and an atomic recent tool-call/approval/result tail matched by correlation IDs. Protected groups that cannot fit the configured limits fail with `ValidationError`. Model and compactor usage are each counted once, including persisted streams and approval resumes; budget preflight uses the latest measured response usage. The compacted state and digests are persisted before the provider call, appear in replay, and stream as `agent-compaction`.
- Completed local tools are recorded in a durable journal. `tool.execute(input, context)` receives `context.idempotencyKey`; forward it to side-effecting APIs. Completed entries replay without rerunning the tool, while indeterminate executions are blocked for operator reconciliation.
- Use SQLite or Postgres for durable concurrent workers. The file store serializes revision CAS across local processes with a private, bounded lock that recovers after the owner exits or the lock becomes stale, but its leases and broader crash recovery remain local-development facilities rather than production coordination guarantees.
- `cancelAgentRun()` marks the saved state as `cancel_requested` by default. Pass `{ mode: "final" }` to write a terminal `cancelled` state.
- Active workers poll durable cancellation and abort the provider/tool `AbortSignal`. Cancellation cannot undo an external side effect that already completed, so tools must forward both `context.abortSignal` and `context.idempotencyKey`.
- Add `policy: { timeoutMs, onTimeout }` to `createAgent()` or `runAgent()` to enforce an SDK-level runtime timeout. The default timeout result is `timed_out`; `onTimeout: "cancel-requested"` writes `cancel_requested` instead. The timeout is propagated to providers through `AbortSignal`.
- Agent streams use bounded replay and subscriber queues with backpressure; overflow fails explicitly instead of silently dropping events. Durable state is bounded by `maxStateBytes` (4 MiB by default), and step request snapshots are incremental to avoid quadratic growth.
- Telemetry and memory hooks are best effort by default. Use `hookFailurePolicy.onError` to observe failures, or opt into `"fail"` for strict hook semantics.

## Agent Handoffs

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

## Native Subagents

Agents can also expose specialist agents as callable subagent tools. The parent run records child run summaries in `state.childRuns`, and replay/trace helpers include those child links without re-running the child agent. If a child pauses for approval, the parent exposes a `kind: "subagent"` request in its own `pendingApprovals`; resuming the parent continues the same child run and does not inject the child approval protocol into the parent model transcript.

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

## Subagent Production Controls

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

## Hierarchical Agent Traces

Use tree helpers when a persisted parent run needs to be exported with its descendants. These helpers are dry: they load saved state and never call models or tools.

```ts
import { createAgentRunTreeSnapshot, createHierarchicalAgentTrace } from "@zhivex-ai/sdk";

const tree = await createAgentRunTreeSnapshot(store, run.state.runId);
const trace = await createHierarchicalAgentTrace(store, run.state.runId, {
  includeMessages: false
});

console.log(tree?.totalRuns, trace?.root.children.length);
```

## Multi-Agent Evaluations

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

## Parallel Agent Groups

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

Set `maxConcurrency` to a positive safe integer to bound active members. The default remains unrestricted fan-out. A FIFO worker queue preserves input order in results. Aborted queued members are rejected before claiming a run or invoking the model; they can be retried later with the same stable identity. `stopOnError` aborts active members cooperatively and rejects queued entries with the fail-fast message. A rejected member contributes `failed` to the group status, including a cancellation exception; inspect member outputs for details.

With `stopOnError: false`, groups keep all-settled behavior and report every member result. With `stopOnError: true`, the first thrown error or member output with `status: "failed"` or `status: "timed_out"` aborts pending members cooperatively through `AbortSignal`; aborted members are returned as rejected outputs with a stable fail-fast error message.

A group `idempotencyKey` is namespaced by each member's stable `name` (or `agent.id`), so reordering members preserves their runs. Idempotent members must have unique nonempty identities. Explicit member keys override derivation; collisions in the same store and scope are rejected before execution. Persisted keys cannot be reassigned to a different member or agent. This changes keys used by older groups: do not replay an old shared group key expecting migration of previously conflated runs. Reconcile those runs explicitly first. The `agentGroupIdentity` metadata field is reserved by the runtime.

Group status follows this precedence: `failed` (including rejected members), `timed_out`, `cancel_requested`, `running`, `queued`, `waiting_approval` (legacy `suspended` is normalized), `cancelled`, `completed`. An empty group completes. Inspect every member result when terminal failures coexist with active work. Approval waits do not trigger `stopOnError`.

For agents with subagents, opt in to ordinary-tool overlap with `toolExecution: { parallel: true, independentOnly: true, maxConcurrency: 2 }`. Only tools explicitly declared `independent: true` may overlap, in contiguous batches; subagents and other tools are serial barriers. The application owns the independence assertion. Whole-batch approval/budget preflight still precedes execution, results retain call order, and active journal writes settle before failure is published. The default remains serial when subagents are configured.

Checkpoint persistence reuses the validated serialized snapshot. The size limit measures normalized compact JSON including the next revision; no checkpoints or CAS checks are removed. See [the offline measurements](../AGENTS_GATEWAY_BENCHMARK.md).

Use `handoff` for sequential ownership transfer, `subagents` for model-driven delegation inside an agent loop, and `runAgentGroup()` for deterministic fan-out from application code.

## Subagent Defaults

`prepareSubagentsForAgent()` returns a compatible agent definition where subagents inherit missing operational defaults from the parent, such as store, memory, telemetry, tool approvals, and tool execution settings. It does not mutate the original parent or child definitions.

```ts
import { prepareSubagentsForAgent } from "@zhivex-ai/sdk";

const productionCoordinator = prepareSubagentsForAgent(coordinator, {
  store,
  onTelemetryEvent: observer
});
```

## Agent Telemetry

Agents can now emit lifecycle telemetry without wrapping the underlying language model yourself. Attach `onTelemetryEvent` to an agent definition when you want hooks for run start/finish, step start/finish, approval requests, memory loads, state saves, handoffs, and subagent runs.

```ts
const agent = createAgent({
  model: openai("gpt-5"),
  onTelemetryEvent(event) {
    console.log(event.type);
  }
});
```

Provider MCP approvals, SDK-managed local-tool interrupts, and promoted subagent approvals move a run to `waiting_approval` instead of failing. Local tools opt in with `requiresApproval: true` plus `approvalMode: "interrupt"`; a tool policy can also return `{ approved: false, approvalRequired: true }`. Inspect `state.pendingApprovals` and continue with `resumeAgent()`. Persisted legacy states with `status: "suspended"` are still accepted for compatibility.

```ts
import { createAgent, resumeAgent, runAgent, tool } from "@zhivex-ai/sdk";
import { z } from "zod";

const deploymentAgent = createAgent({
  model,
  tools: {
    deploy: tool({
      name: "deploy",
      schema: z.object({ target: z.string() }),
      requiresApproval: true,
      approvalMode: "interrupt",
      approvalVersion: "2026-07-29",
      execute: async ({ target }, context) =>
        deploy(target, {
          signal: context?.abortSignal,
          idempotencyKey: context?.idempotencyKey
        })
    })
  }
});

const waiting = await runAgent(deploymentAgent, {
  prompt: "Deploy staging."
});

if (waiting.status === "waiting_approval") {
  const resumed = await resumeAgent(deploymentAgent, {
    state: waiting.state,
    approvals: waiting.state.pendingApprovals.map((approval) => ({
      provider: approval.provider,
      approvalRequestId: approval.id,
      approve: true
    }))
  });

  console.log(resumed.outputText);
}
```

The runtime preflights every tool call in a model-produced batch before any side effect. Local decisions are bound to the run, step, call id, tool name, canonical input digest, and `approvalVersion`, then revalidated on resume. Configure `toolApprovalSigner` when persisted approvals need application-authenticated signatures. Local approval records stay in durable agent state rather than being sent back to the model.

For OpenTelemetry-oriented setups, the SDK now also exposes explicit OTEL helpers:

- `createOtelObserver()`
- `createOtelAgentObserver()`
- `createOtelTelemetryMiddleware()`
- `createOtelWorkflowObserver()`

Those helpers are optional and do not add a required dependency to `@zhivex-ai/core`. Install `@opentelemetry/api` in your application if you want the SDK to create tracers for you automatically, or inject your own tracer-compatible object.

The helpers form a Stable, versioned GenAI adapter contract. They preserve workflow → agent → model/tool context, emit the recommended client/agent/tool/workflow histograms when a meter is available, end outstanding spans on terminal events, map failures to error status, apply conservative attribute filtering, and fail open if a tracer, meter, or exporter throws. The upstream Development mapping is pinned by `OTEL_GENAI_SEMCONV_REVISION`; content-bearing GenAI events remain disabled. See the [observability guide](../OBSERVABILITY.md) for lifecycle, metrics, and data-handling details.

```ts
import { createAgent, createOtelAgentObserver, createOtelTelemetryMiddleware, wrapLanguageModel } from "@zhivex-ai/sdk";

const otelAgentObserver = await createOtelAgentObserver();
const otelModelMiddleware = await createOtelTelemetryMiddleware();

const model = wrapLanguageModel(openai("gpt-5"), [otelModelMiddleware]);

const agent = createAgent({
  name: "Deployment Agent",
  model,
  onTelemetryEvent: otelAgentObserver
});
```

## Trace Artifacts And Cost Summaries

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
  includeToolInputs: false,
  includeToolOutputs: false,
  includeApprovalArguments: false,
  includeOutputText: false
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

Trace payloads are fail-closed by default: full messages, tool inputs, tool outputs, approval arguments, and full output text are omitted unless their corresponding `include*` option is enabled. `createProductionTraceCollector()` also redacts common credentials and email addresses from the remaining preview and metadata. Its in-memory retention defaults to at most 1,000 runs, 1,000 events per run, and 24 hours; customize `maxRuns`, `maxEventsPerRun`, and `retentionMs` when a tighter budget is required. Enable full payload flags only for an approved server-side destination.

See [Production Guide](../PRODUCTION.md#observability-export-path) and `examples/sdk/observability-export.ts` for a JSONL export pattern with redacted trace artifacts, tool-call audit records, and reproducible cost/latency summaries.

For SDK-defined local tools, attach a `toolApprovalPolicy` at the agent or request level. The policy can allow, finally deny, or request resumable human review:

```ts
const agent = createAgent({
  model: openai("gpt-5"),
  toolApprovalPolicy({ toolCall }) {
    if (toolCall.name === "shell") {
      return {
        approved: false,
        approvalRequired: true,
        reason: "Shell access requires review in this environment."
      };
    }

    return { approved: true };
  }
});
```

Local tools also support `isEnabled`, input/output guardrails, and `onError`. `contextSchema` parses and validates ephemeral application context before each run or resume; its transformed or defaulted value is available consistently to policies, guardrails, and tool execution. `outputSchema` validates the terminal result and exposes it as `result.finalOutput`; select `outputMode: "auto"`, `"native"`, or `"prompted"`. Prompted mode injects the generated JSON Schema into the model instructions and still validates the terminal JSON locally.

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

## Safety Policies

Tool argument validation is strict by default, including when `toolExecution.stopOnError` is false. To let a model correct schema-invalid arguments, use `toolExecution: { validationErrorMode: "tool-result" }` with an explicit `maxSteps` on `generateText`, `streamText`, or `Agent`. Each invalid call returns a paired `isError` result with `error.code: "TOOL_INPUT_VALIDATION_ERROR"` and `error.issues` containing only schema issue codes and string/number paths. Error messages and received values from the schema are omitted; the original tool call remains in conversation history.

Invalid calls never execute, invoke tool approval policies, or run tool error handlers. A corrected call follows normal validation, guardrails and approvals. `maxSteps` bounds correction turns; agent `policy.budget.maxToolErrors` and token budgets also count these attempts. `stopOnError: true` still stops on an error result. Hosted tools, guardrail failures, cancellation and unavailable tools retain their existing restrictions. Tools with an `isEnabled` predicate remain strict on invalid arguments because availability cannot safely be evaluated without validated input. In a mixed batch requiring interrupt approval, execution and validation-result delivery wait for resume; already resolved calls are not repeated.

Unknown tool names are strict by default, independently of schema recovery. A `ToolNotRegisteredError` (also a `ValidationError`) exposes `code: "TOOL_NOT_REGISTERED"`, a SHA-256 `toolNameHash`, accumulated invocation `usage`, and the failed response's `finishReason` / `providerFinishReason`. Missing usage remains undefined. Agent checkpoints the response and usage exactly once and pairs every call in the rejected batch with an error result before failing; registered calls in that batch receive `TOOL_BATCH_NOT_EXECUTED`. No calls in that batch are executed or approved, and resume does not replay them.

To allow corrections of unknown names, set `toolExecution: { unknownToolMode: "tool-result", stopOnError: false }` and an explicit `maxSteps`. This returns `TOOL_NOT_REGISTERED` results and uses the existing agent token and `maxToolErrors` budgets. Names must match the registry exactly; there is no alias guessing, argument repair, or bypass of disabled tools, hosted tools, guardrails or approval. Unknown calls never invoke approval or error handlers. Diagnostics omit arguments and raw unknown names; correlated tool results and the original conversation still retain the model-provided call IDs and names. Store conversation history according to your application's data policy.

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

## Agent Replay And Evaluation

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

