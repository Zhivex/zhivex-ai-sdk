import {
  createOtelObserver,
  type OTelHistogramLike,
  type OTelMeterLike,
  type OTelObserver,
  type OTelSpanHandle,
  type OTelTracerLike
} from "./observability.js";
import type {
  WorkflowTelemetryEvent,
  WorkflowTelemetryFinishEvent,
  WorkflowTelemetryObserver,
  WorkflowTelemetryStepFinishEvent,
  WorkflowTelemetryTerminalStatus
} from "./workflow.js";

type OTelMetricAttributeValue = string | number | boolean;

export interface CreateOtelWorkflowObserverOptions {
  observer?: OTelObserver;
  tracer?: OTelTracerLike;
  meter?: OTelMeterLike;
  tracerName?: string;
  meterName?: string;
  version?: string;
  spanNamePrefix?: string;
}

const OTEL_API_MODULE = "@opentelemetry/api";
const WORKFLOW_DURATION_METRIC = "gen_ai.invoke_workflow.duration";
const WORKFLOW_DURATION_BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 7200];

let optionalOtelApiPromise: Promise<any | undefined> | undefined;

const loadOptionalOtelApi = (): Promise<any | undefined> => {
  optionalOtelApiPromise ??= import(OTEL_API_MODULE).catch(() => undefined);
  return optionalOtelApiPromise;
};

const errorType = (error: Error): string => error.name || error.constructor?.name || "_OTHER";

const terminalError = (
  status: WorkflowTelemetryTerminalStatus,
  error: Error | undefined,
  fallback: string
): Error | undefined => {
  if (status !== "failed") {
    return undefined;
  }
  if (error) {
    return error;
  }
  return new Error(fallback);
};

const durationSeconds = (startedAt: number, finishedAt: number): number =>
  Math.max(0, finishedAt - startedAt) / 1000;

interface ActiveWorkflowSpan {
  handle: OTelSpanHandle;
  startedAt: number;
  workflowName?: string;
}

const settleSpanEnds = async (
  handles: Iterable<OTelSpanHandle>,
  attributes: Record<string, unknown>,
  endTime?: number
) => {
  const results = await Promise.allSettled(
    Array.from(handles, (handle) => handle.end({ attributes, endTime }))
  );
  const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejection) {
    throw rejection.reason;
  }
};

export const createOtelWorkflowObserver = async (
  options: CreateOtelWorkflowObserverOptions = {}
): Promise<WorkflowTelemetryObserver> => {
  const [observer, otel] = await Promise.all([
    options.observer ? Promise.resolve(options.observer) : createOtelObserver(options),
    options.meter ? Promise.resolve(undefined) : loadOptionalOtelApi()
  ]);
  const meter = options.meter ?? otel?.metrics?.getMeter(
    options.meterName ?? options.tracerName ?? "zhivex-ai",
    options.version
  );
  const durationHistogram = meter?.createHistogram(WORKFLOW_DURATION_METRIC, {
    description: "Duration of a workflow invocation.",
    unit: "s",
    advice: {
      explicitBucketBoundaries: [...WORKFLOW_DURATION_BUCKETS]
    }
  });
  const workflowSpans = new Map<string, ActiveWorkflowSpan>();
  const stepSpans = new Map<string, Map<number, OTelSpanHandle>>();
  const queues = new Map<string, Promise<void>>();
  const prefix = options.spanNamePrefix?.trim();

  const workflowSpanName = (workflowName?: string) =>
    prefix
      ? `${prefix}.workflow`
      : `invoke_workflow${workflowName ? ` ${workflowName}` : ""}`;
  const stepSpanName = (stepId: string) => prefix ? `${prefix}.step` : `workflow_step ${stepId}`;

  const closeSteps = async (runId: string, status: string, endTime?: number) => {
    const spans = stepSpans.get(runId);
    stepSpans.delete(runId);
    if (spans) {
      await settleSpanEnds(spans.values(), {
        "zhivex.workflow.step.status": status
      }, endTime);
    }
  };

  const recordDuration = (
    active: ActiveWorkflowSpan,
    event: Pick<WorkflowTelemetryFinishEvent, "finishedAt" | "workflowName">,
    error?: Error
  ) => {
    const attributes: Record<string, OTelMetricAttributeValue> = {};
    const workflowName = event.workflowName ?? active.workflowName;
    if (workflowName) {
      attributes["gen_ai.workflow.name"] = workflowName;
    }
    if (error) {
      attributes["error.type"] = errorType(error);
    }
    durationHistogram?.record(durationSeconds(active.startedAt, event.finishedAt), attributes);
  };

  const closeWorkflow = async (
    event: WorkflowTelemetryFinishEvent,
    error?: Error
  ) => {
    const active = workflowSpans.get(event.runId);
    workflowSpans.delete(event.runId);
    let stepError: unknown;
    try {
      await closeSteps(event.runId, "interrupted", event.finishedAt);
    } catch (caught) {
      stepError = caught;
    }

    if (active) {
      try {
        await active.handle.end({
          attributes: {
            "zhivex.workflow.status": event.status,
            "zhivex.workflow.duration_ms": Math.max(0, event.finishedAt - active.startedAt)
          },
          error,
          endTime: event.finishedAt
        });
      } finally {
        recordDuration(active, event, error);
      }
    }
    if (stepError) {
      throw stepError;
    }
  };

  const closeStep = async (event: WorkflowTelemetryStepFinishEvent) => {
    const spans = stepSpans.get(event.runId);
    const handle = spans?.get(event.stepIndex);
    spans?.delete(event.stepIndex);
    if (spans && spans.size === 0) {
      stepSpans.delete(event.runId);
    }
    const error = terminalError(event.status, event.error, "Workflow step failed.");
    await handle?.end({
      attributes: {
        "zhivex.workflow.step.status": event.status,
        "zhivex.workflow.step.duration_ms": Math.max(0, event.finishedAt - event.startedAt)
      },
      error,
      endTime: event.finishedAt
    });
  };

  const processEvent = async (event: WorkflowTelemetryEvent) => {
    if (event.type === "workflow-start") {
      const previous = workflowSpans.get(event.runId);
      if (previous) {
        await closeWorkflow({
          ...event,
          type: "workflow-finish",
          status: "failed",
          finishedAt: event.startedAt,
          error: new Error("Workflow invocation was replaced before it finished.")
        }, new Error("Workflow invocation was replaced before it finished."));
      }
      workflowSpans.set(event.runId, {
        startedAt: event.startedAt,
        workflowName: event.workflowName,
        handle: observer.startSpan(workflowSpanName(event.workflowName), {
          "gen_ai.operation.name": "invoke_workflow",
          "gen_ai.workflow.name": event.workflowName,
          "gen_ai.conversation.id": event.sessionId,
          "zhivex.workflow.id": event.workflowId,
          "zhivex.workflow.run_id": event.runId
        }, { kind: "internal", startTime: event.startedAt })
      });
      return;
    }

    if (event.type === "workflow-step-start") {
      const spans = stepSpans.get(event.runId) ?? new Map<number, OTelSpanHandle>();
      const previous = spans.get(event.stepIndex);
      spans.delete(event.stepIndex);
      await previous?.end({
        attributes: { "zhivex.workflow.step.status": "replaced" },
        endTime: event.startedAt
      });
      spans.set(event.stepIndex, observer.startSpan(stepSpanName(event.stepId), {
        "gen_ai.workflow.name": event.workflowName,
        "zhivex.workflow.id": event.workflowId,
        "zhivex.workflow.run_id": event.runId,
        "zhivex.workflow.step.id": event.stepId,
        "zhivex.workflow.step.index": event.stepIndex,
        "zhivex.workflow.step.kind": event.stepKind
      }, {
        kind: "internal",
        parent: workflowSpans.get(event.runId)?.handle,
        startTime: event.startedAt
      }));
      stepSpans.set(event.runId, spans);
      return;
    }

    if (event.type === "workflow-step-finish") {
      await closeStep(event);
      return;
    }

    const error = terminalError(event.status, event.error, "Workflow execution failed.");
    await closeWorkflow(event, error);
  };

  const workflowObserver: WorkflowTelemetryObserver = (event: WorkflowTelemetryEvent) => {
    const previous = queues.get(event.runId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(() => processEvent(event));
    queues.set(event.runId, task);
    return task.finally(() => {
      if (queues.get(event.runId) === task) {
        queues.delete(event.runId);
      }
    });
  };
  workflowObserver.withStepContext = (runId, stepIndex, callback) => {
    const handle = stepSpans.get(runId)?.get(stepIndex);
    return handle ? observer.withSpan(handle, callback) : callback();
  };
  return workflowObserver;
};
