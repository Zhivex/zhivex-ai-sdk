import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgent,
  createInMemorySessionService,
  createRunner,
  createTextMessage,
  createWorkflow,
  createWorkflowEvaluationFixture,
  createWorkflowEvaluationReport,
  evaluateWorkflowEvaluationGate,
  normalizeWorkflowEvaluationBaseline,
  runWorkflowEvaluationFixture,
  type LanguageModel,
  type StreamEvent
} from "../packages/core/src/index.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const baselinePath = resolve(
  scriptDirectory,
  "../packages/core/tests/fixtures/workflow-evaluation-ci-baseline-v1.json"
);
const baseline = normalizeWorkflowEvaluationBaseline(
  JSON.parse(readFileSync(baselinePath, "utf8"))
);

const model: LanguageModel = {
  provider: "workflow-evaluation-ci",
  modelId: "deterministic-baseline",
  capabilities: {
    streaming: true,
    tools: true,
    structuredOutput: true,
    jsonMode: true,
    toolChoice: true,
    parallelToolCalls: false,
    vision: false,
    files: false,
    audioInput: false,
    audioOutput: false,
    embeddings: false,
    reasoning: false,
    webSearch: false
  },
  async generate() {
    return {
      messages: [createTextMessage("assistant", "baseline-ok")],
      text: "baseline-ok",
      finishReason: "stop"
    };
  },
  async stream() {
    return (async function* (): AsyncGenerator<StreamEvent> {
      yield { type: "text-delta", textDelta: "baseline-ok" };
      yield { type: "finish", finishReason: "stop" };
    })();
  }
};

const runner = createRunner({
  appName: "workflow-evaluation-ci",
  agent: createAgent({ model, maxSteps: 2 }),
  sessionService: createInMemorySessionService()
});
const workflow = createWorkflow({
  id: "workflow-evaluation-ci",
  steps: [{ id: "answer", runner, prompt: "Return the baseline token.", outputKey: "answer" }]
});
const fixture = createWorkflowEvaluationFixture({
  name: "repository-workflow-evaluation",
  expectedOk: true,
  dataset: [{
    name: "deterministic-workflow",
    input: { userId: "ci-user", sessionId: "ci-session" },
    expectations: {
      status: "completed",
      outputs: { answer: "baseline-ok" },
      stepStatuses: { answer: "completed" }
    }
  }]
});

const result = await runWorkflowEvaluationFixture(fixture, { workflow });
const report = createWorkflowEvaluationReport(result);
const gate = evaluateWorkflowEvaluationGate(baseline, report);

assert.equal(gate.ok, true, JSON.stringify(gate.issues, null, 2));
console.log(JSON.stringify({
  type: "workflow_evaluation_ci_gate",
  baseline: baseline.name,
  ok: gate.ok,
  passRate: gate.candidate.passRate,
  regressions: gate.summary.regressedCases
}));
