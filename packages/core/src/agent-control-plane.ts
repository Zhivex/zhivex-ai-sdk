import { randomBytes, timingSafeEqual } from "node:crypto";

import { cancelAgentRun, cancelAgentRunTree, resumeAgent, runAgent, streamAgent } from "./agent.js";
import {
  createAgentExecutionEnvironmentBinding,
  createAgentHarnessBinding,
  fingerprintAgentHarness
} from "./agent-harness.js";
import { createAgentRunSnapshot, replayAgentRun, type AgentReplayResult, type AgentRunSnapshot } from "./agent-evaluation.js";
import {
  createAgentTraceArtifact,
  createProductionTraceOptions,
  createHierarchicalAgentTrace,
  estimateAgentRunCost,
  summarizeAgentTrace,
  type AgentRunCostPricing,
  type AgentTraceArtifact,
  type AgentTraceOptions,
  type AgentTraceSummary,
  type CostEstimate,
  type HierarchicalAgentTrace
} from "./agent-trace.js";
import { createRedactionPolicy, type RedactionPolicy, type RedactionPolicyOptions } from "./safety-policy.js";
import { createAgentAuditRecord, createToolAuditRecords, type AgentAuditRecord, type AgentAuditRecordOptions, type ToolAuditRecord, type ToolAuditRecordOptions } from "./production-agent-kit.js";
import { inspectProviderAgentSupport, type ProviderAgentSupport } from "./provider-parity.js";
import { createRunner, type RunnerRunInput, type RunnerRunOutput, type RunnerStreamResult, type SessionService } from "./runner.js";
import { toToolSet } from "./tool-registry.js";
import { ValidationError } from "./errors.js";
import type {
  AgentApprovalRequest,
  AgentDefinition,
  AgentExecutionEnvironmentManifest,
  AgentRunCancellationOptions,
  AgentRunInput,
  AgentRunOutput,
  AgentRunState,
  AgentRunTreeCancellationResult,
  AgentStreamResult,
  AnyToolDefinition,
  JsonValue,
  LanguageModel,
  ToolApprovalDecision,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolCollection
} from "./types.js";

export const AGENT_CONTROL_PLANE_SCHEMA_VERSION = 1 as const;
export type AgentControlPlaneMigrationTarget = typeof AGENT_CONTROL_PLANE_SCHEMA_VERSION;

export type AgentToolRiskLevel = "low" | "medium" | "high" | "critical";
export type AgentToolPermission =
  | "read"
  | "write"
  | "network"
  | "filesystem"
  | "code-execution"
  | "shell"
  | "external-side-effect";

export type AgentToolPolicyMode = "allow-all" | "read-only" | "deny-write" | "supervised";

export interface AgentCapsuleSkillManifest {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  path?: string;
  metadata?: Record<string, JsonValue>;
}

export interface AgentCapsuleMcpServerManifest {
  name: string;
  transport: "stdio" | "http" | "sse" | "custom";
  command?: string;
  url?: string;
  permissions?: AgentToolPermission[];
  riskLevel?: AgentToolRiskLevel;
  metadata?: Record<string, JsonValue>;
}

export interface AgentCapsuleEvaluationManifest {
  name: string;
  path?: string;
  datasetSize?: number;
  metadata?: Record<string, JsonValue>;
}

export interface AgentCapsulePolicyManifest {
  toolPolicyMode?: AgentToolPolicyMode;
  defaultRequiresApproval?: boolean;
  redaction?: boolean;
  metadata?: Record<string, JsonValue>;
}

export interface AgentCapsuleToolManifest {
  name: string;
  kind: "callable" | "hosted";
  provider?: string;
  hostedType?: string;
  source: string;
  permissions: AgentToolPermission[];
  riskLevel?: AgentToolRiskLevel;
  owner?: string;
  labels: string[];
  requiresApproval: boolean;
  approvalVersion?: string;
  description?: string;
}

export interface AgentCapsuleManifest {
  schemaVersion: typeof AGENT_CONTROL_PLANE_SCHEMA_VERSION;
  id: string;
  fingerprint: string;
  name: string;
  version: string;
  description?: string;
  provider: string;
  modelId: string;
  agentTier: ProviderAgentSupport["agentTier"];
  tools: AgentCapsuleToolManifest[];
  skills: AgentCapsuleSkillManifest[];
  mcpServers: AgentCapsuleMcpServerManifest[];
  evaluations: AgentCapsuleEvaluationManifest[];
  policy?: AgentCapsulePolicyManifest;
  executionEnvironment?: AgentExecutionEnvironmentManifest;
  metadata?: Record<string, JsonValue>;
}

export interface AgentCapsule<TAgent extends AgentDefinition = AgentDefinition> {
  manifest: AgentCapsuleManifest;
  agent: TAgent;
  providerSupport: ProviderAgentSupport;
}

export interface CreateAgentCapsuleOptions<TAgent extends AgentDefinition = AgentDefinition> {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  agent: TAgent;
  tools?: ToolCollection;
  skills?: AgentCapsuleSkillManifest[];
  mcpServers?: AgentCapsuleMcpServerManifest[];
  evaluations?: AgentCapsuleEvaluationManifest[];
  policy?: AgentCapsulePolicyManifest;
  metadata?: Record<string, JsonValue>;
}

export interface AgentCapsuleInspection {
  ok: boolean;
  capsuleId: string;
  provider: string;
  modelId: string;
  agentTier: ProviderAgentSupport["agentTier"];
  toolCount: number;
  approvalToolCount: number;
  highRiskToolCount: number;
  mcpServerCount: number;
  skillCount: number;
  warnings: string[];
}

export interface AgentToolPolicyOptions {
  mode?: AgentToolPolicyMode;
  allowToolNames?: string[];
  denyToolNames?: string[];
  allowPermissions?: AgentToolPermission[];
  denyPermissions?: AgentToolPermission[];
  denyRiskLevels?: AgentToolRiskLevel[];
}

export interface AgentApprovalQueueOptions {
  resumeUrl?: string | ((request: AgentApprovalRequest, state: AgentRunState) => string);
  tokenPrefix?: string;
  expiresAt?: number | ((request: AgentApprovalRequest, state: AgentRunState) => number | undefined);
  reason?: string | ((request: AgentApprovalRequest, state: AgentRunState) => string | undefined);
  /** Approval arguments are omitted unless explicitly requested. */
  includeArguments?: boolean;
  /** Provider payloads are omitted unless explicitly requested. */
  includeRawData?: boolean;
  /** Explicitly pass false only for a trusted, non-production boundary. */
  redaction?: RedactionPolicy | RedactionPolicyOptions | false;
}

export interface AgentApprovalQueueItem {
  schemaVersion: typeof AGENT_CONTROL_PLANE_SCHEMA_VERSION;
  type: "agent_approval_queue_item";
  runId: string;
  agentId?: string;
  kind: NonNullable<AgentApprovalRequest["kind"]>;
  provider: string;
  approvalRequestId: string;
  name: string;
  /** Digest of the complete pending request, including fields omitted from this projection. */
  requestFingerprint: string;
  arguments?: string;
  approvalToken: string;
  resumeUrl?: string;
  reason?: string;
  expiresAt?: number;
  rawData?: JsonValue;
}

export interface AgentRunLedgerOptions extends AgentAuditRecordOptions, ToolAuditRecordOptions {
  includeTimeline?: boolean;
  pricing?: AgentRunCostPricing;
  trace?: AgentTraceOptions;
}

const resolveLedgerRedaction = (
  redaction: RedactionPolicy | RedactionPolicyOptions | false | undefined
): RedactionPolicy | undefined => {
  if (redaction === false) {
    return undefined;
  }
  if (redaction && "redactJson" in redaction && typeof redaction.redactJson === "function") {
    return redaction;
  }
  return createRedactionPolicy(redaction ?? { includeEmails: true });
};

const sanitizeLedgerValue = (
  value: unknown,
  options: {
    includeMessages: boolean;
    includeToolInputs: boolean;
    includeToolOutputs: boolean;
    includeApprovalArguments: boolean;
    includeOutputText: boolean;
  },
  redaction?: RedactionPolicy
): JsonValue => {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLedgerValue(entry, options, redaction));
  }
  if (value && typeof value === "object") {
    const sanitized = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        if (!options.includeMessages && (key === "messages" || key === "contextMessages")) {
          return [key, []];
        }
        if (!options.includeToolInputs && key === "input") {
          return [key, null];
        }
        if (!options.includeToolOutputs && key === "output") {
          return [key, null];
        }
        if (!options.includeApprovalArguments && key === "arguments") {
          return [key, "[REDACTED]"];
        }
        if (!options.includeApprovalArguments && key === "rawData") {
          return [key, null];
        }
        if (!options.includeOutputText && key === "outputText") {
          return [key, "[REDACTED]"];
        }
        return [key, sanitizeLedgerValue(entry, options, redaction)];
      })
    ) as JsonValue;
    return redaction ? redaction.redactJson(sanitized) : sanitized;
  }
  return redaction && typeof value === "string" ? redaction.redactText(value) : value as JsonValue;
};

export interface AgentRunLedger {
  schemaVersion: typeof AGENT_CONTROL_PLANE_SCHEMA_VERSION;
  type: "agent_run_ledger";
  runId: string;
  agentId?: string;
  provider: string;
  modelId: string;
  status: AgentRunState["status"];
  snapshot: AgentRunSnapshot;
  audit: AgentAuditRecord;
  toolAudit: ToolAuditRecord[];
  timeline?: AgentReplayResult["timeline"];
  trace: AgentTraceArtifact;
  summary: AgentTraceSummary;
  cost?: CostEstimate;
  metadata?: Record<string, JsonValue>;
}

export interface AgentRunLedgerDiffChange {
  field: string;
  left: JsonValue | undefined;
  right: JsonValue | undefined;
}

export interface AgentRunLedgerDiff {
  ok: boolean;
  leftRunId: string;
  rightRunId: string;
  changes: AgentRunLedgerDiffChange[];
}

export interface AgentGoldenTrace {
  schemaVersion: typeof AGENT_CONTROL_PLANE_SCHEMA_VERSION;
  type: "agent_golden_trace";
  name: string;
  ledger: AgentRunLedger;
  expectations: {
    status: AgentRunState["status"];
    outputText?: string;
    toolCalls: string[];
    approvals: number;
  };
  metadata?: Record<string, JsonValue>;
}

export interface AgentCapabilityRequirements {
  allowedProviders?: string[];
  excludedProviders?: string[];
  minTier?: ProviderAgentSupport["agentTier"];
  tools?: boolean;
  approvals?: boolean;
  hostedTools?: boolean;
  remoteMcp?: boolean;
  codeExecution?: boolean;
  shell?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  streaming?: boolean;
  webSearch?: boolean;
  realtime?: boolean;
}

export type AgentModelCandidate =
  | LanguageModel
  | {
      id?: string;
      label?: string;
      model: LanguageModel;
      metadata?: Record<string, JsonValue>;
    };

export interface AgentModelSelection {
  model: LanguageModel;
  support: ProviderAgentSupport;
  score: number;
  reasons: string[];
}

export interface AgentCapabilityRouter {
  select(requirements?: AgentCapabilityRequirements): AgentModelSelection;
  inspect(): ProviderAgentSupport[];
}

export interface AgentControlPlaneOptions<TModel extends LanguageModel = LanguageModel> {
  appName?: string;
  agent: AgentDefinition<TModel>;
  sessionService?: SessionService;
  pricing?: AgentRunCostPricing;
  trace?: AgentTraceOptions;
  audit?: AgentAuditRecordOptions & ToolAuditRecordOptions;
}

export type AgentControlPlaneRunInput<TModel extends LanguageModel = LanguageModel> =
  AgentRunInput<TModel> & {
    userId?: string;
    sessionId?: string;
    sessionMetadata?: Record<string, JsonValue>;
    eventMetadata?: Record<string, JsonValue>;
  };

export interface AgentControlPlaneRunRecord {
  state: AgentRunState;
  ledger: AgentRunLedger;
  trace: AgentTraceArtifact;
  summary: AgentTraceSummary;
  audit: AgentAuditRecord;
  toolAudit: ToolAuditRecord[];
  session?: RunnerRunOutput["session"];
}

export type AgentControlPlaneApprovalResumeInput<TModel extends LanguageModel = LanguageModel> =
  Omit<
    AgentRunInput<TModel>,
    "state" | "approvals" | "runId" | "idempotencyKey" | "prompt" | "messages" | "system" | "handoff" | "parentRunId"
  > & {
    /** Trusted server-side queue record; do not accept this object from the token presenter. */
    queueItem: AgentApprovalQueueItem;
    /** Bearer token presented by the approver and compared against the trusted queue record. */
    approvalToken: string;
    approve: boolean;
    reason?: string;
    /** Injectable clock for deterministic expiry enforcement. */
    now?: number;
  };

export interface AgentControlPlaneInspection {
  provider: ProviderAgentSupport;
  capsule: AgentCapsuleInspection;
}

export interface AgentControlPlane<TModel extends LanguageModel = LanguageModel> {
  run(input?: AgentControlPlaneRunInput<TModel>): Promise<AgentControlPlaneRunRecord>;
  resume(input: AgentControlPlaneRunInput<TModel> & { state: AgentRunState }): Promise<AgentControlPlaneRunRecord>;
  /** Atomically consumes a persisted pending approval and resumes its durable run. */
  resumeApproval(input: AgentControlPlaneApprovalResumeInput<TModel>): Promise<AgentControlPlaneRunRecord>;
  stream(input?: AgentControlPlaneRunInput<TModel>): AgentStreamResult | RunnerStreamResult;
  getRun(runId: string): Promise<AgentRunState | undefined>;
  getTrace(runId: string): Promise<AgentTraceArtifact | undefined>;
  getRunTree(runId: string): Promise<HierarchicalAgentTrace | undefined>;
  cancel(runId: string, options?: AgentRunCancellationOptions): Promise<AgentRunState | undefined>;
  cancelTree(runId: string, options?: AgentRunCancellationOptions): Promise<AgentRunTreeCancellationResult>;
  inspect(): AgentControlPlaneInspection;
}

const tierRank: Record<ProviderAgentSupport["agentTier"], number> = {
  "tier-a": 3,
  "tier-b": 2,
  "tier-c": 1
};

const writePermissions = new Set<AgentToolPermission>([
  "write",
  "filesystem",
  "code-execution",
  "shell",
  "external-side-effect"
]);
const supervisedPermissions = new Set<AgentToolPermission>([
  ...writePermissions,
  "network"
]);
const allToolPermissions = new Set<AgentToolPermission>([
  "read",
  "write",
  "network",
  "filesystem",
  "code-execution",
  "shell",
  "external-side-effect"
]);
const allToolRiskLevels = new Set<AgentToolRiskLevel>(["low", "medium", "high", "critical"]);
const allToolPolicyModes = new Set<AgentToolPolicyMode>(["allow-all", "read-only", "deny-write", "supervised"]);
const allAgentTiers = new Set<ProviderAgentSupport["agentTier"]>(["tier-a", "tier-b", "tier-c"]);
const allAgentStatuses = new Set<AgentRunState["status"]>([
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
const allApprovalKinds = new Set<NonNullable<AgentApprovalRequest["kind"]>>([
  "provider",
  "local-tool",
  "subagent"
]);

const controlPlaneRecord = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const controlPlaneString = (value: unknown, name: string, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new ValidationError(`${name} must be a${allowEmpty ? "" : " non-empty"} string.`);
  }
  return value;
};

const controlPlaneOptionalString = (value: unknown, name: string, allowEmpty = false): string | undefined =>
  value === undefined ? undefined : controlPlaneString(value, name, allowEmpty);

const controlPlaneFiniteNumber = (value: unknown, name: string, minimum = 0): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new ValidationError(`${name} must be a finite number greater than or equal to ${minimum}.`);
  }
  return value;
};

const cloneControlPlaneJson = <T>(value: T, name: string): T => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("undefined is not JSON");
    }
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new ValidationError(`${name} must be finite JSON.`, { cause: error });
  }
};

const cloneControlPlaneMetadata = (
  value: unknown,
  name: string
): Record<string, JsonValue> | undefined => {
  if (value === undefined) {
    return undefined;
  }
  controlPlaneRecord(value, name);
  return cloneControlPlaneJson(value as Record<string, JsonValue>, name);
};

const normalizeControlPlaneSchemaVersion = (value: unknown, name: string): void => {
  if (value === undefined) {
    return;
  }
  if (value !== AGENT_CONTROL_PLANE_SCHEMA_VERSION) {
    if (typeof value === "number" && value > AGENT_CONTROL_PLANE_SCHEMA_VERSION) {
      throw new ValidationError(`Unsupported ${name} schemaVersion ${value}.`);
    }
    throw new ValidationError(
      `${name} schemaVersion must be ${AGENT_CONTROL_PLANE_SCHEMA_VERSION}; only records without schemaVersion are treated as legacy.`
    );
  }
};

const normalizeStringList = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${name} must be an array.`);
  }
  return value.map((entry, index) => controlPlaneString(entry, `${name}[${index}]`));
};

const normalizePermissionList = (value: unknown, name: string): AgentToolPermission[] => {
  const permissions = normalizeStringList(value, name);
  for (const permission of permissions) {
    if (!allToolPermissions.has(permission as AgentToolPermission)) {
      throw new ValidationError(`${name} contains unsupported permission "${permission}".`);
    }
  }
  return [...new Set(permissions as AgentToolPermission[])].sort();
};

const approvalRequestFingerprint = (approval: AgentApprovalRequest): string =>
  fingerprintAgentHarness({
    kind: approval.kind ?? "provider",
    provider: approval.provider,
    id: approval.id,
    name: approval.name,
    arguments: approval.arguments,
    serverLabel: approval.serverLabel,
    toolCallId: approval.toolCallId,
    step: approval.step,
    inputDigest: approval.inputDigest,
    toolVersion: approval.toolVersion,
    signature: approval.signature,
    childRunId: approval.childRunId,
    childAgentId: approval.childAgentId,
    childApprovalRequestId: approval.childApprovalRequestId,
    rawData: approval.rawData
  });

const legacyApprovalRequestFingerprint = (approval: AgentApprovalRequest): string =>
  fingerprintAgentHarness({
    provider: approval.provider,
    id: approval.id,
    name: approval.name,
    arguments: approval.arguments,
    rawData: approval.rawData
  });

const assertControlPlaneMigrationTarget = (targetVersion: AgentControlPlaneMigrationTarget, name: string) => {
  if (targetVersion !== AGENT_CONTROL_PLANE_SCHEMA_VERSION) {
    throw new ValidationError(`Unsupported ${name} migration target ${targetVersion}.`);
  }
};

const normalizeNames = (names: string[] | undefined) => new Set((names ?? []).map((name) => name.toLowerCase()));
const normalizePermissions = (permissions: AgentToolPermission[] | undefined) => new Set(permissions ?? []);
const normalizeRiskLevels = (levels: AgentToolRiskLevel[] | undefined) => new Set(levels ?? []);

const readAdvancedMetadata = (tool: AnyToolDefinition): Record<string, JsonValue> => {
  const metadata = tool.metadata?.advancedRegistry;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, JsonValue>
    : {};
};

const toolPermissions = (tool: AnyToolDefinition): AgentToolPermission[] => {
  const permissions = readAdvancedMetadata(tool).permissions;
  return permissions === undefined
    ? []
    : normalizePermissionList(permissions, `Tool "${tool.name}" permissions`);
};

const toolAudit = (tool: AnyToolDefinition): Record<string, JsonValue> => {
  const audit = readAdvancedMetadata(tool).audit;
  return audit && typeof audit === "object" && !Array.isArray(audit)
    ? audit as Record<string, JsonValue>
    : {};
};

const toolSource = (tool: AnyToolDefinition): string => {
  const source = readAdvancedMetadata(tool).source;
  if (typeof source === "string") {
    return source;
  }
  return "kind" in tool && tool.kind === "hosted" ? "hosted" : "local";
};

const hasWritePermission = (permissions: readonly AgentToolPermission[]) =>
  permissions.some((permission) => writePermissions.has(permission));

const toolRiskLevel = (tool: AnyToolDefinition): AgentToolRiskLevel | undefined => {
  const riskLevel = toolAudit(tool).riskLevel;
  return riskLevel === "low" || riskLevel === "medium" || riskLevel === "high" || riskLevel === "critical"
    ? riskLevel
    : undefined;
};

const toJsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const toOptionalJsonValue = (value: unknown): JsonValue | undefined =>
  value === undefined ? undefined : toJsonValue(value);

const validateCapsuleId = (id: string) => {
  if (!/^[a-zA-Z0-9._:-]+$/.test(id)) {
    throw new ValidationError('Agent capsule "id" may only contain letters, numbers, dots, colons, underscores, and hyphens.');
  }
};

const normalizeCapsuleSkill = (value: unknown, index: number): AgentCapsuleSkillManifest => {
  const name = `AgentCapsuleManifest.skills[${index}]`;
  const skill = controlPlaneRecord(value, name);
  return {
    id: controlPlaneString(skill.id, `${name}.id`),
    name: controlPlaneOptionalString(skill.name, `${name}.name`),
    version: controlPlaneOptionalString(skill.version, `${name}.version`),
    description: controlPlaneOptionalString(skill.description, `${name}.description`, true),
    path: controlPlaneOptionalString(skill.path, `${name}.path`),
    metadata: cloneControlPlaneMetadata(skill.metadata, `${name}.metadata`)
  };
};

const normalizeCapsuleMcpServer = (value: unknown, index: number): AgentCapsuleMcpServerManifest => {
  const name = `AgentCapsuleManifest.mcpServers[${index}]`;
  const server = controlPlaneRecord(value, name);
  if (server.transport !== "stdio" && server.transport !== "http" && server.transport !== "sse" && server.transport !== "custom") {
    throw new ValidationError(`${name}.transport is not supported.`);
  }
  if (server.riskLevel !== undefined && !allToolRiskLevels.has(server.riskLevel as AgentToolRiskLevel)) {
    throw new ValidationError(`${name}.riskLevel is not supported.`);
  }
  return {
    name: controlPlaneString(server.name, `${name}.name`),
    transport: server.transport,
    command: controlPlaneOptionalString(server.command, `${name}.command`),
    url: controlPlaneOptionalString(server.url, `${name}.url`),
    permissions: server.permissions === undefined
      ? undefined
      : normalizePermissionList(server.permissions, `${name}.permissions`),
    riskLevel: server.riskLevel as AgentToolRiskLevel | undefined,
    metadata: cloneControlPlaneMetadata(server.metadata, `${name}.metadata`)
  };
};

const normalizeCapsuleEvaluation = (value: unknown, index: number): AgentCapsuleEvaluationManifest => {
  const name = `AgentCapsuleManifest.evaluations[${index}]`;
  const evaluation = controlPlaneRecord(value, name);
  const datasetSize = evaluation.datasetSize === undefined
    ? undefined
    : controlPlaneFiniteNumber(evaluation.datasetSize, `${name}.datasetSize`);
  if (datasetSize !== undefined && !Number.isSafeInteger(datasetSize)) {
    throw new ValidationError(`${name}.datasetSize must be a safe integer.`);
  }
  return {
    name: controlPlaneString(evaluation.name, `${name}.name`),
    path: controlPlaneOptionalString(evaluation.path, `${name}.path`),
    datasetSize,
    metadata: cloneControlPlaneMetadata(evaluation.metadata, `${name}.metadata`)
  };
};

const normalizeCapsulePolicy = (value: unknown): AgentCapsulePolicyManifest | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const policy = controlPlaneRecord(value, "AgentCapsuleManifest.policy");
  if (policy.toolPolicyMode !== undefined && !allToolPolicyModes.has(policy.toolPolicyMode as AgentToolPolicyMode)) {
    throw new ValidationError("AgentCapsuleManifest.policy.toolPolicyMode is not supported.");
  }
  if (policy.defaultRequiresApproval !== undefined && typeof policy.defaultRequiresApproval !== "boolean") {
    throw new ValidationError("AgentCapsuleManifest.policy.defaultRequiresApproval must be a boolean.");
  }
  if (policy.redaction !== undefined && typeof policy.redaction !== "boolean") {
    throw new ValidationError("AgentCapsuleManifest.policy.redaction must be a boolean.");
  }
  return {
    toolPolicyMode: policy.toolPolicyMode as AgentToolPolicyMode | undefined,
    defaultRequiresApproval: policy.defaultRequiresApproval as boolean | undefined,
    redaction: policy.redaction as boolean | undefined,
    metadata: cloneControlPlaneMetadata(policy.metadata, "AgentCapsuleManifest.policy.metadata")
  };
};

const normalizeCapsuleTool = (value: unknown, index: number): AgentCapsuleToolManifest => {
  const name = `AgentCapsuleManifest.tools[${index}]`;
  const toolManifest = controlPlaneRecord(value, name);
  if (toolManifest.kind !== "callable" && toolManifest.kind !== "hosted") {
    throw new ValidationError(`${name}.kind is not supported.`);
  }
  if (toolManifest.riskLevel !== undefined && !allToolRiskLevels.has(toolManifest.riskLevel as AgentToolRiskLevel)) {
    throw new ValidationError(`${name}.riskLevel is not supported.`);
  }
  if (typeof toolManifest.requiresApproval !== "boolean") {
    throw new ValidationError(`${name}.requiresApproval must be a boolean.`);
  }
  return {
    name: controlPlaneString(toolManifest.name, `${name}.name`),
    kind: toolManifest.kind,
    provider: controlPlaneOptionalString(toolManifest.provider, `${name}.provider`),
    hostedType: controlPlaneOptionalString(toolManifest.hostedType, `${name}.hostedType`),
    source: controlPlaneString(toolManifest.source, `${name}.source`),
    permissions: normalizePermissionList(toolManifest.permissions, `${name}.permissions`),
    riskLevel: toolManifest.riskLevel as AgentToolRiskLevel | undefined,
    owner: controlPlaneOptionalString(toolManifest.owner, `${name}.owner`),
    labels: [...new Set(normalizeStringList(toolManifest.labels, `${name}.labels`))].sort(),
    requiresApproval: toolManifest.requiresApproval,
    approvalVersion: controlPlaneOptionalString(toolManifest.approvalVersion, `${name}.approvalVersion`),
    description: controlPlaneOptionalString(toolManifest.description, `${name}.description`, true)
  };
};

export const normalizeAgentCapsuleManifest = (value: unknown): AgentCapsuleManifest => {
  const input = controlPlaneRecord(value, "AgentCapsuleManifest");
  normalizeControlPlaneSchemaVersion(input.schemaVersion, "AgentCapsuleManifest");
  const id = controlPlaneString(input.id, "AgentCapsuleManifest.id");
  validateCapsuleId(id);
  if (!allAgentTiers.has(input.agentTier as ProviderAgentSupport["agentTier"])) {
    throw new ValidationError("AgentCapsuleManifest.agentTier is not supported.");
  }
  if (!Array.isArray(input.tools) || !Array.isArray(input.skills) || !Array.isArray(input.mcpServers) || !Array.isArray(input.evaluations)) {
    throw new ValidationError("AgentCapsuleManifest tool, skill, MCP server, and evaluation collections must be arrays.");
  }
  const executionEnvironment = input.executionEnvironment === undefined
    ? undefined
    : cloneControlPlaneJson(
        controlPlaneRecord(input.executionEnvironment, "AgentCapsuleManifest.executionEnvironment") as unknown as AgentExecutionEnvironmentManifest,
        "AgentCapsuleManifest.executionEnvironment"
      );
  if (executionEnvironment) {
    createAgentExecutionEnvironmentBinding(executionEnvironment);
  }
  const manifestWithoutFingerprint = {
    schemaVersion: AGENT_CONTROL_PLANE_SCHEMA_VERSION,
    id,
    name: controlPlaneString(input.name, "AgentCapsuleManifest.name"),
    version: controlPlaneString(input.version, "AgentCapsuleManifest.version"),
    description: controlPlaneOptionalString(input.description, "AgentCapsuleManifest.description", true),
    provider: controlPlaneString(input.provider, "AgentCapsuleManifest.provider"),
    modelId: controlPlaneString(input.modelId, "AgentCapsuleManifest.modelId"),
    agentTier: input.agentTier as ProviderAgentSupport["agentTier"],
    tools: input.tools.map(normalizeCapsuleTool).sort((left, right) => left.name.localeCompare(right.name)),
    skills: input.skills.map(normalizeCapsuleSkill).sort((left, right) => left.id.localeCompare(right.id)),
    mcpServers: input.mcpServers.map(normalizeCapsuleMcpServer).sort((left, right) => left.name.localeCompare(right.name)),
    evaluations: input.evaluations.map(normalizeCapsuleEvaluation).sort((left, right) => left.name.localeCompare(right.name)),
    policy: normalizeCapsulePolicy(input.policy),
    executionEnvironment,
    metadata: cloneControlPlaneMetadata(input.metadata, "AgentCapsuleManifest.metadata")
  } satisfies Omit<AgentCapsuleManifest, "fingerprint">;
  const fingerprint = controlPlaneString(input.fingerprint, "AgentCapsuleManifest.fingerprint");
  const expectedFingerprint = createAgentHarnessBinding({
    id,
    version: manifestWithoutFingerprint.version,
    manifest: manifestWithoutFingerprint
  }).fingerprint;
  if (fingerprint !== expectedFingerprint) {
    throw new ValidationError("AgentCapsuleManifest fingerprint does not match its normalized contract.");
  }
  return {
    ...manifestWithoutFingerprint,
    fingerprint
  };
};

export const migrateAgentCapsuleManifest = (
  value: unknown,
  targetVersion: AgentControlPlaneMigrationTarget = AGENT_CONTROL_PLANE_SCHEMA_VERSION
): AgentCapsuleManifest => {
  assertControlPlaneMigrationTarget(targetVersion, "AgentCapsuleManifest");
  return normalizeAgentCapsuleManifest(value);
};

const inspectTools = (tools: ToolCollection | undefined): AgentCapsuleToolManifest[] => {
  const toolSet = toToolSet(tools);
  if (!toolSet) {
    return [];
  }

  return Object.values(toolSet).map((toolDefinition) => {
    const audit = toolAudit(toolDefinition);
    const isHosted = "kind" in toolDefinition && toolDefinition.kind === "hosted";
    return {
      name: toolDefinition.name,
      kind: isHosted ? "hosted" as const : "callable" as const,
      provider: isHosted ? toolDefinition.provider : undefined,
      hostedType: isHosted ? toolDefinition.type : undefined,
      source: toolSource(toolDefinition),
      permissions: [...toolPermissions(toolDefinition)].sort(),
      riskLevel: toolRiskLevel(toolDefinition),
      owner: typeof audit.owner === "string" ? audit.owner : undefined,
      labels: Array.isArray(audit.labels)
        ? audit.labels.filter((label): label is string => typeof label === "string").sort()
        : [],
      requiresApproval: Boolean(toolDefinition.requiresApproval),
      approvalVersion: "approvalVersion" in toolDefinition ? toolDefinition.approvalVersion : undefined,
      description: "description" in toolDefinition ? toolDefinition.description : undefined
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
};

export const createAgentCapsule = <TAgent extends AgentDefinition>(
  options: CreateAgentCapsuleOptions<TAgent>
): AgentCapsule<TAgent> => {
  const id = options.id ?? options.agent.id ?? options.name ?? "agent";
  validateCapsuleId(id);

  const providerSupport = inspectProviderAgentSupport(options.agent.model);
  const tools = inspectTools(options.tools ?? options.agent.tools);

  const manifestWithoutFingerprint = {
      schemaVersion: AGENT_CONTROL_PLANE_SCHEMA_VERSION,
      id,
      name: options.name ?? id,
      version: options.version ?? "0.0.0",
      description: options.description,
      provider: options.agent.model.provider,
      modelId: options.agent.model.modelId,
      agentTier: providerSupport.agentTier,
      tools,
      skills: [...(options.skills ?? [])].sort((left, right) => left.id.localeCompare(right.id)),
      mcpServers: [...(options.mcpServers ?? [])]
        .map((server) => ({
          ...server,
          permissions: server.permissions ? [...server.permissions].sort() : undefined
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      evaluations: [...(options.evaluations ?? [])].sort((left, right) => left.name.localeCompare(right.name)),
      policy: options.policy,
      executionEnvironment: options.agent.executionEnvironment?.manifest,
      metadata: options.metadata
    } satisfies Omit<AgentCapsuleManifest, "fingerprint">;
  const harness = createAgentHarnessBinding({
    id,
    version: manifestWithoutFingerprint.version,
    manifest: manifestWithoutFingerprint
  });
  const manifest = normalizeAgentCapsuleManifest({
    ...manifestWithoutFingerprint,
    fingerprint: harness.fingerprint
  } satisfies AgentCapsuleManifest);

  return {
    manifest,
    agent: {
      ...options.agent,
      harness
    } as TAgent,
    providerSupport
  };
};

export const inspectAgentCapsule = (capsule: AgentCapsule): AgentCapsuleInspection => {
  const warnings: string[] = [];
  const tools = capsule.manifest.tools;
  const highRiskToolCount = tools.filter((entry) => entry.riskLevel === "high" || entry.riskLevel === "critical").length;
  const approvalToolCount = tools.filter((entry) => entry.requiresApproval).length;

  for (const toolManifest of tools) {
    if ((hasWritePermission(toolManifest.permissions) || toolManifest.riskLevel === "critical") && !toolManifest.requiresApproval) {
      warnings.push(`Tool "${toolManifest.name}" has write or critical risk without approval.`);
    }
    if (!toolManifest.permissions.length && !toolManifest.requiresApproval) {
      warnings.push(`Tool "${toolManifest.name}" does not declare permissions and has no approval requirement.`);
    }
  }

  if (capsule.providerSupport.agentTier === "tier-c") {
    warnings.push(`Model "${capsule.manifest.modelId}" is Tier C for agent workloads.`);
  }

  for (const server of capsule.manifest.mcpServers) {
    if ((server.riskLevel === "high" || server.riskLevel === "critical") && !server.permissions?.length) {
      warnings.push(`MCP server "${server.name}" is high risk but has no declared permissions.`);
    }
  }

  return {
    ok: warnings.length === 0,
    capsuleId: capsule.manifest.id,
    provider: capsule.manifest.provider,
    modelId: capsule.manifest.modelId,
    agentTier: capsule.manifest.agentTier,
    toolCount: tools.length,
    approvalToolCount,
    highRiskToolCount,
    mcpServerCount: capsule.manifest.mcpServers.length,
    skillCount: capsule.manifest.skills.length,
    warnings
  };
};

const requestPermissions = (request: ToolApprovalRequest): AgentToolPermission[] => {
  const permissions = request.tool.metadata?.advancedRegistry;
  const value = permissions && typeof permissions === "object" && !Array.isArray(permissions)
    ? (permissions as Record<string, JsonValue>).permissions
    : undefined;
  return value === undefined
    ? []
    : normalizePermissionList(value, `Tool "${request.tool.name}" permissions`);
};

const requestRiskLevel = (request: ToolApprovalRequest): AgentToolRiskLevel | undefined => {
  const advanced = request.tool.metadata?.advancedRegistry;
  const audit = advanced && typeof advanced === "object" && !Array.isArray(advanced)
    ? (advanced as Record<string, JsonValue>).audit
    : undefined;
  const riskLevel = audit && typeof audit === "object" && !Array.isArray(audit)
    ? (audit as Record<string, JsonValue>).riskLevel
    : undefined;
  return riskLevel === "low" || riskLevel === "medium" || riskLevel === "high" || riskLevel === "critical"
    ? riskLevel
    : undefined;
};

const decision = (approved: boolean, reason: string, mode: AgentToolPolicyMode): ToolApprovalDecision => ({
  approved,
  reason,
  metadata: { policy: "agent-control-plane", mode }
});

const approvalRequiredDecision = (reason: string, mode: AgentToolPolicyMode): ToolApprovalDecision => ({
  approved: false,
  approvalRequired: true,
  reason,
  metadata: { policy: "agent-control-plane", mode }
});

export const createAgentToolPolicy = (options: AgentToolPolicyOptions = {}): ToolApprovalPolicy => {
  const mode = options.mode ?? "supervised";
  const allowNames = normalizeNames(options.allowToolNames);
  const denyNames = normalizeNames(options.denyToolNames);
  const allowPermissions = normalizePermissions(options.allowPermissions);
  const denyPermissions = normalizePermissions(options.denyPermissions);
  const denyRiskLevels = normalizeRiskLevels(options.denyRiskLevels ?? (mode === "supervised" ? ["critical"] : []));

  return (request) => {
    const toolName = request.tool.name.toLowerCase();
    const permissions = requestPermissions(request);
    const riskLevel = requestRiskLevel(request);

    if (denyNames.has(toolName)) {
      return decision(false, `Tool "${request.tool.name}" is denied by policy.`, mode);
    }

    if (riskLevel && denyRiskLevels.has(riskLevel)) {
      return decision(false, `Tool "${request.tool.name}" has denied risk level "${riskLevel}".`, mode);
    }

    if (permissions.some((permission) => denyPermissions.has(permission))) {
      return decision(false, `Tool "${request.tool.name}" requests denied permissions.`, mode);
    }

    if (allowNames.has(toolName)) {
      return { approved: true, metadata: { policy: "agent-control-plane", mode } };
    }

    if (mode === "allow-all") {
      return { approved: true, metadata: { policy: "agent-control-plane", mode } };
    }

    if (mode === "read-only") {
      const isReadOnly =
        permissions.length > 0 &&
        permissions.every((permission) => permission === "read" || allowPermissions.has(permission));
      return isReadOnly && !hasWritePermission(permissions)
        ? { approved: true, metadata: { policy: "agent-control-plane", mode } }
        : decision(
            false,
            permissions.length === 0
              ? `Tool "${request.tool.name}" does not declare permissions and cannot be treated as read-only.`
              : `Tool "${request.tool.name}" is not read-only.`,
            mode
          );
    }

    if (mode === "deny-write" && hasWritePermission(permissions)) {
      return decision(false, `Tool "${request.tool.name}" requests write permissions.`, mode);
    }

    if (mode === "supervised") {
      if (request.tool.requiresApproval) {
        return approvalRequiredDecision(`Tool "${request.tool.name}" requires explicit approval.`, mode);
      }
      if (riskLevel === "high" || riskLevel === "critical") {
        return approvalRequiredDecision(
          `Tool "${request.tool.name}" requires approval for risk level "${riskLevel}".`,
          mode
        );
      }
      if (permissions.some((permission) => supervisedPermissions.has(permission) && !allowPermissions.has(permission))) {
        return approvalRequiredDecision(`Tool "${request.tool.name}" requests sensitive permissions.`, mode);
      }
      if (permissions.length === 0) {
        return approvalRequiredDecision(
          `Tool "${request.tool.name}" does not declare permissions and requires approval under supervised policy.`,
          mode
        );
      }
    }

    return { approved: true, metadata: { policy: "agent-control-plane", mode } };
  };
};

export const normalizeAgentApprovalQueueItem = (value: unknown): AgentApprovalQueueItem => {
  const input = controlPlaneRecord(value, "AgentApprovalQueueItem");
  const legacy = input.schemaVersion === undefined;
  const legacyShape = input.kind === undefined && input.requestFingerprint === undefined;
  normalizeControlPlaneSchemaVersion(input.schemaVersion, "AgentApprovalQueueItem");
  if (input.type !== "agent_approval_queue_item" && !(legacy && input.type === undefined)) {
    throw new ValidationError('AgentApprovalQueueItem.type must be "agent_approval_queue_item".');
  }
  const kind = input.kind === undefined && legacyShape ? "provider" : input.kind;
  if (!allApprovalKinds.has(kind as NonNullable<AgentApprovalRequest["kind"]>)) {
    throw new ValidationError("AgentApprovalQueueItem.kind is not supported.");
  }
  const provider = controlPlaneString(input.provider, "AgentApprovalQueueItem.provider");
  const approvalRequestId = controlPlaneString(
    input.approvalRequestId,
    "AgentApprovalQueueItem.approvalRequestId"
  );
  const name = controlPlaneString(input.name, "AgentApprovalQueueItem.name");
  const approvalToken = controlPlaneString(input.approvalToken, "AgentApprovalQueueItem.approvalToken");
  if (approvalToken.length > 8_192) {
    throw new ValidationError("AgentApprovalQueueItem.approvalToken exceeds the 8192-character limit.");
  }
  const argumentsValue = controlPlaneOptionalString(
    input.arguments,
    "AgentApprovalQueueItem.arguments",
    true
  );
  const rawData = input.rawData === undefined
    ? undefined
    : cloneControlPlaneJson(input.rawData as JsonValue, "AgentApprovalQueueItem.rawData");
  const requestFingerprint = input.requestFingerprint === undefined && legacyShape
    ? legacyApprovalRequestFingerprint({
        kind: "provider",
        provider,
        id: approvalRequestId,
        name,
        arguments: argumentsValue ?? "",
        rawData: rawData ?? null
      })
    : controlPlaneString(input.requestFingerprint, "AgentApprovalQueueItem.requestFingerprint");
  if (!/^sha256:[a-f0-9]{64}$/.test(requestFingerprint)) {
    throw new ValidationError("AgentApprovalQueueItem.requestFingerprint must be a sha256 fingerprint.");
  }
  return {
    schemaVersion: AGENT_CONTROL_PLANE_SCHEMA_VERSION,
    type: "agent_approval_queue_item",
    runId: controlPlaneString(input.runId, "AgentApprovalQueueItem.runId"),
    agentId: controlPlaneOptionalString(input.agentId, "AgentApprovalQueueItem.agentId"),
    kind: kind as NonNullable<AgentApprovalRequest["kind"]>,
    provider,
    approvalRequestId,
    name,
    requestFingerprint,
    arguments: argumentsValue,
    approvalToken,
    resumeUrl: controlPlaneOptionalString(input.resumeUrl, "AgentApprovalQueueItem.resumeUrl"),
    reason: controlPlaneOptionalString(input.reason, "AgentApprovalQueueItem.reason", true),
    expiresAt: input.expiresAt === undefined
      ? undefined
      : controlPlaneFiniteNumber(input.expiresAt, "AgentApprovalQueueItem.expiresAt"),
    rawData
  };
};

export const migrateAgentApprovalQueueItem = (
  value: unknown,
  targetVersion: AgentControlPlaneMigrationTarget = AGENT_CONTROL_PLANE_SCHEMA_VERSION
): AgentApprovalQueueItem => {
  assertControlPlaneMigrationTarget(targetVersion, "AgentApprovalQueueItem");
  return normalizeAgentApprovalQueueItem(value);
};

export const createAgentApprovalQueue = (
  state: AgentRunState,
  options: AgentApprovalQueueOptions = {}
): AgentApprovalQueueItem[] => {
  const redaction = resolveLedgerRedaction(options.redaction);
  return state.pendingApprovals.map((approval) => {
    const reason = typeof options.reason === "function" ? options.reason(approval, state) : options.reason;
    return normalizeAgentApprovalQueueItem({
      schemaVersion: AGENT_CONTROL_PLANE_SCHEMA_VERSION,
      type: "agent_approval_queue_item",
      runId: state.runId,
      agentId: state.agentId,
      kind: approval.kind ?? "provider",
      provider: approval.provider,
      approvalRequestId: approval.id,
      name: approval.name,
      requestFingerprint: approvalRequestFingerprint(approval),
      arguments: options.includeArguments
        ? (redaction ? redaction.redactText(approval.arguments) : approval.arguments)
        : undefined,
      approvalToken: `${options.tokenPrefix ?? "appr"}_${randomBytes(32).toString("base64url")}`,
      resumeUrl: typeof options.resumeUrl === "function" ? options.resumeUrl(approval, state) : options.resumeUrl,
      reason: reason === undefined ? undefined : (redaction ? redaction.redactText(reason) : reason),
      expiresAt: typeof options.expiresAt === "function" ? options.expiresAt(approval, state) : options.expiresAt,
      rawData: options.includeRawData
        ? (redaction ? redaction.redactJson(approval.rawData) : approval.rawData)
        : undefined
    });
  });
};

const assertLedgerIdentity = (
  value: Record<string, unknown>,
  name: string,
  identity: { runId: string; provider: string; modelId: string; status: AgentRunState["status"] }
) => {
  if (
    value.runId !== identity.runId ||
    value.provider !== identity.provider ||
    value.modelId !== identity.modelId ||
    value.status !== identity.status
  ) {
    throw new ValidationError(`${name} identity does not match its AgentRunLedger.`);
  }
};

export const normalizeAgentRunLedger = (value: unknown): AgentRunLedger => {
  const input = controlPlaneRecord(value, "AgentRunLedger");
  const legacy = input.schemaVersion === undefined;
  normalizeControlPlaneSchemaVersion(input.schemaVersion, "AgentRunLedger");
  if (input.type !== "agent_run_ledger" && !(legacy && input.type === undefined)) {
    throw new ValidationError('AgentRunLedger.type must be "agent_run_ledger".');
  }
  const runId = controlPlaneString(input.runId, "AgentRunLedger.runId");
  const provider = controlPlaneString(input.provider, "AgentRunLedger.provider");
  const modelId = controlPlaneString(input.modelId, "AgentRunLedger.modelId");
  if (!allAgentStatuses.has(input.status as AgentRunState["status"])) {
    throw new ValidationError("AgentRunLedger.status is not supported.");
  }
  const status = input.status as AgentRunState["status"];
  const identity = { runId, provider, modelId, status };
  const snapshotRecord = controlPlaneRecord(input.snapshot, "AgentRunLedger.snapshot");
  assertLedgerIdentity(snapshotRecord, "AgentRunLedger.snapshot", identity);
  for (const field of ["toolCalls", "childRuns", "compactions", "pendingApprovals"] as const) {
    if (!Array.isArray(snapshotRecord[field])) {
      throw new ValidationError(`AgentRunLedger.snapshot.${field} must be an array.`);
    }
  }
  controlPlaneFiniteNumber(snapshotRecord.steps, "AgentRunLedger.snapshot.steps");
  controlPlaneString(snapshotRecord.outputText, "AgentRunLedger.snapshot.outputText", true);

  const auditRecord = controlPlaneRecord(input.audit, "AgentRunLedger.audit");
  assertLedgerIdentity(auditRecord, "AgentRunLedger.audit", identity);
  if (auditRecord.type !== "agent_run_audit") {
    throw new ValidationError('AgentRunLedger.audit.type must be "agent_run_audit".');
  }
  for (const field of ["steps", "toolCalls", "toolErrors", "approvals", "childRuns"] as const) {
    controlPlaneFiniteNumber(auditRecord[field], `AgentRunLedger.audit.${field}`);
  }

  if (!Array.isArray(input.toolAudit)) {
    throw new ValidationError("AgentRunLedger.toolAudit must be an array.");
  }
  for (const [index, entry] of input.toolAudit.entries()) {
    const toolAuditRecord = controlPlaneRecord(entry, `AgentRunLedger.toolAudit[${index}]`);
    if (
      toolAuditRecord.type !== "agent_tool_audit" ||
      toolAuditRecord.runId !== runId ||
      toolAuditRecord.provider !== provider ||
      toolAuditRecord.modelId !== modelId
    ) {
      throw new ValidationError(`AgentRunLedger.toolAudit[${index}] identity does not match its ledger.`);
    }
  }

  const traceRecord = controlPlaneRecord(input.trace, "AgentRunLedger.trace");
  assertLedgerIdentity(traceRecord, "AgentRunLedger.trace", identity);
  for (const field of ["steps", "events", "approvals"] as const) {
    if (!Array.isArray(traceRecord[field])) {
      throw new ValidationError(`AgentRunLedger.trace.${field} must be an array.`);
    }
  }

  const summaryRecord = controlPlaneRecord(input.summary, "AgentRunLedger.summary");
  assertLedgerIdentity(summaryRecord, "AgentRunLedger.summary", identity);
  controlPlaneRecord(summaryRecord.latency, "AgentRunLedger.summary.latency");
  for (const field of ["steps", "childRuns", "toolCalls", "toolErrors", "approvals"] as const) {
    controlPlaneFiniteNumber(summaryRecord[field], `AgentRunLedger.summary.${field}`);
  }

  if (input.timeline !== undefined && !Array.isArray(input.timeline)) {
    throw new ValidationError("AgentRunLedger.timeline must be an array.");
  }
  if (input.cost !== undefined) {
    controlPlaneRecord(input.cost, "AgentRunLedger.cost");
  }

  return {
    schemaVersion: AGENT_CONTROL_PLANE_SCHEMA_VERSION,
    type: "agent_run_ledger",
    runId,
    agentId: controlPlaneOptionalString(input.agentId, "AgentRunLedger.agentId"),
    provider,
    modelId,
    status,
    snapshot: cloneControlPlaneJson(input.snapshot as AgentRunSnapshot, "AgentRunLedger.snapshot"),
    audit: cloneControlPlaneJson(input.audit as AgentAuditRecord, "AgentRunLedger.audit"),
    toolAudit: cloneControlPlaneJson(input.toolAudit as ToolAuditRecord[], "AgentRunLedger.toolAudit"),
    timeline: input.timeline === undefined
      ? undefined
      : cloneControlPlaneJson(input.timeline as AgentReplayResult["timeline"], "AgentRunLedger.timeline"),
    trace: cloneControlPlaneJson(input.trace as AgentTraceArtifact, "AgentRunLedger.trace"),
    summary: cloneControlPlaneJson(input.summary as AgentTraceSummary, "AgentRunLedger.summary"),
    cost: input.cost === undefined
      ? undefined
      : cloneControlPlaneJson(input.cost as CostEstimate, "AgentRunLedger.cost"),
    metadata: cloneControlPlaneMetadata(input.metadata, "AgentRunLedger.metadata")
  };
};

export const migrateAgentRunLedger = (
  value: unknown,
  targetVersion: AgentControlPlaneMigrationTarget = AGENT_CONTROL_PLANE_SCHEMA_VERSION
): AgentRunLedger => {
  assertControlPlaneMigrationTarget(targetVersion, "AgentRunLedger");
  return normalizeAgentRunLedger(value);
};

export const createAgentRunLedger = (
  state: AgentRunState,
  options: AgentRunLedgerOptions = {}
): AgentRunLedger => {
  const traceOptions = createProductionTraceOptions({
    ...options.trace,
    includeToolInputs: options.trace?.includeToolInputs ?? options.includeInput ?? false,
    includeToolOutputs: options.trace?.includeToolOutputs ?? options.includeOutput ?? false,
    redaction: options.trace?.redaction ?? options.redaction ?? { includeEmails: true }
  });
  const sanitizationOptions = {
    includeMessages: traceOptions.includeMessages ?? false,
    includeToolInputs: traceOptions.includeToolInputs ?? false,
    includeToolOutputs: traceOptions.includeToolOutputs ?? false,
    includeApprovalArguments: traceOptions.includeApprovalArguments ?? false,
    includeOutputText: traceOptions.includeOutputText ?? false
  };
  const redaction = resolveLedgerRedaction(traceOptions.redaction);
  const snapshot = sanitizeLedgerValue(
    createAgentRunSnapshot(state),
    sanitizationOptions,
    redaction
  ) as unknown as AgentRunSnapshot;
  const replay = replayAgentRun(state);
  const trace = createAgentTraceArtifact(state, traceOptions);
  const summary = summarizeAgentTrace(trace, { pricing: options.pricing });
  const auditOptions = { ...options, redaction: traceOptions.redaction };
  const audit = createAgentAuditRecord(state, auditOptions);

  return normalizeAgentRunLedger({
    schemaVersion: AGENT_CONTROL_PLANE_SCHEMA_VERSION,
    type: "agent_run_ledger",
    runId: state.runId,
    agentId: state.agentId,
    provider: state.provider,
    modelId: state.modelId,
    status: state.status,
    snapshot,
    trace,
    audit,
    toolAudit: createToolAuditRecords(state, auditOptions),
    timeline: options.includeTimeline === true
      ? sanitizeLedgerValue(replay.timeline, sanitizationOptions, redaction) as unknown as AgentReplayResult["timeline"]
      : undefined,
    summary,
    cost: options.pricing ? estimateAgentRunCost(state, options.pricing) : undefined,
    metadata: options.includeMetadata && audit.metadata
      ? audit.metadata
      : undefined
  });
};

const addDiff = (
  changes: AgentRunLedgerDiffChange[],
  field: string,
  left: unknown,
  right: unknown
) => {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    changes.push({ field, left: toOptionalJsonValue(left), right: toOptionalJsonValue(right) });
  }
};

export const diffAgentRunLedgers = (left: AgentRunLedger, right: AgentRunLedger): AgentRunLedgerDiff => {
  const changes: AgentRunLedgerDiffChange[] = [];
  addDiff(changes, "status", left.status, right.status);
  addDiff(changes, "provider", left.provider, right.provider);
  addDiff(changes, "modelId", left.modelId, right.modelId);
  addDiff(changes, "steps", left.snapshot.steps, right.snapshot.steps);
  addDiff(changes, "toolCalls", left.snapshot.toolCalls.map((call) => call.name), right.snapshot.toolCalls.map((call) => call.name));
  addDiff(changes, "toolErrors", left.audit.toolErrors, right.audit.toolErrors);
  addDiff(changes, "approvals", left.audit.approvals, right.audit.approvals);
  addDiff(changes, "outputText", left.snapshot.outputText, right.snapshot.outputText);
  addDiff(changes, "usage", left.snapshot.usage, right.snapshot.usage);
  addDiff(changes, "cost", left.cost, right.cost);

  return {
    ok: changes.length === 0,
    leftRunId: left.runId,
    rightRunId: right.runId,
    changes
  };
};

export const promoteAgentGoldenTrace = (
  ledger: AgentRunLedger,
  options: { name?: string; outputText?: string; metadata?: Record<string, JsonValue> } = {}
): AgentGoldenTrace => ({
  schemaVersion: AGENT_CONTROL_PLANE_SCHEMA_VERSION,
  type: "agent_golden_trace",
  name: options.name ?? ledger.runId,
  ledger,
  expectations: {
    status: ledger.status,
    outputText: options.outputText ?? ledger.snapshot.outputText,
    toolCalls: ledger.snapshot.toolCalls.map((call) => call.name),
    approvals: ledger.audit.approvals
  },
  metadata: options.metadata
});

const candidateModel = (candidate: AgentModelCandidate): LanguageModel =>
  "model" in candidate ? candidate.model : candidate;

const providerAllowed = (support: ProviderAgentSupport, requirements: AgentCapabilityRequirements) => {
  if (requirements.allowedProviders && !requirements.allowedProviders.includes(support.provider)) {
    return false;
  }
  return !(requirements.excludedProviders ?? []).includes(support.provider);
};

const requirementChecks: Array<[keyof AgentCapabilityRequirements, keyof ProviderAgentSupport, string]> = [
  ["tools", "portableToolLoop", "tools"],
  ["approvals", "approvalReady", "approval requests"],
  ["hostedTools", "hostedTools", "hosted tools"],
  ["remoteMcp", "remoteMcp", "remote MCP"],
  ["codeExecution", "codeExecution", "code execution"],
  ["shell", "shell", "shell"],
  ["structuredOutput", "structuredOutput", "structured output"],
  ["reasoning", "reasoning", "reasoning"],
  ["streaming", "streaming", "streaming"],
  ["webSearch", "webSearch", "web search"],
  ["realtime", "realtime", "realtime"]
];

const matchesRequirements = (support: ProviderAgentSupport, requirements: AgentCapabilityRequirements): boolean => {
  if (!providerAllowed(support, requirements)) {
    return false;
  }
  if (requirements.minTier && tierRank[support.agentTier] < tierRank[requirements.minTier]) {
    return false;
  }
  return requirementChecks.every(([requirement, supportKey]) =>
    requirements[requirement] === true ? Boolean(support[supportKey]) : true
  );
};

const scoreSupport = (support: ProviderAgentSupport, requirements: AgentCapabilityRequirements): number => {
  let score = tierRank[support.agentTier] * 100;
  for (const [requirement, supportKey] of requirementChecks) {
    if (requirements[requirement] === true && support[supportKey]) {
      score += 10;
    } else if (support[supportKey] === true) {
      score += 1;
    }
  }
  return score;
};

const selectionReasons = (support: ProviderAgentSupport, requirements: AgentCapabilityRequirements): string[] => [
  `${support.provider}/${support.modelId} is ${support.agentTier}`,
  ...requirementChecks.flatMap(([requirement, supportKey, label]) =>
    requirements[requirement] === true && support[supportKey] ? [`supports ${label}`] : []
  )
];

export const selectAgentModel = (
  candidates: AgentModelCandidate[],
  requirements: AgentCapabilityRequirements = {}
): AgentModelSelection => {
  if (!candidates.length) {
    throw new ValidationError("No agent model candidates were provided.");
  }

  const matches = candidates
    .map((candidate, index) => {
      const model = candidateModel(candidate);
      const support = inspectProviderAgentSupport(model);
      return {
        model,
        support,
        score: scoreSupport(support, requirements),
        reasons: selectionReasons(support, requirements),
        index
      };
    })
    .filter((entry) => matchesRequirements(entry.support, requirements))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = matches[0];
  if (!selected) {
    throw new ValidationError("No agent model candidate satisfies the requested capabilities.");
  }

  return selected;
};

export const createAgentCapabilityRouter = (candidates: AgentModelCandidate[]): AgentCapabilityRouter => ({
  select(requirements = {}) {
    return selectAgentModel(candidates, requirements);
  },
  inspect() {
    return candidates.map((candidate) => inspectProviderAgentSupport(candidateModel(candidate)));
  }
});

export const createAgentControlPlaneRunRecord = (
  state: AgentRunState,
  options: Pick<AgentRunLedgerOptions, "pricing" | "trace" | "includeTimeline" | "includeInput" | "includeOutput" | "includeMetadata" | "redaction" | "outputPreviewLength"> = {}
): AgentControlPlaneRunRecord => {
  const ledger = createAgentRunLedger(state, options);
  return {
    state,
    ledger,
    trace: ledger.trace,
    summary: ledger.summary,
    audit: ledger.audit,
    toolAudit: ledger.toolAudit
  };
};

export const inspectAgentControlPlane = (agent: AgentDefinition): AgentControlPlaneInspection => {
  const capsule = createAgentCapsule({ agent, id: agent.id ?? "agent" });
  return {
    provider: capsule.providerSupport,
    capsule: inspectAgentCapsule(capsule)
  };
};

const hasSessionInput = <TModel extends LanguageModel>(
  options: AgentControlPlaneOptions<TModel>,
  input: AgentControlPlaneRunInput<TModel>
): input is AgentControlPlaneRunInput<TModel> & { userId: string } =>
  Boolean(options.appName && options.sessionService && input.userId);

const toRunnerInput = <TModel extends LanguageModel>(
  input: AgentControlPlaneRunInput<TModel> & { userId: string }
): RunnerRunInput<TModel> => {
  const { state: _state, handoff: _handoff, parentRunId: _parentRunId, ...runnerInput } = input;
  return runnerInput as RunnerRunInput<TModel>;
};

const approvalTokensMatch = (expected: string, actual: string): boolean => {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
};

export const createAgentControlPlane = <TModel extends LanguageModel>(
  options: AgentControlPlaneOptions<TModel>
): AgentControlPlane<TModel> => {
  const runtimeAgent = options.agent.harness
    ? options.agent
    : createAgentCapsule({
        id: options.agent.id ?? "agent",
        agent: options.agent
      }).agent;
  const runner = options.appName && options.sessionService
    ? createRunner({ appName: options.appName, agent: runtimeAgent, sessionService: options.sessionService })
    : undefined;

  const record = (state: AgentRunState, session?: RunnerRunOutput["session"]): AgentControlPlaneRunRecord => ({
    ...createAgentControlPlaneRunRecord(state, {
      ...(options.audit ?? {}),
      pricing: options.pricing,
      trace: options.trace
    }),
    session
  });

  return {
    async run(input = {}) {
      if (runner && hasSessionInput(options, input)) {
        const output = await runner.run(toRunnerInput(input));
        return record(output.output.state, output.session);
      }

      const output = await runAgent(runtimeAgent, input);
      return record(output.state);
    },
    async resume(input) {
      const output = await resumeAgent(runtimeAgent, input);
      return record(output.state);
    },
    async resumeApproval(input) {
      const {
        queueItem: rawQueueItem,
        approvalToken,
        approve,
        reason,
        now = Date.now(),
        ...resumeInput
      } = input;
      const queueItem = normalizeAgentApprovalQueueItem(rawQueueItem);
      const presentedToken = controlPlaneString(approvalToken, "Agent approval token");
      if (!approvalTokensMatch(queueItem.approvalToken, presentedToken)) {
        throw new ValidationError("Agent approval token is invalid.");
      }
      if (typeof approve !== "boolean") {
        throw new ValidationError("Agent approval decision must be a boolean.");
      }
      const decisionReason = controlPlaneOptionalString(reason, "Agent approval reason", true);
      controlPlaneFiniteNumber(now, "Agent approval clock");
      if (queueItem.expiresAt !== undefined && now >= queueItem.expiresAt) {
        throw new ValidationError("Agent approval has expired.");
      }
      if (!runtimeAgent.store) {
        throw new ValidationError("Durable approval resume requires an AgentRunStore.");
      }
      const state = await runtimeAgent.store.load(queueItem.runId, resumeInput.scope);
      if (!state) {
        throw new ValidationError(`Agent run "${queueItem.runId}" was not found.`);
      }
      if (queueItem.agentId !== undefined && state.agentId !== queueItem.agentId) {
        throw new ValidationError("Agent approval queue item does not match the persisted agent.");
      }
      const pending = state.pendingApprovals.find(
        (approval) =>
          approval.provider === queueItem.provider &&
          approval.id === queueItem.approvalRequestId
      );
      if (!pending) {
        throw new ValidationError("Agent approval is no longer pending or was already consumed.");
      }
      if (pending.name !== queueItem.name) {
        throw new ValidationError("Agent approval queue item does not match the pending request.");
      }
      const currentFingerprint = approvalRequestFingerprint(pending);
      const legacyFingerprint = legacyApprovalRequestFingerprint(pending);
      const isLegacyProjection = queueItem.requestFingerprint === legacyFingerprint;
      if (queueItem.requestFingerprint !== currentFingerprint && !isLegacyProjection) {
        throw new ValidationError("Agent approval request fingerprint does not match the persisted request.");
      }
      if (!isLegacyProjection && queueItem.kind !== (pending.kind ?? "provider")) {
        throw new ValidationError("Agent approval queue item kind does not match the persisted request.");
      }
      const output = await resumeAgent(runtimeAgent, {
        ...resumeInput,
        state,
        approvals: [{
          provider: pending.provider,
          approvalRequestId: pending.id,
          approve,
          reason: decisionReason
        }]
      });
      return record(output.state);
    },
    stream(input = {}) {
      if (runner && hasSessionInput(options, input)) {
        return runner.stream(toRunnerInput(input));
      }
      return streamAgent(runtimeAgent, input);
    },
    async getRun(runId) {
      return runtimeAgent.store?.load(runId);
    },
    async getTrace(runId) {
      const state = await runtimeAgent.store?.load(runId);
      return state ? createAgentTraceArtifact(state, options.trace) : undefined;
    },
    async getRunTree(runId) {
      if (!runtimeAgent.store) {
        return undefined;
      }
      return createHierarchicalAgentTrace(runtimeAgent.store, runId, options.trace);
    },
    async cancel(runId, cancellationOptions) {
      if (!runtimeAgent.store) {
        return undefined;
      }
      return cancelAgentRun(runtimeAgent.store, runId, cancellationOptions);
    },
    async cancelTree(runId, cancellationOptions) {
      if (!runtimeAgent.store) {
        return { children: [] };
      }
      return cancelAgentRunTree(runtimeAgent.store, runId, cancellationOptions);
    },
    inspect() {
      return inspectAgentControlPlane(runtimeAgent);
    }
  };
};
