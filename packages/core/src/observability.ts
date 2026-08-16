import { createTelemetryMiddleware } from "./middleware.js";
import type {
  AgentTelemetryEvent,
  AgentTelemetryObserver,
  LanguageModelMiddleware,
  LanguageModelTelemetryEvent,
  ProviderOptions,
  TokenUsage
} from "./types.js";

type PrimitiveAttribute = string | number | boolean;
type OTelAttributeValue = PrimitiveAttribute | string[] | number[] | boolean[];
type OTelAttributes = Record<string, OTelAttributeValue>;

interface OTelSpanOptionsLike {
  attributes?: OTelAttributes;
  kind?: number;
  startTime?: number;
}

export interface OTelSpanLike {
  setAttribute?(key: string, value: OTelAttributeValue): unknown;
  addEvent?(name: string, attributes?: OTelAttributes): unknown;
  recordException?(error: Error): unknown;
  setStatus?(status: unknown): unknown;
  end(endTime?: number): unknown;
}

export interface OTelTracerLike {
  startSpan(name: string, options?: OTelSpanOptionsLike, context?: unknown): OTelSpanLike;
}

export interface OTelTracerProviderLike {
  getTracer(name: string, version?: string): OTelTracerLike;
}

export interface OTelHistogramLike {
  record(value: number, attributes?: OTelAttributes): unknown;
}

export interface OTelMeterLike {
  createHistogram(name: string, options?: {
    unit?: string;
    description?: string;
    advice?: { explicitBucketBoundaries?: number[] };
  }): OTelHistogramLike;
}

export interface OTelMeterProviderLike {
  getMeter(name: string, version?: string): OTelMeterLike;
}

/** Zhivex's stable, privacy-first mapping contract for GenAI telemetry. */
export const OTEL_GENAI_CONTRACT_VERSION = 1 as const;

/** Upstream Development revision used to audit the v1 mapping. */
export const OTEL_GENAI_SEMCONV_REVISION = "a685613a207a580163353b8e48a7ad88967e7b42";

const OTEL_API_MODULE = "@opentelemetry/api";

const GEN_AI = {
  agentName: "gen_ai.agent.name",
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestMaxTokens: "gen_ai.request.max_tokens",
  requestModel: "gen_ai.request.model",
  requestReasoningLevel: "gen_ai.request.reasoning.level",
  requestStream: "gen_ai.request.stream",
  requestTemperature: "gen_ai.request.temperature",
  responseFinishReasons: "gen_ai.response.finish_reasons",
  responseTimeToFirstChunk: "gen_ai.response.time_to_first_chunk",
  tokenType: "gen_ai.token.type",
  toolCallId: "gen_ai.tool.call.id",
  toolName: "gen_ai.tool.name",
  toolType: "gen_ai.tool.type",
  usageCacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",
  usageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  usageInputTokens: "gen_ai.usage.input_tokens",
  usageOutputTokens: "gen_ai.usage.output_tokens",
  usageReasoningOutputTokens: "gen_ai.usage.reasoning.output_tokens"
} as const;

const GEN_AI_OPERATION = {
  chat: "chat",
  executeTool: "execute_tool",
  generateContent: "generate_content",
  invokeAgent: "invoke_agent"
} as const;

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "azure-openai": "azure.ai.openai",
  bedrock: "aws.bedrock",
  gemini: "gcp.gemini",
  google: "gcp.gen_ai",
  kimi: "moonshot_ai",
  vertex: "gcp.vertex_ai",
  xai: "x_ai"
};

const DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92
];
const TOKEN_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864
];
const AGENT_DURATION_BUCKETS = [0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8, 409.6];
const CALL_COUNT_BUCKETS = [1, 2, 4, 8, 16, 32, 64, 128];

let optionalOtelApiPromise: Promise<any | undefined> | undefined;

// OpenTelemetry stays optional for consumers that never instantiate these helpers.
const loadOptionalOtelApi = (): Promise<any | undefined> => {
  optionalOtelApiPromise ??= import(OTEL_API_MODULE).catch(() => undefined);
  return optionalOtelApiPromise;
};

const toProviderName = (provider: string) => PROVIDER_NAMES[provider] ?? provider;
const toModelOperationName = (provider: string) =>
  provider === "gemini" || provider === "google" || provider === "vertex"
    ? GEN_AI_OPERATION.generateContent
    : GEN_AI_OPERATION.chat;

const toAttributeValue = (value: unknown): OTelAttributeValue | undefined => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const normalized = value.filter((item) => item !== null && item !== undefined);
    if (!normalized.length) return undefined;
    if (normalized.every((item): item is string => typeof item === "string")) return normalized;
    if (normalized.every((item): item is number => typeof item === "number")) return normalized;
    if (normalized.every((item): item is boolean => typeof item === "boolean")) return normalized;
    return normalized.map((item) => {
      if (typeof item === "string") return item;
      try {
        return JSON.stringify(item) ?? String(item);
      } catch {
        return String(item);
      }
    });
  }

  if (value === null || value === undefined) return undefined;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const toAttributes = (attributes: Record<string, unknown> | undefined): OTelAttributes => Object.fromEntries(
  Object.entries(attributes ?? {})
    .map(([key, value]) => [key, toAttributeValue(value)] as const)
    .filter((entry): entry is readonly [string, OTelAttributeValue] => entry[1] !== undefined)
);

const safeSetAttributes = (span: OTelSpanLike, attributes: Record<string, unknown> | undefined) => {
  for (const [key, value] of Object.entries(toAttributes(attributes))) span.setAttribute?.(key, value);
};

const safeAddEvent = (span: OTelSpanLike | undefined, name: string, attributes?: Record<string, unknown>) => {
  span?.addEvent?.(name, toAttributes(attributes));
};

const GUARDRAIL_METADATA_ALLOWLIST = {
  actual: "actual",
  budgetLimit: "budget_limit",
  includeChildRuns: "include_child_runs",
  limit: "limit",
  operation: "operation",
  remaining: "remaining",
  required: "required"
} as const;

const truncateTelemetryString = (value: string, maxLength: number) =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;

const safeGuardrailMetadataAttributes = (metadata: Record<string, unknown> | undefined) => {
  const attributes: Record<string, PrimitiveAttribute> = {};
  for (const [sourceKey, attributeKey] of Object.entries(GUARDRAIL_METADATA_ALLOWLIST)) {
    const value = metadata?.[sourceKey];
    if (typeof value === "string") {
      attributes[`zhivex.guardrail.metadata.${attributeKey}`] = truncateTelemetryString(value, 128);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      attributes[`zhivex.guardrail.metadata.${attributeKey}`] = value;
    } else if (typeof value === "boolean") {
      attributes[`zhivex.guardrail.metadata.${attributeKey}`] = value;
    }
  }
  return attributes;
};

const errorType = (error: Error) => error.name || error.constructor?.name || "_OTHER";
const seconds = (milliseconds: number) => Math.max(0, milliseconds) / 1_000;

const usageAttributes = (usage: TokenUsage | undefined): Record<string, unknown> => ({
  [GEN_AI.usageInputTokens]: usage?.inputTokens,
  [GEN_AI.usageOutputTokens]: usage?.outputTokens,
  [GEN_AI.usageCacheReadInputTokens]: usage?.cachedInputTokens,
  [GEN_AI.usageCacheCreationInputTokens]: usage?.cacheWriteTokens,
  [GEN_AI.usageReasoningOutputTokens]: usage?.reasoningTokens
});

const isStreamTelemetry = (event: LanguageModelTelemetryEvent) => event.type.startsWith("stream-");

const requestAttributes = (event: LanguageModelTelemetryEvent): Record<string, unknown> => ({
  [GEN_AI.operationName]: toModelOperationName(event.model.provider),
  [GEN_AI.providerName]: toProviderName(event.model.provider),
  [GEN_AI.requestModel]: event.model.modelId,
  [GEN_AI.requestStream]: isStreamTelemetry(event) ? true : undefined,
  [GEN_AI.requestTemperature]: event.input.temperature,
  [GEN_AI.requestMaxTokens]: event.input.maxTokens,
  [GEN_AI.requestReasoningLevel]: event.input.reasoning?.effort,
  "zhivex.provider": event.model.provider,
  "zhivex.model_id": event.model.modelId
});

const clientMetricAttributes = (event: LanguageModelTelemetryEvent, error?: Error): Record<string, unknown> => ({
  [GEN_AI.operationName]: toModelOperationName(event.model.provider),
  [GEN_AI.providerName]: toProviderName(event.model.provider),
  [GEN_AI.requestModel]: event.model.modelId,
  ...(error ? { "error.type": errorType(error) } : {})
});

const responseAttributes = (options: {
  finishReason?: string;
  providerFinishReason?: string;
  usage?: TokenUsage;
  latencyMs: number;
  outputChunkCount?: number;
}): Record<string, unknown> => ({
  [GEN_AI.responseFinishReasons]: options.finishReason ? [options.finishReason] : undefined,
  ...usageAttributes(options.usage),
  "zhivex.finish_reason": options.finishReason,
  "zhivex.provider_finish_reason": options.providerFinishReason,
  "zhivex.output_chunk_count": options.outputChunkCount,
  "zhivex.latency_ms": options.latencyMs
});

interface GenAiMetrics {
  clientTokenUsage: OTelHistogramLike;
  clientOperationDuration: OTelHistogramLike;
  clientTimeToFirstChunk: OTelHistogramLike;
  clientTimePerOutputChunk: OTelHistogramLike;
  invokeAgentDuration: OTelHistogramLike;
  invokeAgentInferenceCalls: OTelHistogramLike;
  invokeAgentToolCalls: OTelHistogramLike;
  executeToolDuration: OTelHistogramLike;
}

const histogram = (
  meter: OTelMeterLike,
  name: string,
  unit: string,
  description: string,
  explicitBucketBoundaries: number[]
) => meter.createHistogram(name, {
  unit,
  description,
  advice: { explicitBucketBoundaries: [...explicitBucketBoundaries] }
});

const createGenAiMetrics = (meter: OTelMeterLike): GenAiMetrics => ({
  clientTokenUsage: histogram(meter, "gen_ai.client.token.usage", "{token}", "Number of input and output tokens used.", TOKEN_BUCKETS),
  clientOperationDuration: histogram(meter, "gen_ai.client.operation.duration", "s", "GenAI operation duration.", DURATION_BUCKETS),
  clientTimeToFirstChunk: histogram(meter, "gen_ai.client.operation.time_to_first_chunk", "s", "Time to receive the first chunk, measured from when the client issues the generation request to when the first chunk is received in the response stream.", DURATION_BUCKETS),
  clientTimePerOutputChunk: histogram(meter, "gen_ai.client.operation.time_per_output_chunk", "s", "Time per output chunk, recorded for each chunk received after the first one, measured as the time elapsed from the end of the previous chunk to the end of the current chunk.", DURATION_BUCKETS),
  invokeAgentDuration: histogram(meter, "gen_ai.invoke_agent.duration", "s", "The end-to-end duration of a single in-process agent invocation, from the moment the invocation starts until the agent emits the last chunk of its final response or terminates with an error.", AGENT_DURATION_BUCKETS),
  invokeAgentInferenceCalls: histogram(meter, "gen_ai.invoke_agent.inference_calls", "{inference_call}", "The number of inference (model) calls a GenAI agent makes during a single invocation.", CALL_COUNT_BUCKETS),
  invokeAgentToolCalls: histogram(meter, "gen_ai.invoke_agent.tool_calls", "{tool_call}", "The number of tool calls an agent makes during a single invocation.", CALL_COUNT_BUCKETS),
  executeToolDuration: histogram(meter, "gen_ai.execute_tool.duration", "s", "The duration of a single tool execution.", DURATION_BUCKETS)
});

const safeRecord = (
  instrument: OTelHistogramLike | undefined,
  value: number | undefined,
  attributes: Record<string, unknown>
) => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return;
  try {
    instrument?.record(value, toAttributes(attributes));
  } catch {
    // Exporters are observational and cannot own the instrumented operation outcome.
  }
};

const recordTokenUsage = (
  metrics: GenAiMetrics | undefined,
  usage: TokenUsage | undefined,
  attributes: Record<string, unknown>
) => {
  safeRecord(metrics?.clientTokenUsage, usage?.inputTokens, { ...attributes, [GEN_AI.tokenType]: "input" });
  safeRecord(metrics?.clientTokenUsage, usage?.outputTokens, { ...attributes, [GEN_AI.tokenType]: "output" });
};

type MeterOptions = {
  meter?: OTelMeterLike;
  meterProvider?: OTelMeterProviderLike;
  meterName?: string;
  tracerName?: string;
  version?: string;
};

const resolveMeter = async (options: MeterOptions): Promise<OTelMeterLike | undefined> => {
  if (options.meter) return options.meter;
  if (options.meterProvider) {
    return options.meterProvider.getMeter(options.meterName ?? options.tracerName ?? "zhivex-ai", options.version);
  }
  const otel = await loadOptionalOtelApi();
  return otel?.metrics.getMeter(options.meterName ?? options.tracerName ?? "zhivex-ai", options.version);
};

export class OTelSpanHandle {
  private endPromise?: Promise<void>;

  constructor(
    readonly span: OTelSpanLike,
    private readonly statusSetter?: (span: OTelSpanLike, error: Error) => Promise<void> | void
  ) {}

  get ended() {
    return this.endPromise !== undefined;
  }

  end(options: {
    attributes?: Record<string, unknown>;
    error?: Error;
    endTime?: number;
  } = {}): Promise<void> {
    this.endPromise ??= this.finish(options);
    return this.endPromise;
  }

  private async finish(options: {
    attributes?: Record<string, unknown>;
    error?: Error;
    endTime?: number;
  }) {
    try {
      safeSetAttributes(this.span, {
        ...(options.error ? { "error.type": errorType(options.error) } : {}),
        ...options.attributes
      });
      if (options.error) {
        this.span.recordException?.(options.error);
        await this.statusSetter?.(this.span, options.error);
      }
    } finally {
      this.span.end(options.endTime);
    }
  }
}

export class OTelObserver {
  constructor(
    private readonly tracer: OTelTracerLike,
    private readonly statusSetter?: (span: OTelSpanLike, error: Error) => Promise<void> | void,
    private readonly contextFor?: (parent?: OTelSpanLike) => unknown,
    private readonly spanKindFor?: (kind: "internal" | "client") => number,
    private readonly runWithSpan?: <T>(
      span: OTelSpanLike,
      callback: () => T | Promise<T>
    ) => T | Promise<T>
  ) {}

  startSpan(
    name: string,
    attributes?: Record<string, unknown>,
    options: { parent?: OTelSpanHandle; kind?: "internal" | "client"; startTime?: number } = {}
  ): OTelSpanHandle {
    const span = this.tracer.startSpan(
      name,
      {
        attributes: toAttributes(attributes),
        kind: options.kind ? this.spanKindFor?.(options.kind) : undefined,
        startTime: options.startTime
      },
      this.contextFor?.(options.parent?.span)
    );
    return new OTelSpanHandle(span, this.statusSetter);
  }

  async withSpan<T>(handle: OTelSpanHandle, callback: () => T | Promise<T>): Promise<T> {
    if (!this.runWithSpan) return callback();
    return this.runWithSpan(handle.span, callback);
  }
}

const createDefaultStatusSetter = (otel: any | undefined) => {
  if (!otel) return undefined;
  return (span: OTelSpanLike, error: Error) => {
    span.setStatus?.({ code: otel.SpanStatusCode.ERROR, message: error.message });
  };
};

export const createOtelObserver = async (options: {
  tracer?: OTelTracerLike;
  tracerProvider?: OTelTracerProviderLike;
  tracerName?: string;
  version?: string;
} = {}): Promise<OTelObserver> => {
  const otel = await loadOptionalOtelApi();
  if (!options.tracer && !options.tracerProvider && !otel) {
    throw new Error(
      'OpenTelemetry is not installed. Install "@opentelemetry/api" to use OTEL observability helpers.',
      { cause: new Error(`Missing optional dependency: ${OTEL_API_MODULE}`) }
    );
  }

  const tracer = options.tracer
    ?? options.tracerProvider?.getTracer(options.tracerName ?? "zhivex-ai", options.version)
    ?? otel.trace.getTracer(options.tracerName ?? "zhivex-ai", options.version);
  return new OTelObserver(
    tracer,
    createDefaultStatusSetter(otel),
    otel ? (parent) => parent ? otel.trace.setSpan(otel.context.active(), parent) : otel.context.active() : undefined,
    otel ? (kind) => kind === "client" ? otel.SpanKind.CLIENT : otel.SpanKind.INTERNAL : undefined,
    otel
      ? (span, callback) => otel.context.with(otel.trace.setSpan(otel.context.active(), span), callback)
      : undefined
  );
};

const settleSpanEnds = async (
  handles: Iterable<OTelSpanHandle>,
  attributes: Record<string, unknown>,
  endTime?: number
) => {
  const results = await Promise.allSettled(
    Array.from(handles, (handle) => handle.end({ attributes, endTime }))
  );
  const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejection) throw rejection.reason;
};

const agentStatusError = (event: Extract<AgentTelemetryEvent, { type: "run-finish" }>) => {
  if (event.status === "failed") return new Error(event.state.error?.message ?? "Agent run failed.");
  if (event.status === "timed_out") {
    return Object.assign(new Error("Agent run timed out."), { name: "TimeoutError" });
  }
  return undefined;
};

interface AgentMetricState {
  startedAt: number;
  agentName?: string;
  modelId: string;
  inferenceCalls: number;
  toolCalls: number;
}

export const createOtelAgentObserver = async (options: {
  observer?: OTelObserver;
  tracer?: OTelTracerLike;
  tracerProvider?: OTelTracerProviderLike;
  tracerName?: string;
  version?: string;
  meter?: OTelMeterLike;
  meterProvider?: OTelMeterProviderLike;
  meterName?: string;
  spanNamePrefix?: string;
} = {}): Promise<AgentTelemetryObserver> => {
  const [observer, meter] = await Promise.all([
    options.observer ? Promise.resolve(options.observer) : createOtelObserver(options),
    resolveMeter(options)
  ]);
  const metrics = meter ? createGenAiMetrics(meter) : undefined;
  const runSpans = new Map<string, OTelSpanHandle>();
  const stepSpans = new Map<string, Map<number, OTelSpanHandle>>();
  const metricStates = new Map<string, AgentMetricState>();
  const queues = new Map<string, Promise<void>>();
  const prefix = options.spanNamePrefix?.trim();

  const runSpanName = (agentName?: string) =>
    prefix ? `${prefix}.run` : `${GEN_AI_OPERATION.invokeAgent}${agentName ? ` ${agentName}` : ""}`;
  const stepSpanName = () => prefix ? `${prefix}.step` : "agent_step";

  const closeSteps = async (runId: string, attributes: Record<string, unknown>, endTime?: number) => {
    const spans = stepSpans.get(runId);
    stepSpans.delete(runId);
    if (spans) await settleSpanEnds(spans.values(), attributes, endTime);
  };

  const recordAgentMetrics = (runId: string, endTime: number, error?: Error) => {
    const state = metricStates.get(runId);
    metricStates.delete(runId);
    if (!state) return;
    const nameAttributes = { [GEN_AI.agentName]: state.agentName };
    safeRecord(metrics?.invokeAgentDuration, seconds(endTime - state.startedAt), {
      ...nameAttributes,
      [GEN_AI.requestModel]: state.modelId,
      ...(error ? { "error.type": errorType(error) } : {})
    });
    safeRecord(metrics?.invokeAgentInferenceCalls, state.inferenceCalls, nameAttributes);
    safeRecord(metrics?.invokeAgentToolCalls, state.toolCalls, nameAttributes);
  };

  const closeRun = async (
    runId: string,
    attributes: Record<string, unknown>,
    error?: Error,
    endTime = Date.now()
  ) => {
    const run = runSpans.get(runId);
    runSpans.delete(runId);
    let firstError: unknown;
    try {
      await closeSteps(runId, {
        "zhivex.step_status": "interrupted",
        "zhivex.run_status": attributes["zhivex.status"]
      }, endTime);
    } catch (caught) {
      firstError = caught;
    }
    try {
      await run?.end({ attributes, error, endTime });
    } catch (caught) {
      firstError ??= caught;
    }
    try {
      recordAgentMetrics(runId, endTime, error);
    } catch (caught) {
      firstError ??= caught;
    }
    if (firstError) throw firstError;
  };

  const startRun = async (event: {
    runId: string;
    agentId?: string;
    agentName?: string;
    provider: string;
    modelId: string;
    maxSteps: number;
    startedAt?: number;
  }) => {
    const existing = runSpans.get(event.runId);
    if (existing) {
      const metricState = metricStates.get(event.runId);
      if (metricState) {
        metricState.agentName = event.agentName ?? metricState.agentName;
        metricState.modelId = event.modelId;
      }
      safeSetAttributes(existing.span, {
        [GEN_AI.agentName]: event.agentName,
        [GEN_AI.requestModel]: event.modelId,
        "zhivex.agent_id": event.agentId,
        "zhivex.provider": event.provider,
        "zhivex.model_id": event.modelId,
        "zhivex.max_steps": event.maxSteps
      });
      return;
    }

    const startedAt = event.startedAt ?? Date.now();
    await closeRun(event.runId, { "zhivex.status": "replaced" }, undefined, startedAt);
    metricStates.set(event.runId, {
      startedAt,
      agentName: event.agentName,
      modelId: event.modelId,
      inferenceCalls: 0,
      toolCalls: 0
    });
    runSpans.set(event.runId, observer.startSpan(runSpanName(event.agentName), {
      [GEN_AI.operationName]: GEN_AI_OPERATION.invokeAgent,
      [GEN_AI.agentName]: event.agentName,
      [GEN_AI.requestModel]: event.modelId,
      "zhivex.run_id": event.runId,
      "zhivex.agent_id": event.agentId,
      "zhivex.provider": event.provider,
      "zhivex.model_id": event.modelId,
      "zhivex.max_steps": event.maxSteps
    }, { kind: "internal", startTime: startedAt }));
  };

  const processEvent = async (event: AgentTelemetryEvent) => {
    if (event.type === "run-start") {
      await startRun(event);
      return;
    }

    if (event.type === "step-start") {
      const metricState = metricStates.get(event.runId);
      if (metricState) metricState.inferenceCalls += 1;
      const spans = stepSpans.get(event.runId) ?? new Map<number, OTelSpanHandle>();
      const previous = spans.get(event.stepIndex);
      spans.delete(event.stepIndex);
      await previous?.end({ attributes: { "zhivex.step_status": "replaced" }, endTime: event.startedAt });
      spans.set(event.stepIndex, observer.startSpan(stepSpanName(), {
        [GEN_AI.agentName]: event.agentName ?? metricState?.agentName,
        "zhivex.run_id": event.runId,
        "zhivex.agent_id": event.agentId,
        "zhivex.step_index": event.stepIndex
      }, {
        kind: "internal",
        parent: runSpans.get(event.runId),
        startTime: event.startedAt
      }));
      stepSpans.set(event.runId, spans);
      return;
    }

    if (event.type === "step-finish") {
      const spans = stepSpans.get(event.runId);
      const handle = spans?.get(event.step.index);
      spans?.delete(event.step.index);
      if (spans?.size === 0) stepSpans.delete(event.runId);
      await handle?.end({
        attributes: {
          "zhivex.step_status": event.step.status,
          "zhivex.tool_results": event.step.toolResults.length
        },
        error: event.step.status === "failed" ? new Error(event.step.error?.message ?? "Agent step failed.") : undefined,
        endTime: event.step.finishedAt
      });
      return;
    }

    if (event.type === "tool-start") {
      const metricState = metricStates.get(event.runId);
      if (metricState) metricState.toolCalls += 1;
      safeAddEvent(runSpans.get(event.runId)?.span, "tool-start", {
        [GEN_AI.toolName]: event.toolCall.name,
        [GEN_AI.toolCallId]: event.toolCall.id,
        "zhivex.step_index": event.stepIndex
      });
      return;
    }

    if (event.type === "approval-request") {
      safeAddEvent(runSpans.get(event.runId)?.span, "approval-request", {
        "zhivex.approval_id": event.approval.id,
        "zhivex.approval_provider": event.approval.provider,
        "zhivex.approval_name": event.approval.name
      });
      return;
    }
    if (event.type === "approval-resolved") {
      safeAddEvent(runSpans.get(event.runId)?.span, "approval-resolved", {
        "zhivex.approval_id": event.approval.approvalRequestId,
        "zhivex.approval_provider": event.approval.provider,
        "zhivex.approved": event.approval.approve,
        "zhivex.reason": event.approval.reason
      });
      return;
    }
    if (event.type === "tool-approval") {
      safeAddEvent(runSpans.get(event.runId)?.span, "tool-approval", {
        [GEN_AI.toolName]: event.toolCall.name,
        [GEN_AI.toolCallId]: event.toolCall.id,
        "zhivex.tool_name": event.toolCall.name,
        "zhivex.tool_call_id": event.toolCall.id,
        "zhivex.approved": event.approved,
        "zhivex.reason": event.reason
      });
      return;
    }
    if (event.type === "memory-loaded") {
      safeAddEvent(runSpans.get(event.runId)?.span, "memory-loaded", { "zhivex.message_count": event.messageCount });
      return;
    }
    if (event.type === "guardrail-triggered") {
      safeAddEvent(runSpans.get(event.runId)?.span, "guardrail-triggered", {
        "zhivex.stage": event.stage,
        "zhivex.reason": event.reason ? truncateTelemetryString(event.reason, 256) : undefined,
        ...safeGuardrailMetadataAttributes(event.metadata)
      });
      return;
    }
    if (event.type === "handoff") {
      safeAddEvent(runSpans.get(event.runId)?.span, "handoff", {
        "zhivex.handoff_id": event.handoff.id,
        "zhivex.from_agent_id": event.handoff.fromAgentId,
        "zhivex.to_agent_id": event.handoff.toAgentId
      });
      return;
    }
    if (event.type === "subagent-start") {
      safeAddEvent(runSpans.get(event.runId)?.span, "subagent-start", {
        "zhivex.child_agent_id": event.childAgentId,
        "zhivex.tool_name": event.toolName
      });
      return;
    }
    if (event.type === "subagent-finish") {
      safeAddEvent(runSpans.get(event.runId)?.span, "subagent-finish", {
        "zhivex.child_run_id": event.childRun.runId,
        "zhivex.child_agent_id": event.childRun.agentId,
        "zhivex.status": event.childRun.status
      });
      return;
    }
    if (event.type === "state-saved") {
      safeAddEvent(runSpans.get(event.runId)?.span, "state-saved", { "zhivex.status": event.status });
      return;
    }

    if (event.type === "run-finish") {
      const error = agentStatusError(event);
      const finishedAt = event.finishedAt ?? event.state.updatedAt ?? Date.now();
      await closeRun(event.runId, {
        "zhivex.status": event.status,
        "zhivex.current_step": event.state.currentStep,
        "zhivex.pending_approvals": event.state.pendingApprovals.length,
        "zhivex.finish_reason": event.state.finishReason,
        "zhivex.provider_finish_reason": event.state.providerFinishReason,
        "zhivex.usage_input_tokens": event.state.usage?.inputTokens,
        "zhivex.usage_output_tokens": event.state.usage?.outputTokens,
        "zhivex.usage_total_tokens": event.state.usage?.totalTokens
      }, error, finishedAt);
    }
  };

  const enqueue = (runId: string, operation: () => Promise<void>) => {
    const previous = queues.get(runId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    queues.set(runId, task);
    return task.finally(() => {
      if (queues.get(runId) === task) queues.delete(runId);
    });
  };
  const telemetryObserver: AgentTelemetryObserver = (event: AgentTelemetryEvent) =>
    enqueue(event.runId, () => processEvent(event));
  telemetryObserver.startInvocation = (event) => enqueue(event.runId, () => startRun(event));
  telemetryObserver.finishInvocation = (event) => enqueue(event.runId, () => closeRun(
    event.runId,
    { "zhivex.status": event.status },
    event.error,
    event.finishedAt
  ));
  telemetryObserver.withRunContext = async (runId, callback) => {
    const handle = runSpans.get(runId);
    return handle ? observer.withSpan(handle, callback) : callback();
  };
  telemetryObserver.withStepContext = async (runId, stepIndex, callback) => {
    const handle = stepSpans.get(runId)?.get(stepIndex) ?? runSpans.get(runId);
    return handle ? observer.withSpan(handle, callback) : callback();
  };
  return telemetryObserver;
};

export const createOtelTelemetryMiddleware = async <TProviderOptions extends ProviderOptions = ProviderOptions>(options: {
  observer?: OTelObserver;
  tracer?: OTelTracerLike;
  tracerProvider?: OTelTracerProviderLike;
  tracerName?: string;
  version?: string;
  meter?: OTelMeterLike;
  meterProvider?: OTelMeterProviderLike;
  meterName?: string;
  spanNamePrefix?: string;
} = {}): Promise<LanguageModelMiddleware<TProviderOptions>> => {
  const [observer, meter] = await Promise.all([
    options.observer ? Promise.resolve(options.observer) : createOtelObserver(options),
    resolveMeter(options)
  ]);
  const metrics = meter ? createGenAiMetrics(meter) : undefined;
  const spans = new Map<string, OTelSpanHandle[]>();
  const inputIds = new WeakMap<object, number>();
  let nextInputId = 1;
  const prefix = options.spanNamePrefix?.trim();

  const inputId = (input: object) => {
    const existing = inputIds.get(input);
    if (existing !== undefined) return existing;
    const id = nextInputId;
    nextInputId += 1;
    inputIds.set(input, id);
    return id;
  };

  const keyFor = (event: LanguageModelTelemetryEvent<TProviderOptions>) => {
    if (event.type === "generate-start" || event.type === "generate-finish" || event.type === "generate-error") {
      return event.generateId === undefined
        ? `generate:${event.model.provider}:${event.model.modelId}:${inputId(event.input)}:${event.startedAt}`
        : `generate:${event.generateId}`;
    }
    if (event.type === "stream-start" || event.type === "stream-chunk" || event.type === "stream-finish" || event.type === "stream-error") {
      return event.streamId === undefined
        ? `stream:${event.model.provider}:${event.model.modelId}:${inputId(event.input)}:${event.startedAt}`
        : `stream:${event.streamId}`;
    }
    return `tool:${event.model.provider}:${event.model.modelId}:${inputId(event.input)}:${event.step}:${event.toolCall.id}:${event.startedAt}`;
  };

  const pushSpan = (key: string, handle: OTelSpanHandle) => {
    const queued = spans.get(key) ?? [];
    queued.push(handle);
    spans.set(key, queued);
  };
  const peekSpan = (key: string) => spans.get(key)?.[0];
  const shiftSpan = (key: string) => {
    const queued = spans.get(key);
    const handle = queued?.shift();
    if (queued?.length === 0) spans.delete(key);
    return handle;
  };
  const modelSpanName = (modelId: string, provider: string, operation: "generate" | "stream") =>
    prefix ? `${prefix}.${operation}` : `${toModelOperationName(provider)} ${modelId}`;
  const toolSpanName = (toolName: string) =>
    prefix ? `${prefix}.tool` : `${GEN_AI_OPERATION.executeTool} ${toolName}`;

  return createTelemetryMiddleware<TProviderOptions>({
    onEvent: async (event) => {
      if (event.type === "generate-start" || event.type === "stream-start") {
        pushSpan(keyFor(event), observer.startSpan(
          modelSpanName(
            event.model.modelId,
            event.model.provider,
            event.type === "generate-start" ? "generate" : "stream"
          ),
          {
            ...requestAttributes(event),
            "zhivex.operation_type": event.type === "generate-start" ? "generate" : "stream",
            "zhivex.generate_id": event.type === "generate-start" ? event.generateId : undefined,
            "zhivex.stream_id": event.type === "stream-start" ? event.streamId : undefined
          },
          { kind: "client", startTime: event.startedAt }
        ));
        return;
      }

      if (event.type === "stream-chunk") {
        const attributes = clientMetricAttributes(event);
        if (event.chunkIndex === 1 && event.timeToFirstChunkMs !== undefined) {
          const duration = seconds(event.timeToFirstChunkMs);
          safeRecord(metrics?.clientTimeToFirstChunk, duration, attributes);
          const span = peekSpan(keyFor(event))?.span;
          if (span) safeSetAttributes(span, { [GEN_AI.responseTimeToFirstChunk]: duration });
        }
        if (event.timeSincePreviousChunkMs !== undefined) {
          safeRecord(metrics?.clientTimePerOutputChunk, seconds(event.timeSincePreviousChunkMs), attributes);
        }
        return;
      }

      if (event.type === "tool-execution-start") {
        pushSpan(keyFor(event), observer.startSpan(toolSpanName(event.toolCall.name), {
          [GEN_AI.operationName]: GEN_AI_OPERATION.executeTool,
          [GEN_AI.toolName]: event.toolCall.name,
          [GEN_AI.toolCallId]: event.toolCall.id,
          [GEN_AI.toolType]: "function",
          "zhivex.provider": event.model.provider,
          "zhivex.model_id": event.model.modelId,
          "zhivex.step": event.step,
          "zhivex.tool_name": event.toolCall.name,
          "zhivex.tool_call_id": event.toolCall.id
        }, { kind: "internal", startTime: event.startedAt }));
        return;
      }

      const handle = shiftSpan(keyFor(event));
      if (event.type === "generate-finish") {
        const attributes = clientMetricAttributes(event);
        safeRecord(metrics?.clientOperationDuration, seconds(event.latencyMs), attributes);
        recordTokenUsage(metrics, event.output.usage, attributes);
        await handle?.end({
          attributes: responseAttributes({
            finishReason: event.output.finishReason,
            providerFinishReason: event.output.providerFinishReason,
            usage: event.output.usage,
            latencyMs: event.latencyMs
          }),
          endTime: event.finishedAt
        });
        return;
      }

      if (event.type === "stream-finish") {
        const attributes = clientMetricAttributes(event);
        safeRecord(metrics?.clientOperationDuration, seconds(event.latencyMs), attributes);
        recordTokenUsage(metrics, event.usage, attributes);
        await handle?.end({ attributes: responseAttributes(event), endTime: event.finishedAt });
        return;
      }

      if (event.type === "tool-execution-finish") {
        const error = event.toolResult.isError ? new Error(event.toolResult.error?.message ?? "Tool execution failed.") : undefined;
        safeRecord(metrics?.executeToolDuration, seconds(event.latencyMs), {
          [GEN_AI.toolName]: event.toolCall.name,
          [GEN_AI.toolType]: "function",
          ...(error ? { "error.type": errorType(error) } : {})
        });
        await handle?.end({
          attributes: {
            "zhivex.latency_ms": event.latencyMs,
            "zhivex.tool_error": event.toolResult.isError
          },
          error,
          endTime: event.finishedAt
        });
        return;
      }

      if (event.type === "generate-error" || event.type === "stream-error") {
        safeRecord(metrics?.clientOperationDuration, seconds(event.latencyMs), clientMetricAttributes(event, event.error));
        await handle?.end({
          attributes: {
            "zhivex.latency_ms": event.latencyMs,
            ...(event.type === "stream-error" ? { "zhivex.output_chunk_count": event.outputChunkCount } : {})
          },
          error: event.error,
          endTime: event.finishedAt
        });
        return;
      }

      if (event.type === "tool-execution-error") {
        safeRecord(metrics?.executeToolDuration, seconds(event.latencyMs), {
          [GEN_AI.toolName]: event.toolCall.name,
          [GEN_AI.toolType]: "function",
          "error.type": errorType(event.error)
        });
        await handle?.end({
          attributes: { "zhivex.latency_ms": event.latencyMs },
          error: event.error,
          endTime: event.finishedAt
        });
      }
    }
  });
};
