import { createRedactionPolicy, type RedactionPolicy, type RedactionPolicyOptions } from "./safety-policy.js";
import type {
  AgentRunState,
  JsonValue,
  ToolApprovalDecision,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolCall,
  ToolExecutionResult
} from "./types.js";

export const PRODUCTION_AGENT_KIT_SCHEMA_VERSION = 1 as const;

export interface SensitiveDataPolicyOptions extends RedactionPolicyOptions {}

export interface ReadOnlyToolApprovalPolicyOptions {
  allowToolNames?: string[];
  denyToolNames?: string[];
  readOnlyToolNames?: string[];
}

export interface AgentAuditRecordOptions {
  redaction?: RedactionPolicy | RedactionPolicyOptions | false;
  outputPreviewLength?: number;
  includeMetadata?: boolean;
}

export interface ToolAuditRecordOptions {
  redaction?: RedactionPolicy | RedactionPolicyOptions | false;
  includeInput?: boolean;
  includeOutput?: boolean;
  includeMetadata?: boolean;
}

export interface AgentAuditRecord {
  schemaVersion: typeof PRODUCTION_AGENT_KIT_SCHEMA_VERSION;
  type: "agent_run_audit";
  runId: string;
  agentId?: string;
  parentRunId?: string;
  provider: string;
  modelId: string;
  status: AgentRunState["status"];
  startedAt?: number;
  updatedAt?: number;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  approvals: number;
  childRuns: number;
  usage?: AgentRunState["usage"];
  outputPreview: string;
  finishReason?: AgentRunState["finishReason"];
  providerFinishReason?: string;
  error?: AgentRunState["error"];
  cancellationReason?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ToolAuditRecord {
  schemaVersion: typeof PRODUCTION_AGENT_KIT_SCHEMA_VERSION;
  type: "agent_tool_audit";
  runId: string;
  agentId?: string;
  provider: string;
  modelId: string;
  step: number;
  toolName: string;
  toolCallId: string;
  status: "completed" | "failed";
  input?: JsonValue;
  output?: JsonValue;
  error?: ToolExecutionResult["error"];
  metadata?: Record<string, JsonValue>;
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const isRedactionPolicy = (value: RedactionPolicy | RedactionPolicyOptions): value is RedactionPolicy =>
  "redactJson" in value && typeof value.redactJson === "function";

const resolveRedaction = (
  redaction: RedactionPolicy | RedactionPolicyOptions | false | undefined
): RedactionPolicy | undefined => {
  if (redaction === false) {
    return undefined;
  }

  if (redaction && isRedactionPolicy(redaction)) {
    return redaction;
  }

  return createSensitiveDataPolicy(typeof redaction === "object" ? redaction : undefined);
};

const redactJson = <T extends JsonValue | undefined>(
  redaction: RedactionPolicy | undefined,
  value: T
): T => (redaction ? redaction.redactJson(value) : value);

const preview = (redaction: RedactionPolicy | undefined, text: string, length: number): string => {
  const redacted = redaction ? redaction.redactText(text) : text;
  return redacted.length > length ? `${redacted.slice(0, Math.max(0, length))}...` : redacted;
};

const normalizeNames = (names: string[] | undefined) => new Set((names ?? []).map((name) => name.toLowerCase()));

const readOnlyNamePattern = /^(get|list|read|retrieve|search|find|inspect|describe|query|fetch|lookup|summarize)[_-]?/i;
const sideEffectNamePattern = /(write|create|update|delete|remove|mutate|send|post|put|patch|execute|exec|shell|deploy|publish|transfer|charge|refund|approve|reject)/i;
const writePermissions = new Set(["write", "filesystem", "code-execution", "shell", "external-side-effect", "network"]);

const advancedMetadata = (request: ToolApprovalRequest): Record<string, JsonValue> | undefined => {
  const metadata = request.tool.metadata?.advancedRegistry;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, JsonValue>
    : undefined;
};

const hasWritePermission = (request: ToolApprovalRequest): boolean => {
  const permissions = advancedMetadata(request)?.permissions;
  return Array.isArray(permissions) && permissions.some((permission) => typeof permission === "string" && writePermissions.has(permission));
};

const readOnlyDecision = (approved: boolean, reason: string, metadata: Record<string, JsonValue>): ToolApprovalDecision => ({
  approved,
  reason,
  metadata
});

export const createSensitiveDataPolicy = (options: SensitiveDataPolicyOptions = {}): RedactionPolicy =>
  createRedactionPolicy({
    includeEmails: true,
    ...options
  });

export const createReadOnlyToolApprovalPolicy = (
  options: ReadOnlyToolApprovalPolicyOptions = {}
): ToolApprovalPolicy => {
  const allowNames = normalizeNames(options.allowToolNames);
  const denyNames = normalizeNames(options.denyToolNames);
  const readOnlyNames = normalizeNames(options.readOnlyToolNames);

  return (request) => {
    const toolName = request.tool.name.toLowerCase();
    const metadata = { policy: "read-only" };

    if (denyNames.has(toolName)) {
      return readOnlyDecision(false, `Tool "${request.tool.name}" is denied by the read-only policy.`, metadata);
    }

    if (allowNames.has(toolName) || readOnlyNames.has(toolName)) {
      return { approved: true, metadata };
    }

    if (request.tool.requiresApproval) {
      return readOnlyDecision(false, `Tool "${request.tool.name}" requires explicit approval.`, metadata);
    }

    if (hasWritePermission(request) || sideEffectNamePattern.test(request.tool.name)) {
      return readOnlyDecision(false, `Tool "${request.tool.name}" is not read-only.`, metadata);
    }

    return readOnlyNamePattern.test(request.tool.name)
      ? { approved: true, metadata }
      : readOnlyDecision(false, `Tool "${request.tool.name}" is not classified as read-only.`, metadata);
  };
};

const toolCallsById = (state: AgentRunState): Map<string, { step: number; call: ToolCall }> => {
  const calls = new Map<string, { step: number; call: ToolCall }>();

  for (const step of state.steps) {
    for (const message of step.response?.messages ?? []) {
      for (const part of message.parts) {
        if (part.type === "tool-call") {
          calls.set(part.toolCall.id, { step: step.index, call: part.toolCall });
        }
      }
    }
  }

  return calls;
};

export const createAgentAuditRecord = (
  state: AgentRunState,
  options: AgentAuditRecordOptions = {}
): AgentAuditRecord => {
  const redaction = resolveRedaction(options.redaction);
  const toolCalls = toolCallsById(state).size;
  const toolErrors = state.toolResults.filter((result) => result.isError).length;

  return {
    schemaVersion: PRODUCTION_AGENT_KIT_SCHEMA_VERSION,
    type: "agent_run_audit",
    runId: state.runId,
    agentId: state.agentId,
    parentRunId: state.parentRunId,
    provider: state.provider,
    modelId: state.modelId,
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    steps: state.steps.length,
    toolCalls,
    toolErrors,
    approvals: state.pendingApprovals.length,
    childRuns: state.childRuns?.length ?? 0,
    usage: state.usage ? cloneJson(state.usage) : undefined,
    outputPreview: preview(redaction, state.outputText, options.outputPreviewLength ?? 500),
    finishReason: state.finishReason,
    providerFinishReason: state.providerFinishReason,
    error: state.error ? cloneJson(state.error) : undefined,
    cancellationReason: state.cancellationReason,
    metadata: options.includeMetadata ? redactJson(redaction, state.metadata) : undefined
  };
};

export const createToolAuditRecords = (
  state: AgentRunState,
  options: ToolAuditRecordOptions = {}
): ToolAuditRecord[] => {
  const redaction = resolveRedaction(options.redaction);
  const calls = toolCallsById(state);

  return state.toolResults.map((result) => {
    const call = calls.get(result.toolCallId);
    return {
      schemaVersion: PRODUCTION_AGENT_KIT_SCHEMA_VERSION,
      type: "agent_tool_audit",
      runId: state.runId,
      agentId: state.agentId,
      provider: state.provider,
      modelId: state.modelId,
      step: call?.step ?? state.currentStep,
      toolName: result.toolName,
      toolCallId: result.toolCallId,
      status: result.isError ? "failed" : "completed",
      input: options.includeInput ? redactJson(redaction, call?.call.input) : undefined,
      output: options.includeOutput ? redactJson(redaction, result.output) : undefined,
      error: result.error ? cloneJson(result.error) : undefined,
      metadata: options.includeMetadata ? redactJson(redaction, state.metadata) : undefined
    };
  });
};
