import { createTelemetryMiddleware } from "./middleware.js";
import type {
  AgentTelemetryEvent,
  AgentTelemetryObserver,
  LanguageModelMiddleware,
  LanguageModelTelemetryEvent,
  ProviderOptions
} from "./types.js";

type PrimitiveSpanAttribute = string | number | boolean | null;
type SpanAttributeValue = PrimitiveSpanAttribute | PrimitiveSpanAttribute[];

export interface OTelSpanLike {
  setAttribute?(key: string, value: SpanAttributeValue): unknown;
  addEvent?(name: string, attributes?: Record<string, SpanAttributeValue>): unknown;
  recordException?(error: Error): unknown;
  setStatus?(status: unknown): unknown;
  end(): unknown;
}

export interface OTelTracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, SpanAttributeValue> }): OTelSpanLike;
}

const toSpanAttributeValue = (value: unknown): SpanAttributeValue | undefined => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? item : JSON.stringify(item)))
      .filter((item): item is PrimitiveSpanAttribute => item !== undefined);
    return normalized.length ? normalized : undefined;
  }

  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toSpanAttributes = (attributes: Record<string, unknown> | undefined): Record<string, SpanAttributeValue> => {
  const entries = Object.entries(attributes ?? {})
    .map(([key, value]) => [key, toSpanAttributeValue(value)] as const)
    .filter((entry): entry is readonly [string, SpanAttributeValue] => entry[1] !== undefined);
  return Object.fromEntries(entries);
};

const safeSetAttributes = (span: OTelSpanLike, attributes: Record<string, unknown> | undefined) => {
  for (const [key, value] of Object.entries(toSpanAttributes(attributes))) {
    span.setAttribute?.(key, value);
  }
};

const safeAddEvent = (span: OTelSpanLike | undefined, name: string, attributes?: Record<string, unknown>) => {
  if (!span?.addEvent) {
    return;
  }

  span.addEvent(name, toSpanAttributes(attributes));
};

export class OTelSpanHandle {
  constructor(
    readonly span: OTelSpanLike,
    private readonly statusSetter?: (span: OTelSpanLike, error: Error) => Promise<void> | void
  ) {}

  async end(options: {
    attributes?: Record<string, unknown>;
    error?: Error;
  } = {}) {
    safeSetAttributes(this.span, options.attributes);
    if (options.error) {
      this.span.recordException?.(options.error);
      await this.statusSetter?.(this.span, options.error);
    }
    this.span.end();
  }
}

export class OTelObserver {
  constructor(
    private readonly tracer: OTelTracerLike,
    private readonly statusSetter?: (span: OTelSpanLike, error: Error) => Promise<void> | void
  ) {}

  startSpan(name: string, attributes?: Record<string, unknown>): OTelSpanHandle {
    const span = this.tracer.startSpan(name, {
      attributes: toSpanAttributes(attributes)
    });
    return new OTelSpanHandle(span, this.statusSetter);
  }
}

const createDefaultStatusSetter = async () => {
  try {
    const otel = await import("@opentelemetry/api");
    return (span: OTelSpanLike, error: Error) => {
      span.setStatus?.({
        code: otel.SpanStatusCode.ERROR,
        message: error.message
      });
    };
  } catch {
    return undefined;
  }
};

export const createOtelObserver = async (options: {
  tracer?: OTelTracerLike;
  tracerName?: string;
  version?: string;
} = {}): Promise<OTelObserver> => {
  const statusSetter = await createDefaultStatusSetter();

  if (options.tracer) {
    return new OTelObserver(options.tracer, statusSetter);
  }

  try {
    const otel = await import("@opentelemetry/api");
    return new OTelObserver(otel.trace.getTracer(options.tracerName ?? "zhivex-ai", options.version), statusSetter);
  } catch (error) {
    throw new Error(
      'OpenTelemetry is not installed. Install "@opentelemetry/api" to use OTEL observability helpers.',
      { cause: error }
    );
  }
};

export const createOtelAgentObserver = async (options: {
  observer?: OTelObserver;
  tracer?: OTelTracerLike;
  tracerName?: string;
  version?: string;
  spanNamePrefix?: string;
} = {}): Promise<AgentTelemetryObserver> => {
  const observer = options.observer ?? (await createOtelObserver(options));
  const runSpans = new Map<string, OTelSpanHandle>();
  const stepSpans = new Map<string, OTelSpanHandle>();
  const prefix = options.spanNamePrefix ?? "zhivex.agent";

  return async (event: AgentTelemetryEvent) => {
    if (event.type === "run-start") {
      runSpans.set(
        event.runId,
        observer.startSpan(`${prefix}.run`, {
          "zhivex.run_id": event.runId,
          "zhivex.agent_id": event.agentId,
          "zhivex.provider": event.provider,
          "zhivex.model_id": event.modelId,
          "zhivex.max_steps": event.maxSteps
        })
      );
      return;
    }

    if (event.type === "step-start") {
      stepSpans.set(
        `${event.runId}:${event.stepIndex}`,
        observer.startSpan(`${prefix}.step`, {
          "zhivex.run_id": event.runId,
          "zhivex.agent_id": event.agentId,
          "zhivex.step_index": event.stepIndex
        })
      );
      return;
    }

    if (event.type === "step-finish") {
      const key = `${event.runId}:${event.step.index}`;
      const handle = stepSpans.get(key);
      stepSpans.delete(key);
      await handle?.end({
        attributes: {
          "zhivex.step_status": event.step.status,
          "zhivex.tool_results": event.step.toolResults.length
        }
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
        "zhivex.tool_name": event.toolCall.name,
        "zhivex.tool_call_id": event.toolCall.id,
        "zhivex.approved": event.approved,
        "zhivex.reason": event.reason
      });
      return;
    }

    if (event.type === "memory-loaded") {
      safeAddEvent(runSpans.get(event.runId)?.span, "memory-loaded", {
        "zhivex.message_count": event.messageCount
      });
      return;
    }

    if (event.type === "guardrail-triggered") {
      safeAddEvent(runSpans.get(event.runId)?.span, "guardrail-triggered", {
        "zhivex.stage": event.stage,
        "zhivex.reason": event.reason,
        ...event.metadata
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

    if (event.type === "state-saved") {
      safeAddEvent(runSpans.get(event.runId)?.span, "state-saved", {
        "zhivex.status": event.status
      });
      return;
    }

    if (event.type === "run-finish") {
      const handle = runSpans.get(event.runId);
      runSpans.delete(event.runId);
      await handle?.end({
        attributes: {
          "zhivex.status": event.status,
          "zhivex.current_step": event.state.currentStep,
          "zhivex.pending_approvals": event.state.pendingApprovals.length,
          "zhivex.finish_reason": event.state.finishReason,
          "zhivex.provider_finish_reason": event.state.providerFinishReason
        },
        error:
          event.status === "failed" && event.state.error?.message
            ? new Error(event.state.error.message)
            : undefined
      });
    }
  };
};

export const createOtelTelemetryMiddleware = async <TProviderOptions extends ProviderOptions = ProviderOptions>(options: {
  observer?: OTelObserver;
  tracer?: OTelTracerLike;
  tracerName?: string;
  version?: string;
  spanNamePrefix?: string;
} = {}): Promise<LanguageModelMiddleware<TProviderOptions>> => {
  const observer = options.observer ?? (await createOtelObserver(options));
  const spans = new Map<string, OTelSpanHandle>();
  const prefix = options.spanNamePrefix ?? "zhivex.model";

  const keyFor = (event: LanguageModelTelemetryEvent<TProviderOptions>) => {
    if (event.type === "generate-start" || event.type === "generate-finish" || event.type === "generate-error") {
      return `generate:${event.model.provider}:${event.model.modelId}:${event.startedAt}`;
    }

    if (event.type === "stream-start" || event.type === "stream-finish" || event.type === "stream-error") {
      return `stream:${event.model.provider}:${event.model.modelId}:${event.startedAt}`;
    }

    return `tool:${event.model.provider}:${event.model.modelId}:${event.step}:${event.toolCall.id}:${event.startedAt}`;
  };

  return createTelemetryMiddleware<TProviderOptions>({
    onEvent: async (event) => {
      if (event.type === "generate-start" || event.type === "stream-start") {
        spans.set(
          keyFor(event),
          observer.startSpan(`${prefix}.${event.type === "generate-start" ? "generate" : "stream"}`, {
            "zhivex.provider": event.model.provider,
            "zhivex.model_id": event.model.modelId
          })
        );
        return;
      }

      if (event.type === "tool-execution-start") {
        spans.set(
          keyFor(event),
          observer.startSpan(`${prefix}.tool`, {
            "zhivex.provider": event.model.provider,
            "zhivex.model_id": event.model.modelId,
            "zhivex.step": event.step,
            "zhivex.tool_name": event.toolCall.name,
            "zhivex.tool_call_id": event.toolCall.id
          })
        );
        return;
      }

      const handle = spans.get(keyFor(event));
      spans.delete(keyFor(event));

      if (event.type === "generate-finish") {
        await handle?.end({
          attributes: {
            "zhivex.latency_ms": event.latencyMs
          }
        });
        return;
      }

      if (event.type === "stream-finish") {
        await handle?.end({
          attributes: {
            "zhivex.finish_reason": event.finishReason,
            "zhivex.provider_finish_reason": event.providerFinishReason,
            "zhivex.latency_ms": event.latencyMs
          }
        });
        return;
      }

      if (event.type === "tool-execution-finish") {
        await handle?.end({
          attributes: {
            "zhivex.latency_ms": event.latencyMs,
            "zhivex.tool_error": event.toolResult.isError
          }
        });
        return;
      }

      if (event.type === "generate-error" || event.type === "stream-error" || event.type === "tool-execution-error") {
        await handle?.end({
          attributes: {
            "zhivex.latency_ms": event.latencyMs
          },
          error: event.error
        });
      }
    }
  });
};
