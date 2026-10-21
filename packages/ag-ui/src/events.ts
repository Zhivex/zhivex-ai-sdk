/**
 * AG-UI 1.0 events this adapter emits.
 * Field names follow https://docs.ag-ui.com/spec/1.0/schema.
 * The package does not depend on an AG-UI runtime.
 */

export const AG_UI_PROTOCOL_VERSION = "1.0" as const;

export interface AgUiBaseEvent {
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface AgUiRunStartedEvent extends AgUiBaseEvent {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
  protocolVersion: typeof AG_UI_PROTOCOL_VERSION;
  parentRunId?: string;
}

export interface AgUiTextMessageStartEvent extends AgUiBaseEvent {
  type: "TEXT_MESSAGE_START";
  messageId: string;
  role: "assistant";
}

export interface AgUiTextMessageContentEvent extends AgUiBaseEvent {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}

export interface AgUiTextMessageEndEvent extends AgUiBaseEvent {
  type: "TEXT_MESSAGE_END";
  messageId: string;
}

export interface AgUiToolCallStartEvent extends AgUiBaseEvent {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface AgUiToolCallArgsEvent extends AgUiBaseEvent {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  delta: string;
}

export interface AgUiToolCallEndEvent extends AgUiBaseEvent {
  type: "TOOL_CALL_END";
  toolCallId: string;
}

export interface AgUiToolCallResultEvent extends AgUiBaseEvent {
  type: "TOOL_CALL_RESULT";
  messageId: string;
  toolCallId: string;
  content: string;
  role: "tool";
}

export interface AgUiStateSnapshotEvent extends AgUiBaseEvent {
  type: "STATE_SNAPSHOT";
  snapshot: Record<string, unknown>;
}

export interface AgUiJsonPatchOperation {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

export interface AgUiStateDeltaEvent extends AgUiBaseEvent {
  type: "STATE_DELTA";
  delta: AgUiJsonPatchOperation[];
}

export interface AgUiStepStartedEvent extends AgUiBaseEvent {
  type: "STEP_STARTED";
  stepName: string;
}

export interface AgUiStepFinishedEvent extends AgUiBaseEvent {
  type: "STEP_FINISHED";
  stepName: string;
}

export interface AgUiActivitySnapshotEvent extends AgUiBaseEvent {
  type: "ACTIVITY_SNAPSHOT";
  messageId: string;
  activityType: string;
  content: Record<string, unknown>;
  replace?: boolean;
}

export interface AgUiCustomEvent extends AgUiBaseEvent {
  type: "CUSTOM";
  name: string;
  value: unknown;
}

export interface AgUiInterrupt {
  id: string;
  reason: "tool_approval";
  message?: string;
  toolCallId?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AgUiRunFinishedEvent extends AgUiBaseEvent {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  outcome?:
    | { type: "success" }
    | { type: "cancelled" }
    | { type: "interrupt"; interrupts: AgUiInterrupt[] };
  usage?: AgUiTokenUsage[];
}

export interface AgUiRunErrorEvent extends AgUiBaseEvent {
  type: "RUN_ERROR";
  message: string;
  code?: string;
  usage?: AgUiTokenUsage[];
}

export interface AgUiTokenUsage {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** Lifetime split for cache writes. Omitted when the source usage has no split. */
  cacheWriteTokensDetails?: {
    ttl30mTokens?: number;
    ttl12hTokens?: number;
  };
}

export type AgUiEvent =
  | AgUiRunStartedEvent
  | AgUiTextMessageStartEvent
  | AgUiTextMessageContentEvent
  | AgUiTextMessageEndEvent
  | AgUiToolCallStartEvent
  | AgUiToolCallArgsEvent
  | AgUiToolCallEndEvent
  | AgUiToolCallResultEvent
  | AgUiStateSnapshotEvent
  | AgUiStateDeltaEvent
  | AgUiStepStartedEvent
  | AgUiStepFinishedEvent
  | AgUiActivitySnapshotEvent
  | AgUiCustomEvent
  | AgUiRunFinishedEvent
  | AgUiRunErrorEvent;
