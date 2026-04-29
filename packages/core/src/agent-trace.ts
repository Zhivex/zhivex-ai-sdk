import type { ModelCatalog } from "./catalog.js";
import { replayAgentRun } from "./agent-evaluation.js";
import type {
  AgentRunState,
  AgentStatus,
  AgentStep,
  AgentTelemetryEvent,
  AgentTelemetryObserver,
  JsonValue,
  ModelMessage,
  TokenUsage,
  ToolCall,
  ToolExecutionResult
} from "./types.js";

export interface TokenPricing {
  inputCostPer1kTokens?: number;
  outputCostPer1kTokens?: number;
  totalCostPer1kTokens?: number;
  costPer1kTokens?: number;
  currency?: string;
}

export interface CostEstimate {
  inputCost?: number;
  outputCost?: number;
  totalCost?: number;
  currency?: string;
  usage?: TokenUsage;
}

export interface LatencySummary {
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AgentTraceToolCall {
  id: string;
  name: string;
  input?: JsonValue;
}

export interface AgentTraceStep {
  index: number;
  status: AgentStep["status"];
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  toolCalls: AgentTraceToolCall[];
  toolResults: ToolExecutionResult[];
  usage?: TokenUsage;
  messages?: ModelMessage[];
  error?: AgentStep["error"];
}

export interface AgentTraceEvent {
  type: string;
  runId: string;
  agentId?: string;
  timestamp?: number;
  step?: number;
  status?: string;
  name?: string;
  data?: JsonValue;
}

export interface AgentTraceArtifact {
  runId: string;
  agentId?: string;
  provider: string;
  modelId: string;
  status: AgentStatus;
  startedAt?: number;
  updatedAt?: number;
  durationMs?: number;
  steps: AgentTraceStep[];
  events: AgentTraceEvent[];
  approvals: AgentRunState["pendingApprovals"];
  usage?: TokenUsage;
  outputText?: string;
  outputPreview: string;
  error?: AgentRunState["error"];
  cancellationReason?: string;
}

export interface AgentTraceOptions {
  includeMessages?: boolean;
  includeToolInputs?: boolean;
  outputPreviewLength?: number;
}

export interface AgentTraceSummary {
  runId: string;
  agentId?: string;
  provider: string;
  modelId: string;
  status: AgentStatus;
  latency: LatencySummary;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  approvals: number;
  usage?: TokenUsage;
  cost?: CostEstimate;
  error?: AgentRunState["error"];
  cancellationReason?: string;
}

export interface AgentTraceCollector {
  observer: AgentTelemetryObserver;
  getTrace(runId?: string): AgentTraceArtifact | undefined;
  getEvents(runId?: string): AgentTraceEvent[];
  reset(runId?: string): void;
}

export type AgentRunCostPricing = TokenPricing | ModelCatalog;

const isCatalog = (pricing: AgentRunCostPricing | undefined): pricing is ModelCatalog =>
  Boolean(pricing && "find" in pricing && typeof pricing.find === "function");

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const toJsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

const duration = (startedAt?: number, finishedAt?: number): number | undefined =>
  startedAt !== undefined && finishedAt !== undefined ? Math.max(0, finishedAt - startedAt) : undefined;

const preview = (text: string, length = 500): string =>
  text.length > length ? `${text.slice(0, Math.max(0, length))}...` : text;

const toTraceToolCall = (toolCall: ToolCall, includeInput: boolean): AgentTraceToolCall => ({
  id: toolCall.id,
  name: toolCall.name,
  ...(includeInput ? { input: cloneJson(toolCall.input) } : {})
});

const getToolCallsFromMessages = (messages: ModelMessage[], includeInput: boolean): AgentTraceToolCall[] =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "tool-call" ? [toTraceToolCall(part.toolCall, includeInput)] : []
    )
  );

const stepUsage = (step: AgentStep): TokenUsage | undefined => step.response?.usage;

const normalizeUsage = (usage: TokenUsage | undefined): TokenUsage | undefined =>
  usage && Object.values(usage).some((value) => value !== undefined) ? { ...usage } : undefined;

const serializeEventData = (event: AgentTelemetryEvent): JsonValue | undefined => {
  if (event.type === "run-start") {
    return { provider: event.provider, modelId: event.modelId, maxSteps: event.maxSteps };
  }
  if (event.type === "step-start") {
    return { stepIndex: event.stepIndex };
  }
  if (event.type === "step-finish") {
    return { status: event.step.status, toolResults: event.step.toolResults.length };
  }
  if (event.type === "approval-request") {
    return toJsonValue(event.approval);
  }
  if (event.type === "approval-resolved") {
    return toJsonValue(event.approval);
  }
  if (event.type === "tool-approval") {
    return toJsonValue({
      toolCall: event.toolCall,
      approved: event.approved,
      reason: event.reason,
      metadata: event.metadata
    });
  }
  if (event.type === "memory-loaded") {
    return { messageCount: event.messageCount };
  }
  if (event.type === "guardrail-triggered") {
    return toJsonValue({ stage: event.stage, reason: event.reason, metadata: event.metadata });
  }
  if (event.type === "state-saved") {
    return { status: event.status };
  }
  if (event.type === "handoff") {
    return toJsonValue(event.handoff);
  }
  if (event.type === "run-finish") {
    return { status: event.status, currentStep: event.state.currentStep };
  }
  return undefined;
};

const toTraceEvent = (event: AgentTelemetryEvent): AgentTraceEvent => ({
  type: event.type,
  runId: event.runId,
  agentId: event.agentId,
  timestamp: Date.now(),
  step:
    event.type === "step-start"
      ? event.stepIndex
      : event.type === "step-finish"
        ? event.step.index
        : undefined,
  status:
    event.type === "run-finish" || event.type === "state-saved"
      ? event.status
      : event.type === "step-finish"
        ? event.step.status
        : undefined,
  name:
    event.type === "approval-request"
      ? event.approval.name
      : event.type === "tool-approval"
        ? event.toolCall.name
        : undefined,
  data: serializeEventData(event)
});

const replayEvents = (state: AgentRunState): AgentTraceEvent[] =>
  replayAgentRun(state).timeline.map((event) => ({
    type: event.type,
    runId: state.runId,
    agentId: state.agentId,
    timestamp:
      event.type === "run-start"
        ? event.startedAt
        : event.type === "step-start"
          ? event.startedAt
          : event.type === "step-finish"
            ? event.finishedAt
            : event.type === "run-finish"
              ? event.finishedAt
              : undefined,
    step: "step" in event ? event.step : undefined,
    status: "status" in event ? event.status : undefined,
    name:
      event.type === "tool-call"
        ? event.toolCall.name
        : event.type === "tool-result"
          ? event.result.toolName
          : event.type === "approval-request"
            ? event.approval.name
            : undefined,
    data: cloneJson(event as unknown as JsonValue)
  }));

const stateToTrace = (
  state: AgentRunState,
  options: AgentTraceOptions = {},
  events = replayEvents(state)
): AgentTraceArtifact => {
  const includeMessages = options.includeMessages ?? false;
  const includeToolInputs = options.includeToolInputs ?? false;

  return {
    runId: state.runId,
    agentId: state.agentId,
    provider: state.provider,
    modelId: state.modelId,
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    durationMs: duration(state.startedAt, state.updatedAt),
    steps: state.steps.map((step) => ({
      index: step.index,
      status: step.status,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      durationMs: duration(step.startedAt, step.finishedAt),
      toolCalls: getToolCallsFromMessages(step.response?.messages ?? [], includeToolInputs),
      toolResults: cloneJson(step.toolResults),
      usage: normalizeUsage(stepUsage(step)),
      ...(includeMessages ? { messages: cloneJson(step.response?.messages ?? []) } : {}),
      error: step.error
    })),
    events: cloneJson(events),
    approvals: cloneJson(state.pendingApprovals),
    usage: normalizeUsage(state.usage),
    outputText: options.outputPreviewLength === 0 ? undefined : state.outputText,
    outputPreview: preview(state.outputText, options.outputPreviewLength),
    error: state.error,
    cancellationReason: state.cancellationReason
  };
};

export const createAgentTraceArtifact = (
  state: AgentRunState,
  options: AgentTraceOptions = {}
): AgentTraceArtifact => stateToTrace(state, options);

export const estimateTokenCost = (
  usage: TokenUsage | undefined,
  pricing?: TokenPricing
): CostEstimate => {
  const normalizedUsage = normalizeUsage(usage);
  if (!normalizedUsage || !pricing) {
    return {
      currency: pricing?.currency,
      usage: normalizedUsage
    };
  }

  const inputRate = pricing.inputCostPer1kTokens ?? pricing.costPer1kTokens ?? pricing.totalCostPer1kTokens;
  const outputRate = pricing.outputCostPer1kTokens ?? pricing.costPer1kTokens ?? pricing.totalCostPer1kTokens;
  const totalRate = pricing.totalCostPer1kTokens ?? pricing.costPer1kTokens;
  const inputCost =
    inputRate !== undefined && normalizedUsage.inputTokens !== undefined
      ? (normalizedUsage.inputTokens / 1000) * inputRate
      : undefined;
  const outputCost =
    outputRate !== undefined && normalizedUsage.outputTokens !== undefined
      ? (normalizedUsage.outputTokens / 1000) * outputRate
      : undefined;
  const totalCost =
    inputCost !== undefined || outputCost !== undefined
      ? (inputCost ?? 0) + (outputCost ?? 0)
      : totalRate !== undefined && normalizedUsage.totalTokens !== undefined
        ? (normalizedUsage.totalTokens / 1000) * totalRate
        : undefined;

  return {
    inputCost,
    outputCost,
    totalCost,
    currency: pricing.currency,
    usage: normalizedUsage
  };
};

const usageFromStateOrTrace = (stateOrTrace: AgentRunState | AgentTraceArtifact): TokenUsage | undefined =>
  stateOrTrace.usage;

const resolvePricing = (
  stateOrTrace: AgentRunState | AgentTraceArtifact,
  pricing?: AgentRunCostPricing
): TokenPricing | undefined => {
  if (!pricing) {
    return undefined;
  }
  if (!isCatalog(pricing)) {
    return pricing;
  }

  const entry = pricing.find(stateOrTrace.provider, stateOrTrace.modelId);
  return entry?.costPer1kTokens === undefined
    ? undefined
    : {
        costPer1kTokens: entry.costPer1kTokens
      };
};

export const estimateAgentRunCost = (
  stateOrTrace: AgentRunState | AgentTraceArtifact,
  pricing?: AgentRunCostPricing
): CostEstimate => estimateTokenCost(usageFromStateOrTrace(stateOrTrace), resolvePricing(stateOrTrace, pricing));

export const summarizeAgentTrace = (
  trace: AgentTraceArtifact,
  options: { pricing?: AgentRunCostPricing } = {}
): AgentTraceSummary => {
  const toolResults = trace.steps.flatMap((step) => step.toolResults);
  return {
    runId: trace.runId,
    agentId: trace.agentId,
    provider: trace.provider,
    modelId: trace.modelId,
    status: trace.status,
    latency: {
      startedAt: trace.startedAt,
      finishedAt: trace.updatedAt,
      durationMs: trace.durationMs
    },
    steps: trace.steps.length,
    toolCalls: trace.steps.reduce((total, step) => total + step.toolCalls.length, 0),
    toolErrors: toolResults.filter((result) => result.isError).length,
    approvals: trace.approvals.length,
    usage: trace.usage,
    cost: estimateAgentRunCost(trace, options.pricing),
    error: trace.error,
    cancellationReason: trace.cancellationReason
  };
};

export const createAgentTraceCollector = (options: AgentTraceOptions = {}): AgentTraceCollector => {
  const events = new Map<string, AgentTraceEvent[]>();
  const traces = new Map<string, AgentTraceArtifact>();
  let latestRunId: string | undefined;

  const appendEvent = (event: AgentTraceEvent) => {
    latestRunId = event.runId;
    events.set(event.runId, [...(events.get(event.runId) ?? []), event]);
  };

  return {
    observer: async (event) => {
      const traceEvent = toTraceEvent(event);
      appendEvent(traceEvent);
      if (event.type === "run-finish") {
        traces.set(event.runId, stateToTrace(event.state, options, events.get(event.runId) ?? [traceEvent]));
      }
    },
    getTrace(runId) {
      return traces.get(runId ?? latestRunId ?? "");
    },
    getEvents(runId) {
      if (runId) {
        return [...(events.get(runId) ?? [])];
      }
      return [...events.values()].flat();
    },
    reset(runId) {
      if (runId) {
        events.delete(runId);
        traces.delete(runId);
        if (latestRunId === runId) {
          latestRunId = undefined;
        }
        return;
      }
      events.clear();
      traces.clear();
      latestRunId = undefined;
    }
  };
};
