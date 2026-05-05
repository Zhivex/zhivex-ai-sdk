import type { z, ZodTypeAny } from "zod";

import { runAgent } from "./agent.js";
import { generateText } from "./generate-text.js";
import { createTextMessage, serializeJsonValue } from "./messages.js";
import type {
  AgentDefinition,
  AgentRunInput,
  AgentRunOutput,
  AgentRunState,
  AgentStatus,
  AgentStep,
  FinishReason,
  GenerateResult,
  JsonValue,
  LanguageModel,
  ModelGenerateInput,
  ModelMessage,
  StreamEvent,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult
} from "./types.js";

export interface AgentRunSnapshot {
  runId: string;
  agentId?: string;
  status: AgentStatus;
  provider: string;
  modelId: string;
  steps: number;
  toolCalls: ToolCall[];
  childRuns: AgentRunState["childRuns"];
  usage?: AgentRunState["usage"];
  outputText: string;
  error?: AgentRunState["error"];
  pendingApprovals: AgentRunState["pendingApprovals"];
}

export type AgentReplayTimelineEvent =
  | {
      type: "run-start";
      runId: string;
      agentId?: string;
      provider: string;
      modelId: string;
      startedAt?: number;
    }
  | {
      type: "step-start";
      step: number;
      status: AgentStep["status"];
      startedAt?: number;
    }
  | {
      type: "tool-call";
      step: number;
      toolCall: ToolCall;
    }
  | {
      type: "tool-result";
      step: number;
      result: ToolExecutionResult;
    }
  | {
      type: "approval-request";
      approval: AgentRunState["pendingApprovals"][number];
    }
  | {
      type: "subagent-run";
      childRun: NonNullable<AgentRunState["childRuns"]>[number];
    }
  | {
      type: "step-finish";
      step: number;
      status: AgentStep["status"];
      finishedAt?: number;
      error?: AgentStep["error"];
    }
  | {
      type: "run-finish";
      status: AgentStatus;
      outputText: string;
      finishedAt?: number;
      error?: AgentRunState["error"];
      cancellationReason?: string;
    };

export interface AgentReplayResult {
  snapshot: AgentRunSnapshot;
  timeline: AgentReplayTimelineEvent[];
}

export interface MockLanguageModelOptions {
  provider?: string;
  modelId?: string;
  capabilities?: Partial<LanguageModel["capabilities"]>;
  responses?: GenerateResult[];
  streamEvents?: StreamEvent[][];
}

export interface MockToolOptions<TResult = JsonValue> {
  outputs?: TResult[];
  errors?: Array<string | Error>;
}

export interface AgentEvaluationExpectations {
  status?: AgentStatus;
  outputContains?: string;
  outputEquals?: string;
  toolCalls?: string[];
  childRunCount?: number;
  childAgents?: string[];
  childStatuses?: AgentStatus[];
  childOutputContains?: string[];
  childToolNames?: string[];
  finishReason?: FinishReason;
  errorContains?: string;
}

export interface AgentEvaluationCase {
  name: string;
  input: AgentRunInput;
  expectations?: AgentEvaluationExpectations;
  metadata?: Record<string, JsonValue>;
}

export interface AgentEvaluationCaseResult {
  name: string;
  ok: boolean;
  output: AgentRunOutput;
  failures: string[];
  metadata?: Record<string, JsonValue>;
}

export interface AgentEvaluationResult {
  ok: boolean;
  cases: AgentEvaluationCaseResult[];
}

export interface AgentEvaluationJudgeResult {
  score: number;
  feedback?: string;
  metadata?: Record<string, JsonValue>;
}

export type AgentEvaluationJudge =
  | ((result: AgentEvaluationResult) => AgentEvaluationJudgeResult | Promise<AgentEvaluationJudgeResult>)
  | {
      model: LanguageModel;
      prompt?: string;
    };

export interface RunAgentEvaluationOptions {
  agent: AgentDefinition | ((testCase: AgentEvaluationCase) => AgentDefinition | Promise<AgentDefinition>);
}

export interface AgentEvaluationFixture {
  name?: string;
  dataset: AgentEvaluationCase[];
  expectedOk?: boolean;
  metadata?: Record<string, JsonValue>;
  createdAt?: number;
}

export interface AgentEvaluationReportCase {
  name: string;
  ok: boolean;
  status: AgentStatus;
  failures: string[];
  outputPreview: string;
  toolCalls: string[];
  toolCallCount: number;
  childRunCount: number;
  childAgents: string[];
  childStatuses: AgentStatus[];
  durationMs?: number;
  error?: AgentRunOutput["error"];
  metadata?: Record<string, JsonValue>;
}

export interface AgentEvaluationReport {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  statusCounts: Record<string, number>;
  toolCallCounts: Record<string, number>;
  childRunCount: number;
  childAgentCounts: Record<string, number>;
  childStatusCounts: Record<string, number>;
  failures: Array<{ name: string; failures: string[] }>;
  cases: AgentEvaluationReportCase[];
  judge?: AgentEvaluationJudgeResult;
  metadata?: Record<string, JsonValue>;
}

const defaultCapabilities: LanguageModel["capabilities"] = {
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
};

const getToolCallsFromMessages = (messages: ModelMessage[]): ToolCall[] =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "tool-call" ? [part.toolCall] : []))
  );

const stepToolCalls = (step: AgentStep): ToolCall[] => getToolCallsFromMessages(step.response?.messages ?? []);

export const createAgentRunSnapshot = (state: AgentRunState): AgentRunSnapshot => ({
  runId: state.runId,
  agentId: state.agentId,
  status: state.status,
  provider: state.provider,
  modelId: state.modelId,
  steps: state.steps.length,
  toolCalls: state.steps.flatMap(stepToolCalls),
  childRuns: state.childRuns ?? [],
  usage: state.usage,
  outputText: state.outputText,
  error: state.error,
  pendingApprovals: state.pendingApprovals
});

export const replayAgentRun = (state: AgentRunState): AgentReplayResult => {
  const timeline: AgentReplayTimelineEvent[] = [
    {
      type: "run-start",
      runId: state.runId,
      agentId: state.agentId,
      provider: state.provider,
      modelId: state.modelId,
      startedAt: state.startedAt
    }
  ];

  for (const step of state.steps) {
    timeline.push({
      type: "step-start",
      step: step.index,
      status: step.status,
      startedAt: step.startedAt
    });

    for (const toolCall of stepToolCalls(step)) {
      timeline.push({
        type: "tool-call",
        step: step.index,
        toolCall
      });
    }

    for (const result of step.toolResults) {
      timeline.push({
        type: "tool-result",
        step: step.index,
        result
      });
    }

    timeline.push({
      type: "step-finish",
      step: step.index,
      status: step.status,
      finishedAt: step.finishedAt,
      error: step.error
    });
  }

  for (const approval of state.pendingApprovals) {
    timeline.push({
      type: "approval-request",
      approval
    });
  }

  for (const childRun of state.childRuns ?? []) {
    timeline.push({
      type: "subagent-run",
      childRun
    });
  }

  timeline.push({
    type: "run-finish",
    status: state.status,
    outputText: state.outputText,
    finishedAt: state.updatedAt,
    error: state.error,
    cancellationReason: state.cancellationReason
  });

  return {
    snapshot: createAgentRunSnapshot(state),
    timeline
  };
};

export const createMockLanguageModel = (options: MockLanguageModelOptions = {}): LanguageModel => {
  const responses = [...(options.responses ?? [])];
  const streamEvents = [...(options.streamEvents ?? [])];

  return {
    provider: options.provider ?? "mock",
    modelId: options.modelId ?? "mock-model",
    capabilities: {
      ...defaultCapabilities,
      ...(options.capabilities ?? {})
    },
    async generate(_input: ModelGenerateInput): Promise<GenerateResult> {
      const response = responses.shift();
      if (!response) {
        throw new Error("Mock language model has no remaining generate responses.");
      }
      return response;
    },
    async stream(_input: ModelGenerateInput): Promise<AsyncIterable<StreamEvent>> {
      const events = streamEvents.shift();
      if (!events) {
        throw new Error("Mock language model has no remaining stream event sequences.");
      }

      return (async function* () {
        for (const event of events) {
          yield event;
        }
      })();
    }
  };
};

export const createMockTool = <TSchema extends ZodTypeAny, TResult = JsonValue>(
  definition: Omit<ToolDefinition<TSchema, TResult>, "execute"> & {
    execute?: ToolDefinition<TSchema, TResult>["execute"];
  },
  options: MockToolOptions<TResult> = {}
): ToolDefinition<TSchema, TResult> => {
  const outputs = [...(options.outputs ?? [])];
  const errors = [...(options.errors ?? [])];

  return {
    ...definition,
    execute: async (input: z.infer<TSchema>) => {
      const error = errors.shift();
      if (error) {
        throw typeof error === "string" ? new Error(error) : error;
      }

      if (outputs.length) {
        return outputs.shift() as TResult;
      }

      if (definition.execute) {
        return definition.execute(input);
      }

      throw new Error(`Mock tool "${definition.name}" has no remaining outputs.`);
    }
  };
};

const evaluateExpectations = (
  output: AgentRunOutput,
  expectations: AgentEvaluationExpectations | undefined
): string[] => {
  const failures: string[] = [];
  if (!expectations) {
    return failures;
  }

  if (expectations.status && output.status !== expectations.status) {
    failures.push(`Expected status "${expectations.status}", received "${output.status}".`);
  }
  if (expectations.outputEquals !== undefined && output.outputText !== expectations.outputEquals) {
    failures.push(`Expected output to equal "${expectations.outputEquals}".`);
  }
  if (expectations.outputContains !== undefined && !output.outputText.includes(expectations.outputContains)) {
    failures.push(`Expected output to contain "${expectations.outputContains}".`);
  }
  if (expectations.finishReason && output.finishReason !== expectations.finishReason) {
    failures.push(`Expected finishReason "${expectations.finishReason}", received "${output.finishReason ?? "undefined"}".`);
  }
  if (expectations.errorContains !== undefined && !output.error?.message.includes(expectations.errorContains)) {
    failures.push(`Expected error to contain "${expectations.errorContains}".`);
  }
  if (expectations.toolCalls?.length) {
    const toolNames = new Set(output.steps.flatMap((step) => stepToolCalls(step).map((call) => call.name)));
    for (const toolName of expectations.toolCalls) {
      if (!toolNames.has(toolName)) {
        failures.push(`Expected tool call "${toolName}".`);
      }
    }
  }
  const childRuns = output.state.childRuns ?? [];
  if (expectations.childRunCount !== undefined && childRuns.length !== expectations.childRunCount) {
    failures.push(`Expected ${expectations.childRunCount} child runs, received ${childRuns.length}.`);
  }
  if (expectations.childAgents?.length) {
    const childAgents = new Set(childRuns.flatMap((childRun) => childRun.agentId ? [childRun.agentId] : []));
    for (const agentId of expectations.childAgents) {
      if (!childAgents.has(agentId)) {
        failures.push(`Expected child agent "${agentId}".`);
      }
    }
  }
  if (expectations.childStatuses?.length) {
    const childStatuses = new Set(childRuns.map((childRun) => childRun.status));
    for (const status of expectations.childStatuses) {
      if (!childStatuses.has(status)) {
        failures.push(`Expected child status "${status}".`);
      }
    }
  }
  if (expectations.childOutputContains?.length) {
    for (const expectedText of expectations.childOutputContains) {
      if (!childRuns.some((childRun) => childRun.outputText.includes(expectedText))) {
        failures.push(`Expected child output to contain "${expectedText}".`);
      }
    }
  }
  if (expectations.childToolNames?.length) {
    const childToolNames = new Set(childRuns.flatMap((childRun) => childRun.toolName ? [childRun.toolName] : []));
    for (const toolName of expectations.childToolNames) {
      if (!childToolNames.has(toolName)) {
        failures.push(`Expected child tool "${toolName}".`);
      }
    }
  }

  return failures;
};

export const runAgentEvaluation = async (
  dataset: AgentEvaluationCase[],
  options: RunAgentEvaluationOptions
): Promise<AgentEvaluationResult> => {
  const cases: AgentEvaluationCaseResult[] = [];

  for (const testCase of dataset) {
    const agent = typeof options.agent === "function" ? await options.agent(testCase) : options.agent;
    const output = await runAgent(agent, testCase.input);
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

export const createAgentEvaluationFixture = (options: {
  name?: string;
  dataset: AgentEvaluationCase[];
  expectedOk?: boolean;
  metadata?: Record<string, JsonValue>;
  createdAt?: number;
}): AgentEvaluationFixture => ({
  name: options.name,
  dataset: serializeJsonValue(options.dataset) as unknown as AgentEvaluationCase[],
  expectedOk: options.expectedOk,
  metadata: options.metadata,
  createdAt: options.createdAt ?? Date.now()
});

export const runAgentEvaluationFixture = async (
  fixture: AgentEvaluationFixture,
  options: RunAgentEvaluationOptions
): Promise<AgentEvaluationResult> => runAgentEvaluation(fixture.dataset, options);

const outputDuration = (output: AgentRunOutput): number | undefined =>
  output.state.startedAt !== undefined && output.state.updatedAt !== undefined
    ? Math.max(0, output.state.updatedAt - output.state.startedAt)
    : undefined;

const preview = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, Math.max(0, length))}...` : text;

export const createAgentEvaluationReport = (
  result: AgentEvaluationResult,
  options: {
    judge?: AgentEvaluationJudgeResult;
    metadata?: Record<string, JsonValue>;
    outputPreviewLength?: number;
  } = {}
): AgentEvaluationReport => {
  const outputPreviewLength = options.outputPreviewLength ?? 500;
  const cases = result.cases.map((testCase): AgentEvaluationReportCase => {
    const toolCalls = testCase.output.steps.flatMap((step) => stepToolCalls(step).map((call) => call.name));
    const childRuns = testCase.output.state.childRuns ?? [];
    return {
      name: testCase.name,
      ok: testCase.ok,
      status: testCase.output.status,
      failures: [...testCase.failures],
      outputPreview: preview(testCase.output.outputText, outputPreviewLength),
      toolCalls,
      toolCallCount: toolCalls.length,
      childRunCount: childRuns.length,
      childAgents: childRuns.flatMap((childRun) => childRun.agentId ? [childRun.agentId] : []),
      childStatuses: childRuns.map((childRun) => childRun.status),
      durationMs: outputDuration(testCase.output),
      error: testCase.output.error,
      metadata: testCase.metadata
    };
  });
  const statusCounts: Record<string, number> = {};
  const toolCallCounts: Record<string, number> = {};
  const childAgentCounts: Record<string, number> = {};
  const childStatusCounts: Record<string, number> = {};
  for (const testCase of cases) {
    statusCounts[testCase.status] = (statusCounts[testCase.status] ?? 0) + 1;
    for (const toolName of testCase.toolCalls) {
      toolCallCounts[toolName] = (toolCallCounts[toolName] ?? 0) + 1;
    }
    for (const agentId of testCase.childAgents) {
      childAgentCounts[agentId] = (childAgentCounts[agentId] ?? 0) + 1;
    }
    for (const status of testCase.childStatuses) {
      childStatusCounts[status] = (childStatusCounts[status] ?? 0) + 1;
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
    toolCallCounts,
    childRunCount: cases.reduce((total, testCase) => total + testCase.childRunCount, 0),
    childAgentCounts,
    childStatusCounts,
    failures: cases.filter((testCase) => testCase.failures.length).map((testCase) => ({
      name: testCase.name,
      failures: testCase.failures
    })),
    cases,
    judge: options.judge,
    metadata: options.metadata
  };
};

const parseJudgeResponse = (text: string): AgentEvaluationJudgeResult => {
  try {
    const parsed = JSON.parse(text) as Partial<AgentEvaluationJudgeResult>;
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

export const judgeAgentEvaluation = async (
  result: AgentEvaluationResult,
  judge: AgentEvaluationJudge
): Promise<AgentEvaluationJudgeResult> => {
  if (typeof judge === "function") {
    return judge(result);
  }

  const prompt =
    judge.prompt ??
    "Score this agent evaluation from 0 to 1. Return JSON with fields score and feedback.";
  const response = await generateText({
    model: judge.model,
    messages: [
      createTextMessage("user", `${prompt}\n\n${JSON.stringify(serializeJsonValue(result), null, 2)}`)
    ]
  });

  return parseJudgeResponse(response.text);
};
