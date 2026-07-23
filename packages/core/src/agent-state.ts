import { ValidationError } from "./errors.js";
import type { AgentRunState } from "./types.js";

export const AGENT_RUN_STATE_SCHEMA_VERSION = 1 as const;

export type AgentRunStateMigrationTarget = typeof AGENT_RUN_STATE_SCHEMA_VERSION;

type UnknownRecord = Record<string, unknown>;

const AGENT_STATUSES = new Set([
  "queued",
  "running",
  "completed",
  "suspended",
  "waiting_approval",
  "cancel_requested",
  "failed",
  "cancelled",
  "timed_out"
]);
const STEP_STATUSES = new Set(["running", "completed", "suspended", "waiting_approval", "failed"]);
const FINISH_REASONS = new Set(["stop", "length", "tool-calls", "content-filter", "refusal", "error", "unknown"]);
const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const TOKEN_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens"
] as const;

const invalid = (path: string, expectation: string): never => {
  throw new ValidationError(`AgentRunState ${path} ${expectation}.`);
};

const record = (value: unknown, path: string): UnknownRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(path, "must be an object");
  }
  return value as UnknownRecord;
};

const string = (value: unknown, path: string, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return invalid(path, `must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
};

const optionalString = (value: unknown, path: string, allowEmpty = false) => {
  if (value !== undefined) string(value, path, allowEmpty);
};

const finiteNumber = (value: unknown, path: string, minimum?: number) => {
  if (typeof value !== "number" || !Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    invalid(path, `must be a finite number${minimum === undefined ? "" : ` greater than or equal to ${minimum}`}`);
  }
};

const integer = (value: unknown, path: string, minimum = 0) => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalid(path, `must be a safe integer greater than or equal to ${minimum}`);
  }
};

const optionalBoolean = (value: unknown, path: string) => {
  if (value !== undefined && typeof value !== "boolean") invalid(path, "must be a boolean");
};

const array = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) return invalid(path, "must be an array");
  return value;
};

const jsonValue = (value: unknown, path: string, allowUndefinedProperties = false, seen = new Set<object>()): void => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(path, "must contain only finite JSON numbers");
    return;
  }
  if (!value || typeof value !== "object") invalid(path, "must be JSON-compatible");
  const objectValue = value as object;
  if (seen.has(objectValue)) invalid(path, "must not contain circular references");
  seen.add(objectValue);
  if (Array.isArray(objectValue)) {
    objectValue.forEach((entry, index) => jsonValue(entry, `${path}[${index}]`, allowUndefinedProperties, seen));
  } else {
    for (const [key, entry] of Object.entries(objectValue)) {
      if (entry === undefined && allowUndefinedProperties) continue;
      jsonValue(entry, `${path}.${key}`, allowUndefinedProperties, seen);
    }
  }
  seen.delete(objectValue);
};

const optionalMetadata = (value: unknown, path: string) => {
  if (value === undefined) return;
  record(value, path);
  jsonValue(value, path);
};

const scope = (value: unknown, path: string) => {
  if (value === undefined) return;
  const current = record(value, path);
  string(current.tenantId, `${path}.tenantId`);
  optionalString(current.userId, `${path}.userId`);
  optionalString(current.namespace, `${path}.namespace`);
};

const toolCall = (value: unknown, path: string) => {
  const call = record(value, path);
  string(call.id, `${path}.id`);
  string(call.name, `${path}.name`);
  jsonValue(call.input, `${path}.input`);
  optionalMetadata(call.providerMetadata, `${path}.providerMetadata`);
};

const toolResult = (value: unknown, path: string) => {
  const result = record(value, path);
  string(result.toolCallId, `${path}.toolCallId`);
  string(result.toolName, `${path}.toolName`);
  if (typeof result.isError !== "boolean") invalid(`${path}.isError`, "must be a boolean");
  if (result.output !== undefined) jsonValue(result.output, `${path}.output`);
  if (result.error !== undefined) {
    const error = record(result.error, `${path}.error`);
    string(error.message, `${path}.error.message`);
  }
  optionalMetadata(result.providerMetadata, `${path}.providerMetadata`);
};

const message = (value: unknown, path: string) => {
  const current = record(value, path);
  if (!MESSAGE_ROLES.has(current.role as string)) invalid(`${path}.role`, "must be a supported message role");
  array(current.parts, `${path}.parts`).forEach((partValue, index) => {
    const partPath = `${path}.parts[${index}]`;
    const part = record(partValue, partPath);
    switch (part.type) {
      case "text":
        string(part.text, `${partPath}.text`, true);
        optionalMetadata(part.providerMetadata, `${partPath}.providerMetadata`);
        break;
      case "image":
        string(part.image, `${partPath}.image`);
        optionalString(part.mediaType, `${partPath}.mediaType`);
        optionalMetadata(part.providerMetadata, `${partPath}.providerMetadata`);
        break;
      case "audio":
        string(part.data, `${partPath}.data`, true);
        string(part.mediaType, `${partPath}.mediaType`);
        optionalString(part.filename, `${partPath}.filename`, true);
        optionalString(part.format, `${partPath}.format`, true);
        optionalString(part.transcript, `${partPath}.transcript`, true);
        optionalMetadata(part.providerMetadata, `${partPath}.providerMetadata`);
        break;
      case "file":
        string(part.data, `${partPath}.data`, true);
        string(part.mediaType, `${partPath}.mediaType`);
        optionalString(part.filename, `${partPath}.filename`, true);
        optionalMetadata(part.providerMetadata, `${partPath}.providerMetadata`);
        break;
      case "tool-call":
        toolCall(part.toolCall, `${partPath}.toolCall`);
        break;
      case "tool-result":
        toolResult(part.toolResult, `${partPath}.toolResult`);
        break;
      case "provider-data":
        string(part.provider, `${partPath}.provider`);
        jsonValue(part.data, `${partPath}.data`);
        break;
      default:
        invalid(`${partPath}.type`, "must be a supported content part type");
    }
  });
};

const messages = (value: unknown, path: string) => {
  array(value, path).forEach((entry, index) => message(entry, `${path}[${index}]`));
};

const usage = (value: unknown, path: string) => {
  if (value === undefined) return;
  const current = record(value, path);
  for (const field of TOKEN_FIELDS) {
    if (current[field] !== undefined) integer(current[field], `${path}.${field}`);
  }
  if (current.speed !== undefined && current.speed !== "standard" && current.speed !== "fast") {
    invalid(`${path}.speed`, 'must be "standard" or "fast"');
  }
};

const finishReason = (value: unknown, path: string) => {
  if (value !== undefined && !FINISH_REASONS.has(value as string)) invalid(path, "must be a supported finish reason");
};

const request = (value: unknown, path: string) => {
  const current = record(value, path);
  if (current.messageOffset !== undefined) integer(current.messageOffset, `${path}.messageOffset`);
  messages(current.messages, `${path}.messages`);
  if (current.toolChoice !== undefined) {
    if (!["auto", "none", "required"].includes(current.toolChoice as string)) {
      const choice = record(current.toolChoice, `${path}.toolChoice`);
      if (choice.type !== "tool") invalid(`${path}.toolChoice.type`, 'must be "tool"');
      string(choice.toolName, `${path}.toolChoice.toolName`);
    }
  }
  if (current.toolExecution !== undefined) {
    const execution = record(current.toolExecution, `${path}.toolExecution`);
    optionalBoolean(execution.parallel, `${path}.toolExecution.parallel`);
    if (execution.maxConcurrency !== undefined) integer(execution.maxConcurrency, `${path}.toolExecution.maxConcurrency`, 1);
    if (execution.timeoutMs !== undefined) finiteNumber(execution.timeoutMs, `${path}.toolExecution.timeoutMs`, 0);
    optionalBoolean(execution.stopOnError, `${path}.toolExecution.stopOnError`);
  }
  if (current.temperature !== undefined) finiteNumber(current.temperature, `${path}.temperature`);
  if (current.maxTokens !== undefined) integer(current.maxTokens, `${path}.maxTokens`);
  if (current.timeoutMs !== undefined) finiteNumber(current.timeoutMs, `${path}.timeoutMs`, 0);
  if (current.maxRetries !== undefined) integer(current.maxRetries, `${path}.maxRetries`);
  if (current.retryBackoffMs !== undefined) finiteNumber(current.retryBackoffMs, `${path}.retryBackoffMs`, 0);
  if (current.reasoning !== undefined) jsonValue(current.reasoning, `${path}.reasoning`, true);
  if (current.providerOptions !== undefined) jsonValue(current.providerOptions, `${path}.providerOptions`, true);
};

const step = (value: unknown, path: string) => {
  const current = record(value, path);
  integer(current.index, `${path}.index`, 1);
  if (!STEP_STATUSES.has(current.status as string)) invalid(`${path}.status`, "must be a supported step status");
  if (current.startedAt !== undefined) finiteNumber(current.startedAt, `${path}.startedAt`, 0);
  if (current.finishedAt !== undefined) finiteNumber(current.finishedAt, `${path}.finishedAt`, 0);
  if (
    typeof current.startedAt === "number" &&
    typeof current.finishedAt === "number" &&
    current.finishedAt < current.startedAt
  ) {
    invalid(`${path}.finishedAt`, "must not precede startedAt");
  }
  request(current.request, `${path}.request`);
  if (current.response !== undefined) {
    const response = record(current.response, `${path}.response`);
    messages(response.messages, `${path}.response.messages`);
    optionalString(response.text, `${path}.response.text`, true);
    finishReason(response.finishReason, `${path}.response.finishReason`);
    optionalString(response.providerFinishReason, `${path}.response.providerFinishReason`, true);
    usage(response.usage, `${path}.response.usage`);
  }
  array(current.toolResults, `${path}.toolResults`).forEach((entry, index) => toolResult(entry, `${path}.toolResults[${index}]`));
  if (current.error !== undefined) {
    const error = record(current.error, `${path}.error`);
    string(error.message, `${path}.error.message`);
  }
};

const approval = (value: unknown, path: string) => {
  const current = record(value, path);
  string(current.provider, `${path}.provider`);
  string(current.id, `${path}.id`);
  string(current.name, `${path}.name`);
  string(current.arguments, `${path}.arguments`, true);
  optionalString(current.serverLabel, `${path}.serverLabel`, true);
  jsonValue(current.rawData, `${path}.rawData`);
};

const handoff = (value: unknown, path: string) => {
  if (value === undefined) return;
  const current = record(value, path);
  string(current.id, `${path}.id`);
  string(current.fromRunId, `${path}.fromRunId`);
  scope(current.scope, `${path}.scope`);
  optionalString(current.fromAgentId, `${path}.fromAgentId`);
  optionalString(current.toAgentId, `${path}.toAgentId`);
  string(current.summary, `${path}.summary`, true);
  messages(current.contextMessages, `${path}.contextMessages`);
  optionalMetadata(current.metadata, `${path}.metadata`);
};

const childRun = (value: unknown, path: string) => {
  const current = record(value, path);
  string(current.runId, `${path}.runId`);
  optionalString(current.agentId, `${path}.agentId`);
  optionalString(current.parentRunId, `${path}.parentRunId`);
  optionalString(current.toolName, `${path}.toolName`);
  if (!AGENT_STATUSES.has(current.status as string)) invalid(`${path}.status`, "must be a supported agent status");
  string(current.outputText, `${path}.outputText`, true);
  integer(current.steps, `${path}.steps`);
  integer(current.toolCalls, `${path}.toolCalls`);
  integer(current.toolErrors, `${path}.toolErrors`);
  usage(current.usage, `${path}.usage`);
  if (current.startedAt !== undefined) finiteNumber(current.startedAt, `${path}.startedAt`, 0);
  if (current.updatedAt !== undefined) finiteNumber(current.updatedAt, `${path}.updatedAt`, 0);
  if (current.error !== undefined) string(record(current.error, `${path}.error`).message, `${path}.error.message`);
  optionalMetadata(current.metadata, `${path}.metadata`);
};

const cloneJson = <T>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return invalid("payload", "must be JSON-serializable");
  }
};

export const normalizeAgentRunState = (value: unknown): AgentRunState => {
  const state = record(value, "payload");
  if (state.schemaVersion !== undefined && state.schemaVersion !== AGENT_RUN_STATE_SCHEMA_VERSION) {
    if (typeof state.schemaVersion === "number" && state.schemaVersion > AGENT_RUN_STATE_SCHEMA_VERSION) {
      throw new ValidationError(`Unsupported AgentRunState schemaVersion ${state.schemaVersion}.`);
    }
    throw new ValidationError(
      `AgentRunState schemaVersion must be ${AGENT_RUN_STATE_SCHEMA_VERSION}; only states without schemaVersion are treated as legacy.`
    );
  }
  if (state.revision !== undefined) integer(state.revision, "revision");
  scope(state.scope, "scope");
  string(state.runId, "runId");
  optionalString(state.idempotencyKey, "idempotencyKey");
  optionalString(state.agentId, "agentId");
  optionalString(state.parentRunId, "parentRunId");
  string(state.provider, "provider");
  string(state.modelId, "modelId");
  if (!AGENT_STATUSES.has(state.status as string)) invalid("status", "must be a supported agent status");
  messages(state.messages, "messages");
  const stateSteps = array(state.steps, "steps");
  stateSteps.forEach((entry, index) => {
    step(entry, `steps[${index}]`);
    if (record(entry, `steps[${index}]`).index !== index + 1) {
      invalid(`steps[${index}].index`, `must equal ${index + 1}`);
    }
  });
  array(state.toolResults, "toolResults").forEach((entry, index) => toolResult(entry, `toolResults[${index}]`));
  integer(state.currentStep, "currentStep");
  integer(state.maxSteps, "maxSteps", 1);
  if (state.currentStep !== stateSteps.length) invalid("currentStep", "must equal steps.length");
  if ((state.maxSteps as number) < (state.currentStep as number)) invalid("maxSteps", "must be greater than or equal to currentStep");
  string(state.outputText, "outputText", true);
  finishReason(state.finishReason, "finishReason");
  optionalString(state.providerFinishReason, "providerFinishReason", true);
  usage(state.usage, "usage");
  array(state.pendingApprovals, "pendingApprovals").forEach((entry, index) => approval(entry, `pendingApprovals[${index}]`));
  if (state.childRuns !== undefined) {
    array(state.childRuns, "childRuns").forEach((entry, index) => childRun(entry, `childRuns[${index}]`));
  }
  optionalMetadata(state.metadata, "metadata");
  handoff(state.handoff, "handoff");
  for (const field of ["startedAt", "updatedAt", "cancelledAt"] as const) {
    if (state[field] !== undefined) finiteNumber(state[field], field, 0);
  }
  if (
    typeof state.startedAt === "number" &&
    typeof state.updatedAt === "number" &&
    state.updatedAt < state.startedAt
  ) {
    invalid("updatedAt", "must not precede startedAt");
  }
  optionalString(state.cancellationReason, "cancellationReason", true);
  if (state.error !== undefined) string(record(state.error, "error").message, "error.message");

  return {
    ...cloneJson(state as unknown as AgentRunState),
    schemaVersion: AGENT_RUN_STATE_SCHEMA_VERSION,
    revision: (state.revision as number | undefined) ?? 0
  };
};

export const migrateAgentRunState = (
  value: unknown,
  targetVersion: AgentRunStateMigrationTarget = AGENT_RUN_STATE_SCHEMA_VERSION
): AgentRunState => {
  if (targetVersion !== AGENT_RUN_STATE_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported AgentRunState migration target ${targetVersion}.`);
  }
  return normalizeAgentRunState(value);
};
