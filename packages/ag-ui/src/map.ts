import type {
  AgentApprovalRequest,
  AgentRunState,
  AgentRunView,
  AgentStatus,
  AgentStreamEvent,
  TokenUsage
} from "@zhivex-ai/core";
import {
  AG_UI_PROTOCOL_VERSION,
  type AgUiEvent,
  type AgUiInterrupt,
  type AgUiTokenUsage
} from "./events.js";
import { diffJson } from "./json-patch.js";

export interface AgUiMapOptions {
  /** Conversation id carried on RUN_STARTED and RUN_FINISHED. */
  threadId: string;
  /** Run id carried on RUN_STARTED and RUN_FINISHED. */
  runId: string;
  /** Clock for event timestamps. Defaults to Date.now. */
  now?: () => number;
  parentRunId?: string;
}

interface PublicRun {
  runId: string;
  status?: string;
  agentId?: string;
  parentRunId?: string;
  provider?: string;
  modelId?: string;
  currentStep?: number;
  maxSteps?: number | "unlimited";
  outputText?: string;
  usage?: TokenUsage;
  pendingApprovals?: number;
}

interface PublicState {
  run: PublicRun | null;
  runs: Record<string, PublicRun>;
}

const jsonClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const publicRunFromView = (run: AgentRunView): PublicRun => ({
  runId: run.runId,
  status: run.status,
  ...(run.agentId ? { agentId: run.agentId } : {}),
  ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
  ...(run.provider ? { provider: run.provider } : {}),
  ...(run.modelId ? { modelId: run.modelId } : {}),
  currentStep: run.currentStep,
  maxSteps: run.maxSteps,
  ...(run.usage ? { usage: run.usage } : {})
});

const publicRunFromState = (state: AgentRunState): PublicRun => ({
  runId: state.runId,
  status: state.status,
  ...(state.agentId ? { agentId: state.agentId } : {}),
  ...(state.parentRunId ? { parentRunId: state.parentRunId } : {}),
  provider: state.provider,
  modelId: state.modelId,
  currentStep: state.currentStep,
  maxSteps: state.maxSteps,
  outputText: state.outputText,
  ...(state.usage ? { usage: state.usage } : {}),
  pendingApprovals: state.pendingApprovals.length
});

const toUsage = (
  usage: TokenUsage | undefined,
  provider?: string,
  modelId?: string
): AgUiTokenUsage[] | undefined => {
  if (!usage) return undefined;
  const entry: AgUiTokenUsage = {
    ...(provider ? { provider } : {}),
    ...(modelId ? { model: modelId } : {})
  };
  if (usage.inputTokens !== undefined) entry.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) entry.outputTokens = usage.outputTokens;
  if (usage.totalTokens !== undefined) entry.totalTokens = usage.totalTokens;
  if (usage.reasoningTokens !== undefined) entry.reasoningTokens = usage.reasoningTokens;
  if (usage.cachedInputTokens !== undefined) entry.cachedInputTokens = usage.cachedInputTokens;
  if (usage.cacheWriteTokens !== undefined) entry.cacheWriteInputTokens = usage.cacheWriteTokens;
  const ttl30mTokens = usage.cacheWriteTokensDetails?.ttl30mTokens;
  const ttl12hTokens = usage.cacheWriteTokensDetails?.ttl12hTokens;
  if (typeof ttl30mTokens === "number" || typeof ttl12hTokens === "number") {
    entry.cacheWriteTokensDetails = {
      ...(typeof ttl30mTokens === "number" ? { ttl30mTokens } : {}),
      ...(typeof ttl12hTokens === "number" ? { ttl12hTokens } : {})
    };
  }
  return Object.keys(entry).length > 0 ? [entry] : undefined;
};

const interruptFromApproval = (approval: AgentApprovalRequest): AgUiInterrupt => ({
  id: `${approval.provider}:${approval.id}`,
  reason: "tool_approval",
  message: `Approval required for ${approval.name}.`,
  ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
  metadata: {
    provider: approval.provider,
    approvalRequestId: approval.id,
    name: approval.name,
    kind: approval.kind ?? "provider"
  }
});

const toolContent = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
};

/**
 * Converts one Zhivex agent stream into AG-UI 1.0 events.
 * Approval pauses become RUN_FINISHED interrupt outcomes.
 * State events use the public run view. Messages, approval arguments,
 * provider payloads, and image bytes are not copied into the AG-UI stream.
 */
export async function* toAgUiEvents(
  source: AsyncIterable<AgentStreamEvent> | Iterable<AgentStreamEvent>,
  options: AgUiMapOptions
): AsyncIterable<AgUiEvent> {
  const now = options.now ?? Date.now;
  const stamp = (): { timestamp: number } => ({ timestamp: now() });
  let messageSequence = 0;
  let openMessageId: string | undefined;
  let parentMessageId: string | undefined;
  const openSteps: string[] = [];
  let state: PublicState = { run: null, runs: {} };
  let emittedState = false;
  let previousState: PublicState | undefined;
  const interrupts = new Map<string, AgUiInterrupt>();
  let terminal: AgUiEvent | undefined;
  let errorMessage: string | undefined;
  let sawRunFinish = false;
  let usage: AgUiTokenUsage[] | undefined;

  const nextMessageId = (): string => {
    messageSequence += 1;
    return `msg_${messageSequence}`;
  };

  const closeMessage = function* (): Generator<AgUiEvent> {
    if (!openMessageId) return;
    yield { ...stamp(), type: "TEXT_MESSAGE_END", messageId: openMessageId };
    parentMessageId = openMessageId;
    openMessageId = undefined;
  };

  const closeSteps = function* (): Generator<AgUiEvent> {
    while (openSteps.length > 0) {
      yield { ...stamp(), type: "STEP_FINISHED", stepName: openSteps.pop()! };
    }
  };

  const emitState = function* (next: PublicState): Generator<AgUiEvent> {
    const snapshot = jsonClone(next);
    if (!emittedState || !previousState) {
      emittedState = true;
      previousState = snapshot;
      state = snapshot;
      yield { ...stamp(), type: "STATE_SNAPSHOT", snapshot: snapshot as unknown as Record<string, unknown> };
      return;
    }
    const delta = diffJson(previousState, snapshot);
    previousState = snapshot;
    state = snapshot;
    if (delta.length === 0) return;
    yield { ...stamp(), type: "STATE_DELTA", delta };
  };

  const rememberApproval = (approval: AgentApprovalRequest) => {
    const interrupt = interruptFromApproval(approval);
    interrupts.set(interrupt.id, interrupt);
  };

  const finishRun = function* (): Generator<AgUiEvent> {
    if (sawRunFinish) return;
    sawRunFinish = true;
    yield* closeMessage();
    yield* closeSteps();
    if (terminal) {
      yield terminal;
      return;
    }
    if (errorMessage) {
      yield {
        ...stamp(),
        type: "RUN_ERROR",
        message: errorMessage,
        ...(usage ? { usage } : {})
      };
      return;
    }
    yield {
      ...stamp(),
      type: "RUN_FINISHED",
      threadId: options.threadId,
      runId: options.runId,
      outcome: { type: "success" },
      ...(usage ? { usage } : {})
    };
  };

  yield {
    ...stamp(),
    type: "RUN_STARTED",
    threadId: options.threadId,
    runId: options.runId,
    protocolVersion: AG_UI_PROTOCOL_VERSION,
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {})
  };

  for await (const event of source) {
    if (event.type === "agent-run-start" || event.type === "agent-approval-resolved") {
      if (event.type === "agent-approval-resolved") {
        yield {
          ...stamp(),
          type: "CUSTOM",
          name: "zhivex.approval.resolved",
          value: {
            provider: event.approval.provider,
            approvalRequestId: event.approval.approvalRequestId,
            approve: event.approval.approve
          }
        };
      }
      continue;
    }

    if (event.type === "agent-run-update") {
      const run = publicRunFromView(event.run);
      const runs = { ...state.runs, [run.runId]: run };
      const active = run.runId === options.runId || state.run === null ? run : state.run;
      yield* emitState({ run: active, runs });
      continue;
    }

    if (event.type === "agent-step-start") {
      const stepName = `step:${event.stepIndex}`;
      openSteps.push(stepName);
      yield { ...stamp(), type: "STEP_STARTED", stepName };
      continue;
    }

    if (event.type === "agent-step-finish") {
      const stepName = `step:${event.step.index}`;
      const openIndex = openSteps.lastIndexOf(stepName);
      if (openIndex >= 0) openSteps.splice(openIndex, 1);
      yield { ...stamp(), type: "STEP_FINISHED", stepName };
      continue;
    }

    if (event.type === "text-delta") {
      if (!openMessageId) {
        openMessageId = nextMessageId();
        yield { ...stamp(), type: "TEXT_MESSAGE_START", messageId: openMessageId, role: "assistant" };
      }
      yield { ...stamp(), type: "TEXT_MESSAGE_CONTENT", messageId: openMessageId, delta: event.textDelta };
      continue;
    }

    if (event.type === "tool-call") {
      yield* closeMessage();
      const toolCallId = event.toolCall.id;
      yield {
        ...stamp(),
        type: "TOOL_CALL_START",
        toolCallId,
        toolCallName: event.toolCall.name,
        ...(parentMessageId ? { parentMessageId } : {})
      };
      yield {
        ...stamp(),
        type: "TOOL_CALL_ARGS",
        toolCallId,
        delta: JSON.stringify(event.toolCall.input ?? {})
      };
      yield { ...stamp(), type: "TOOL_CALL_END", toolCallId };
      continue;
    }

    if (event.type === "tool-result") {
      yield {
        ...stamp(),
        type: "TOOL_CALL_RESULT",
        messageId: nextMessageId(),
        toolCallId: event.toolResult.toolCallId,
        content: event.toolResult.isError
          ? toolContent(event.toolResult.error ?? event.toolResult.output)
          : toolContent(event.toolResult.output),
        role: "tool"
      };
      continue;
    }

    if (event.type === "tool-approval-request" || event.type === "agent-approval-request") {
      rememberApproval(event.approval);
      continue;
    }

    if (event.type === "provider-data") {
      yield {
        ...stamp(),
        type: "CUSTOM",
        name: "zhivex.provider-data",
        value: { provider: event.provider }
      };
      continue;
    }

    if (event.type === "image-generation") {
      yield {
        ...stamp(),
        type: "CUSTOM",
        name: "zhivex.image",
        value: {
          provider: event.provider,
          partial: event.partial,
          ...(event.id ? { id: event.id } : {}),
          ...(event.index !== undefined ? { index: event.index } : {}),
          mediaType: event.image.mediaType
        }
      };
      continue;
    }

    if (event.type === "finish") {
      yield* closeMessage();
      usage = toUsage(event.usage) ?? usage;
      continue;
    }

    if (event.type === "error") {
      errorMessage = event.error.message || "Agent run failed.";
      continue;
    }

    if (event.type === "agent-compaction") {
      yield {
        ...stamp(),
        type: "ACTIVITY_SNAPSHOT",
        messageId: nextMessageId(),
        activityType: "compaction",
        replace: true,
        content: {
          id: event.compaction.id,
          beforeStep: event.compaction.beforeStep,
          messageCountBefore: event.compaction.messageCountBefore,
          messageCountAfter: event.compaction.messageCountAfter
        }
      };
      continue;
    }

    if (event.type === "agent-run-finish") {
      const run = publicRunFromState(event.state);
      yield* emitState({
        run: run.runId === options.runId || state.run === null ? run : state.run,
        runs: { ...state.runs, [run.runId]: run }
      });
      usage = toUsage(event.state.usage, event.state.provider, event.state.modelId) ?? usage;
      for (const approval of event.state.pendingApprovals) rememberApproval(approval);
      terminal = terminalEvent(event.status, options, interrupts, usage, errorMessage, stamp());
      yield* finishRun();
      continue;
    }

    const unhandled: never = event;
    return unhandled;
  }

  yield* finishRun();
}

const terminalEvent = (
  status: AgentStatus,
  options: AgUiMapOptions,
  interrupts: Map<string, AgUiInterrupt>,
  usage: AgUiTokenUsage[] | undefined,
  errorMessage: string | undefined,
  stamped: { timestamp: number }
): AgUiEvent => {
  if (status === "waiting_approval" || status === "suspended") {
    const pending = [...interrupts.values()];
    return {
      ...stamped,
      type: "RUN_FINISHED",
      threadId: options.threadId,
      runId: options.runId,
      outcome: {
        type: "interrupt",
        interrupts: pending.length > 0
          ? pending
          : [{
              id: `${options.runId}:approval`,
              reason: "tool_approval",
              message: "Approval required."
            }]
      }
    };
  }
  if (status === "cancelled" || status === "cancel_requested") {
    return {
      ...stamped,
      type: "RUN_FINISHED",
      threadId: options.threadId,
      runId: options.runId,
      outcome: { type: "cancelled" },
      ...(usage ? { usage } : {})
    };
  }
  if (status === "failed" || status === "timed_out") {
    return {
      ...stamped,
      type: "RUN_ERROR",
      message: errorMessage ?? `Agent run ${status}.`,
      code: status,
      ...(usage ? { usage } : {})
    };
  }
  return {
    ...stamped,
    type: "RUN_FINISHED",
    threadId: options.threadId,
    runId: options.runId,
    outcome: { type: "success" },
    ...(usage ? { usage } : {})
  };
};

export const collectAgUiEvents = async (
  source: AsyncIterable<AgentStreamEvent> | Iterable<AgentStreamEvent>,
  options: AgUiMapOptions
): Promise<AgUiEvent[]> => {
  const events: AgUiEvent[] = [];
  for await (const event of toAgUiEvents(source, options)) events.push(event);
  return events;
};
