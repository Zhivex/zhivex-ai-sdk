# Workflows Guide

Use workflows when the application already knows the order of work. Use agents when the model should decide which tools or subagents to call.

Zhivex workflows run on top of `Runner`, so each task step can reuse the same agent/session infrastructure used by chat or assistant flows.

## When To Use Workflows

Use workflows for:

- intake -> review -> approval -> publish flows
- deterministic fan-out and synthesis
- bounded improvement loops
- resumable human approval inside a known process
- regression-tested business processes

Use `Agent` or `runAgent()` directly when the task is open-ended and the model should choose the next action.

## Sequential Steps

```ts
import { Agent, createFileSessionService, createRunner, createWorkflow, runWorkflow } from "@zhivex-ai/sdk";

const agent = new Agent({
  model,
  instructions: "Be concise and operational."
});

const runner = createRunner({
  appName: "candidate-review",
  agent,
  sessionService: createFileSessionService({
    directory: ".zhivex/sessions"
  })
});

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
```

## Durable Workflow State

For production-style local state, use a dedicated `WorkflowStateService` instead of storing full workflow state under session metadata:

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
  steps
});

await runWorkflow(workflow, {
  userId: "user_123",
  sessionId: "candidate_456"
});

const persisted = await loadWorkflowState(workflow, {
  userId: "user_123",
  sessionId: "candidate_456"
});
```

Use Postgres or SQLite workflow state services when a deployment needs shared state across processes.

## Parallel Groups

Parallel groups run child steps concurrently and preserve result order:

```ts
const workflow = createWorkflow({
  steps: [
    {
      id: "research",
      kind: "parallel",
      failFast: false,
      steps: [
        { id: "market", runner, prompt: "Analyze market risk.", outputKey: "market" },
        { id: "legal", runner, prompt: "Analyze legal risk.", outputKey: "legal" }
      ]
    },
    {
      id: "synthesis",
      runner,
      prompt: ({ outputs }) => `Synthesize:\nMarket: ${outputs.market}\nLegal: ${outputs.legal}`
    }
  ]
});
```

Use `failFast: true` when downstream work should stop as soon as one branch fails.

## Bounded Loops

Loop steps are useful for deterministic retry or refinement:

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

Keep loops bounded. Agentic loops without limits are an operations risk.

## Approval Resume

If a workflow step pauses for approval, `runWorkflow()` returns `waiting_approval` with a serializable `state`. Resume by passing approval responses:

```ts
const waiting = await runWorkflow(workflow, input);

if (waiting.status === "waiting_approval") {
  const resumed = await runWorkflow(workflow, {
    ...input,
    state: waiting.state,
    approvals
  });
}
```

If `WorkflowStateService` is configured, you can also resume from persisted state:

```ts
await runWorkflow(workflow, {
  userId,
  sessionId,
  resumeFromPersistedState: true,
  approvals
});
```

## Replay And Evaluation

Replay inspects a saved workflow state without calling models or tools:

```ts
import { replayWorkflowRun } from "@zhivex-ai/sdk";

const replay = replayWorkflowRun(savedWorkflowState);
```

Use workflow evaluation fixtures for regression checks:

```ts
import {
  createWorkflowEvaluationFixture,
  createWorkflowEvaluationReport,
  runWorkflowEvaluationFixture
} from "@zhivex-ai/sdk";

const fixture = createWorkflowEvaluationFixture({
  name: "candidate-review",
  dataset: [
    {
      name: "happy-path",
      input: { userId: "user_123", sessionId: "candidate_456" },
      expectations: {
        status: "completed",
        outputContains: { review: "recommended" }
      }
    }
  ]
});

const evaluation = await runWorkflowEvaluationFixture(fixture, { workflow });
const report = createWorkflowEvaluationReport(evaluation);
```

## Operational Guidance

- Keep prompts and step IDs stable; they become part of replay and evaluation evidence.
- Persist workflow state outside session metadata for long-running processes.
- Store artifacts separately when outputs are large or binary.
- Prefer explicit workflows over agent autonomy for regulated business processes.
- Use agent subagents for model-directed delegation, not for fixed business control flow.
