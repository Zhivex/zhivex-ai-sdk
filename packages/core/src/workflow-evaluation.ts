import { generateText } from "./generate-text.js";
import { createTextMessage, serializeJsonValue } from "./messages.js";
import type { JsonValue, LanguageModel } from "./types.js";
import {
  replayWorkflowRun,
  runWorkflow,
  type WorkflowDefinition,
  type WorkflowReplayTimelineEvent,
  type WorkflowRunInput,
  type WorkflowRunOutput,
  type WorkflowStatus,
  type WorkflowStepResult,
  type WorkflowStepStatus
} from "./workflow.js";

export interface WorkflowEvaluationExpectations {
  status?: WorkflowStatus;
  outputs?: Record<string, JsonValue>;
  outputContains?: Record<string, string> | string[];
  stepStatuses?: Record<string, WorkflowStepStatus>;
  stepOutputContains?: Record<string, string>;
  errorContains?: string;
  timelineContains?: WorkflowReplayTimelineEvent["type"][];
}

export interface WorkflowEvaluationCase {
  name: string;
  input: WorkflowRunInput;
  expectations?: WorkflowEvaluationExpectations;
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowEvaluationCaseResult {
  name: string;
  ok: boolean;
  output: WorkflowRunOutput;
  failures: string[];
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowEvaluationResult {
  ok: boolean;
  cases: WorkflowEvaluationCaseResult[];
}

export interface WorkflowEvaluationJudgeResult {
  score: number;
  feedback?: string;
  metadata?: Record<string, JsonValue>;
}

export type WorkflowEvaluationJudge =
  | ((result: WorkflowEvaluationResult) => WorkflowEvaluationJudgeResult | Promise<WorkflowEvaluationJudgeResult>)
  | {
      model: LanguageModel;
      prompt?: string;
    };

export interface RunWorkflowEvaluationOptions {
  workflow:
    | WorkflowDefinition
    | ((testCase: WorkflowEvaluationCase) => WorkflowDefinition | Promise<WorkflowDefinition>);
}

export interface WorkflowEvaluationFixture {
  name?: string;
  dataset: WorkflowEvaluationCase[];
  expectedOk?: boolean;
  metadata?: Record<string, JsonValue>;
  createdAt?: number;
}

export interface WorkflowEvaluationReportCase {
  name: string;
  ok: boolean;
  status: WorkflowStatus;
  failures: string[];
  outputPreview: string;
  outputKeys: string[];
  stepCount: number;
  stepStatusCounts: Record<string, number>;
  timelineEventCounts: Record<string, number>;
  durationMs?: number;
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowEvaluationReport {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  statusCounts: Record<string, number>;
  stepCount: number;
  stepStatusCounts: Record<string, number>;
  timelineEventCounts: Record<string, number>;
  failures: Array<{ name: string; failures: string[] }>;
  cases: WorkflowEvaluationReportCase[];
  judge?: WorkflowEvaluationJudgeResult;
  metadata?: Record<string, JsonValue>;
}

const preview = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, Math.max(0, length))}...` : text;

const flattenStepResults = (steps: WorkflowStepResult[]): WorkflowStepResult[] =>
  steps.flatMap((step) => [step, ...flattenStepResults(step.children ?? [])]);

const createStepMap = (steps: WorkflowStepResult[]): Map<string, WorkflowStepResult[]> => {
  const map = new Map<string, WorkflowStepResult[]>();
  for (const step of flattenStepResults(steps)) {
    map.set(step.id, [...(map.get(step.id) ?? []), step]);
  }
  return map;
};

const getLatestStep = (
  stepMap: Map<string, WorkflowStepResult[]>,
  stepId: string
): WorkflowStepResult | undefined => stepMap.get(stepId)?.at(-1);

const valueEquals = (left: JsonValue, right: JsonValue): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const evaluateExpectations = (
  output: WorkflowRunOutput,
  expectations: WorkflowEvaluationExpectations | undefined
): string[] => {
  const failures: string[] = [];
  if (!expectations) {
    return failures;
  }

  if (expectations.status && output.status !== expectations.status) {
    failures.push(`Expected status "${expectations.status}", received "${output.status}".`);
  }

  if (expectations.outputs) {
    for (const [key, expected] of Object.entries(expectations.outputs)) {
      if (!(key in output.outputs)) {
        failures.push(`Expected output key "${key}".`);
        continue;
      }
      if (!valueEquals(output.outputs[key]!, expected)) {
        failures.push(`Expected output "${key}" to equal ${JSON.stringify(expected)}.`);
      }
    }
  }

  if (Array.isArray(expectations.outputContains)) {
    const serializedOutputs = JSON.stringify(output.outputs);
    for (const expectedText of expectations.outputContains) {
      if (!serializedOutputs.includes(expectedText)) {
        failures.push(`Expected serialized outputs to contain "${expectedText}".`);
      }
    }
  } else if (expectations.outputContains) {
    for (const [key, expectedText] of Object.entries(expectations.outputContains)) {
      const value = output.outputs[key];
      if (value === undefined || !String(value).includes(expectedText)) {
        failures.push(`Expected output "${key}" to contain "${expectedText}".`);
      }
    }
  }

  const stepMap = createStepMap(output.steps);
  if (expectations.stepStatuses) {
    for (const [stepId, expectedStatus] of Object.entries(expectations.stepStatuses)) {
      const step = getLatestStep(stepMap, stepId);
      if (!step) {
        failures.push(`Expected step "${stepId}".`);
        continue;
      }
      if (step.status !== expectedStatus) {
        failures.push(`Expected step "${stepId}" status "${expectedStatus}", received "${step.status}".`);
      }
    }
  }

  if (expectations.stepOutputContains) {
    for (const [stepId, expectedText] of Object.entries(expectations.stepOutputContains)) {
      const step = getLatestStep(stepMap, stepId);
      if (!step?.outputText?.includes(expectedText)) {
        failures.push(`Expected step "${stepId}" output to contain "${expectedText}".`);
      }
    }
  }

  if (expectations.errorContains) {
    const errors = flattenStepResults(output.steps).flatMap((step) => step.error?.message ? [step.error.message] : []);
    if (!errors.some((message) => message.includes(expectations.errorContains!))) {
      failures.push(`Expected workflow error to contain "${expectations.errorContains}".`);
    }
  }

  if (expectations.timelineContains?.length) {
    const replay = replayWorkflowRun(output.state);
    const eventTypes = new Set(replay.timeline.map((event) => event.type));
    for (const eventType of expectations.timelineContains) {
      if (!eventTypes.has(eventType)) {
        failures.push(`Expected replay timeline event "${eventType}".`);
      }
    }
  }

  return failures;
};

export const runWorkflowEvaluation = async (
  dataset: WorkflowEvaluationCase[],
  options: RunWorkflowEvaluationOptions
): Promise<WorkflowEvaluationResult> => {
  const cases: WorkflowEvaluationCaseResult[] = [];

  for (const testCase of dataset) {
    const workflow = typeof options.workflow === "function" ? await options.workflow(testCase) : options.workflow;
    const output = await runWorkflow(workflow, testCase.input);
    const failures = evaluateExpectations(output, testCase.expectations);
    cases.push({
      name: testCase.name,
      ok: failures.length === 0,
      output,
      failures,
      metadata: testCase.metadata
    });
  }

  return {
    ok: cases.every((testCase) => testCase.ok),
    cases
  };
};

export const createWorkflowEvaluationFixture = (options: {
  name?: string;
  dataset: WorkflowEvaluationCase[];
  expectedOk?: boolean;
  metadata?: Record<string, JsonValue>;
  createdAt?: number;
}): WorkflowEvaluationFixture => ({
  name: options.name,
  dataset: serializeJsonValue(options.dataset) as unknown as WorkflowEvaluationCase[],
  expectedOk: options.expectedOk,
  metadata: options.metadata,
  createdAt: options.createdAt ?? Date.now()
});

export const runWorkflowEvaluationFixture = async (
  fixture: WorkflowEvaluationFixture,
  options: RunWorkflowEvaluationOptions
): Promise<WorkflowEvaluationResult> => runWorkflowEvaluation(fixture.dataset, options);

const workflowDuration = (output: WorkflowRunOutput): number | undefined =>
  output.state.createdAt !== undefined && output.state.updatedAt !== undefined
    ? Math.max(0, output.state.updatedAt - output.state.createdAt)
    : undefined;

const incrementCounts = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export const createWorkflowEvaluationReport = (
  result: WorkflowEvaluationResult,
  options: {
    judge?: WorkflowEvaluationJudgeResult;
    metadata?: Record<string, JsonValue>;
    outputPreviewLength?: number;
  } = {}
): WorkflowEvaluationReport => {
  const outputPreviewLength = options.outputPreviewLength ?? 500;
  const cases = result.cases.map((testCase): WorkflowEvaluationReportCase => {
    const steps = flattenStepResults(testCase.output.steps);
    const stepStatusCounts: Record<string, number> = {};
    const timelineEventCounts: Record<string, number> = {};
    const replay = replayWorkflowRun(testCase.output.state);
    for (const step of steps) {
      incrementCounts(stepStatusCounts, step.status);
    }
    for (const event of replay.timeline) {
      incrementCounts(timelineEventCounts, event.type);
    }

    return {
      name: testCase.name,
      ok: testCase.ok,
      status: testCase.output.status,
      failures: [...testCase.failures],
      outputPreview: preview(JSON.stringify(testCase.output.outputs), outputPreviewLength),
      outputKeys: Object.keys(testCase.output.outputs),
      stepCount: steps.length,
      stepStatusCounts,
      timelineEventCounts,
      durationMs: workflowDuration(testCase.output),
      metadata: testCase.metadata
    };
  });
  const statusCounts: Record<string, number> = {};
  const stepStatusCounts: Record<string, number> = {};
  const timelineEventCounts: Record<string, number> = {};
  for (const testCase of cases) {
    incrementCounts(statusCounts, testCase.status);
    for (const [status, count] of Object.entries(testCase.stepStatusCounts)) {
      stepStatusCounts[status] = (stepStatusCounts[status] ?? 0) + count;
    }
    for (const [eventType, count] of Object.entries(testCase.timelineEventCounts)) {
      timelineEventCounts[eventType] = (timelineEventCounts[eventType] ?? 0) + count;
    }
  }
  const passed = cases.filter((testCase) => testCase.ok).length;
  const failed = cases.length - passed;

  return {
    ok: result.ok,
    total: cases.length,
    passed,
    failed,
    passRate: cases.length ? passed / cases.length : 1,
    statusCounts,
    stepCount: cases.reduce((total, testCase) => total + testCase.stepCount, 0),
    stepStatusCounts,
    timelineEventCounts,
    failures: cases.filter((testCase) => testCase.failures.length).map((testCase) => ({
      name: testCase.name,
      failures: testCase.failures
    })),
    cases,
    judge: options.judge,
    metadata: options.metadata
  };
};

const parseJudgeResponse = (text: string): WorkflowEvaluationJudgeResult => {
  try {
    const parsed = JSON.parse(text) as Partial<WorkflowEvaluationJudgeResult>;
    return {
      score: typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : 0,
      feedback: parsed.feedback
    };
  } catch {
    return {
      score: 0,
      feedback: text
    };
  }
};

export const judgeWorkflowEvaluation = async (
  result: WorkflowEvaluationResult,
  judge: WorkflowEvaluationJudge
): Promise<WorkflowEvaluationJudgeResult> => {
  if (typeof judge === "function") {
    return judge(result);
  }

  const prompt =
    judge.prompt ??
    "Score this workflow evaluation from 0 to 1. Return JSON with fields score and feedback.";
  const response = await generateText({
    model: judge.model,
    messages: [
      createTextMessage("user", `${prompt}\n\n${JSON.stringify(serializeJsonValue(result), null, 2)}`)
    ]
  });

  return parseJudgeResponse(response.text);
};
