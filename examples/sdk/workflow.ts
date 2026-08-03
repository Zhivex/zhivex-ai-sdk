import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createAgent,
  createFileSessionService,
  createFileWorkflowStateService,
  createMockLanguageModel,
  createRunner,
  createTextMessage,
  createWorkflow,
  replayWorkflowRun,
  runWorkflow
} from "../../packages/sdk/src/index";

import { section } from "../_shared";

const root = await mkdtemp(path.join(os.tmpdir(), "zhivex-workflow-example-"));
const appName = "workflow-example";
const userId = "user_123";
const sessionId = "candidate_456";
const workflowKey = "candidate-review";
const sessionService = createFileSessionService({ directory: path.join(root, "sessions") });
const workflowStateService = createFileWorkflowStateService({
  directory: path.join(root, "workflow-states")
});
const model = createMockLanguageModel({
  responses: [
    {
      messages: [createTextMessage("assistant", "intake-ok")],
      text: "intake-ok",
      finishReason: "stop"
    },
    {
      messages: [createTextMessage("assistant", "review-ok")],
      text: "review-ok",
      finishReason: "stop"
    }
  ]
});
const runner = createRunner({
  appName,
  agent: createAgent({ id: "workflow-example-agent", model, maxSteps: 1 }),
  sessionService
});
const workflow = createWorkflow({
  id: workflowKey,
  persistence: {
    appName,
    sessionService,
    workflowStateService,
    workflowKey
  },
  steps: [
    {
      id: "intake",
      runner,
      prompt: "Validate the candidate input.",
      outputKey: "intake"
    },
    {
      id: "review",
      runner,
      prompt: ({ outputs }) => `Review the validated output: ${String(outputs.intake)}`,
      outputKey: "review"
    }
  ]
});

section("Run a deterministic workflow");
const result = await runWorkflow(workflow, { userId, sessionId });
assert.equal(result.status, "completed");
assert.deepEqual(result.outputs, { intake: "intake-ok", review: "review-ok" });
console.log({ status: result.status, outputs: result.outputs });

section("Reload durable state after recreating the service");
const reloaded = await createFileWorkflowStateService({
  directory: path.join(root, "workflow-states")
}).loadWorkflowState({ appName, userId, sessionId, workflowKey });
assert.equal(reloaded?.state.runId, result.state.runId);
assert.equal(reloaded?.status, "completed");
console.log({ runId: reloaded?.runId, revision: reloaded?.revision, status: reloaded?.status });

section("Replay without calling the model");
const replay = replayWorkflowRun(reloaded!.state);
assert.equal(replay.status, "completed");
assert.deepEqual(replay.outputs, result.outputs);
assert.equal(replay.timeline.filter((event) => event.type === "step-finish").length, 2);
console.log(replay.timeline.map((event) => event.type));
