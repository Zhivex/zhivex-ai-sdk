import { cancelAgentRun, cancelAgentRunTree, resumeAgent, runAgent, streamAgent } from "./agent.js";
import { createAgentRunSnapshot, replayAgentRun, type AgentReplayResult, type AgentRunSnapshot } from "./agent-evaluation.js";
import {
  createAgentTraceArtifact,
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
import { createAgentAuditRecord, createToolAuditRecords, type AgentAuditRecord, type AgentAuditRecordOptions, type ToolAuditRecord, type ToolAuditRecordOptions } from "./production-agent-kit.js";
import { inspectProviderAgentSupport, type ProviderAgentSupport } from "./provider-parity.js";
import { createRunner, type RunnerRunInput, type RunnerRunOutput, type RunnerStreamResult, type SessionService } from "./runner.js";
import { toToolSet } from "./tool-registry.js";
import { ValidationError } from "./errors.js";
import type {
  AgentApprovalRequest,
  AgentDefinition,
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
  description?: string;
}

export interface AgentCapsuleManifest {
  schemaVersion: typeof AGENT_CONTROL_PLANE_SCHEMA_VERSION;
  id: string;
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
}

export interface AgentApprovalQueueItem {
  schemaVersion: typeof AGENT_CONTROL_PLANE_SCHEMA_VERSION;
  type: "agent_approval_queue_item";
  runId: string;
  agentId?: string;
  provider: string;
  approvalRequestId: string;
  name: string;
  arguments: string;
  approvalToken: string;
  resumeUrl?: string;
  reason?: string;
  expiresAt?: number;
  rawData: JsonValue;
}

export interface AgentRunLedgerOptions extends AgentAuditRecordOptions, ToolAuditRecordOptions {
  includeTimeline?: boolean;
  pricing?: AgentRunCostPricing;
  trace?: AgentTraceOptions;
}

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

export interface AgentControlPlaneInspection {
  provider: ProviderAgentSupport;
  capsule: AgentCapsuleInspection;
}

export interface AgentControlPlane<TModel extends LanguageModel = LanguageModel> {
  run(input?: AgentControlPlaneRunInput<TModel>): Promise<AgentControlPlaneRunRecord>;
  resume(input: AgentControlPlaneRunInput<TModel> & { state: AgentRunState }): Promise<AgentControlPlaneRunRecord>;
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
  return Array.isArray(permissions)
    ? permissions.filter((permission): permission is AgentToolPermission => typeof permission === "string")
    : [];
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
      kind: isHosted ? "hosted" : "callable",
      provider: isHosted ? toolDefinition.provider : undefined,
      hostedType: isHosted ? toolDefinition.type : undefined,
      source: toolSource(toolDefinition),
      permissions: toolPermissions(toolDefinition),
      riskLevel: toolRiskLevel(toolDefinition),
      owner: typeof audit.owner === "string" ? audit.owner : undefined,
      labels: Array.isArray(audit.labels) ? audit.labels.filter((label): label is string => typeof label === "string") : [],
      requiresApproval: Boolean(toolDefinition.requiresApproval),
      description: "description" in toolDefinition ? toolDefinition.description : undefined
    };
  });
};

export const createAgentCapsule = <TAgent extends AgentDefinition>(
  options: CreateAgentCapsuleOptions<TAgent>
): AgentCapsule<TAgent> => {
  const id = options.id ?? options.agent.id ?? options.name ?? "agent";
  validateCapsuleId(id);

  const providerSupport = inspectProviderAgentSupport(options.agent.model);
  const tools = inspectTools(options.tools ?? options.agent.tools);

  return {
    manifest: {
      schemaVersion: AGENT_CONTROL_PLANE_SCHEMA_VERSION,
      id,
      name: options.name ?? id,
      version: options.version ?? "0.0.0",
      description: options.description,
      provider: options.agent.model.provider,
      modelId: options.agent.model.modelId,
      agentTier: providerSupport.agentTier,
      tools,
      skills: options.skills ?? [],
      mcpServers: options.mcpServers ?? [],
      evaluations: options.evaluations ?? [],
      policy: options.policy,
      metadata: options.metadata
    },
    agent: options.agent,
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
  return Array.isArray(value)
    ? value.filter((permission): permission is AgentToolPermission => typeof permission === "string")
    : [];
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
      const isReadOnly = permissions.length === 0 || permissions.every((permission) => permission === "read" || allowPermissions.has(permission));
      return isReadOnly && !hasWritePermission(permissions)
        ? { approved: true, metadata: { policy: "agent-control-plane", mode } }
        : decision(false, `Tool "${request.tool.name}" is not read-only.`, mode);
    }

    if (mode === "deny-write" && hasWritePermission(permissions)) {
      return decision(false, `Tool "${request.tool.name}" requests write permissions.`, mode);
    }

    return { approved: true, metadata: { policy: "agent-control-plane", mode } };
  };
};

export const createAgentApprovalQueue = (
  state: AgentRunState,
  options: AgentApprovalQueueOptions = {}
): AgentApprovalQueueItem[] =>
  state.pendingApprovals.map((approval) => ({
    schemaVersion: AGENT_CONTROL_PLANE_SCHEMA_VERSION,
    type: "agent_approval_queue_item",
    runId: state.runId,
    agentId: state.agentId,
    provider: approval.provider,
    approvalRequestId: approval.id,
    name: approval.name,
    arguments: approval.arguments,
    approvalToken: `${options.tokenPrefix ?? "appr"}_${state.runId}_${approval.id}`,
    resumeUrl: typeof options.resumeUrl === "function" ? options.resumeUrl(approval, state) : options.resumeUrl,
    reason: typeof options.reason === "function" ? options.reason(approval, state) : options.reason,
    expiresAt: typeof options.expiresAt === "function" ? options.expiresAt(approval, state) : options.expiresAt,
    rawData: approval.rawData
  }));

export const createAgentRunLedger = (
  state: AgentRunState,
  options: AgentRunLedgerOptions = {}
): AgentRunLedger => {
  const snapshot = createAgentRunSnapshot(state);
  const replay = replayAgentRun(state);
  const trace = createAgentTraceArtifact(state, options.trace);
  const summary = summarizeAgentTrace(trace, { pricing: options.pricing });

  return {
    schemaVersion: AGENT_CONTROL_PLANE_SCHEMA_VERSION,
    type: "agent_run_ledger",
    runId: state.runId,
    agentId: state.agentId,
    provider: state.provider,
    modelId: state.modelId,
    status: state.status,
    snapshot,
    trace,
    audit: createAgentAuditRecord(state, options),
    toolAudit: createToolAuditRecords(state, options),
    timeline: options.includeTimeline === false ? undefined : replay.timeline,
    summary,
    cost: options.pricing ? estimateAgentRunCost(state, options.pricing) : undefined,
    metadata: state.metadata ? toJsonValue(state.metadata) as Record<string, JsonValue> : undefined
  };
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

export const createAgentControlPlane = <TModel extends LanguageModel>(
  options: AgentControlPlaneOptions<TModel>
): AgentControlPlane<TModel> => {
  const runner = options.appName && options.sessionService
    ? createRunner({ appName: options.appName, agent: options.agent, sessionService: options.sessionService })
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

      const output = await runAgent(options.agent, input);
      return record(output.state);
    },
    async resume(input) {
      const output = await resumeAgent(options.agent, input);
      return record(output.state);
    },
    stream(input = {}) {
      if (runner && hasSessionInput(options, input)) {
        return runner.stream(toRunnerInput(input));
      }
      return streamAgent(options.agent, input);
    },
    async getRun(runId) {
      return options.agent.store?.load(runId);
    },
    async getTrace(runId) {
      const state = await options.agent.store?.load(runId);
      return state ? createAgentTraceArtifact(state, options.trace) : undefined;
    },
    async getRunTree(runId) {
      if (!options.agent.store) {
        return undefined;
      }
      return createHierarchicalAgentTrace(options.agent.store, runId, options.trace);
    },
    async cancel(runId, cancellationOptions) {
      if (!options.agent.store) {
        return undefined;
      }
      return cancelAgentRun(options.agent.store, runId, cancellationOptions);
    },
    async cancelTree(runId, cancellationOptions) {
      if (!options.agent.store) {
        return { children: [] };
      }
      return cancelAgentRunTree(options.agent.store, runId, cancellationOptions);
    },
    inspect() {
      return inspectAgentControlPlane(options.agent);
    }
  };
};
