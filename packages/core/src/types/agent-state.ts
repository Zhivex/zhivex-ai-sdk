import type {
  AgentApprovalRequest,
  AgentApprovalResolution,
  AgentStatus,
  AgentStoreScope,
  FinishReason,
  JsonValue,
  ProviderOptions,
  ProviderToolCallErrorReason,
  ReasoningConfig,
  StructuredOutputMode,
  TokenUsage
} from "./common.js";
import type {
  ModelMessage,
  ToolChoice,
  ToolExecutionResult
} from "./messages.js";
import type {
  AgentExecutionEnvironmentBinding,
  ToolExecutionOptions
} from "./model-tools.js";

export type AgentStepStatus = "running" | "completed" | "suspended" | "waiting_approval" | "failed";

export interface AgentRunPolicy {
  /** Shared CAS-backed admission for model, auxiliary and child allocations. */
  budgetCoordinator?: import("../agent-budget-coordinator.js").AgentBudgetCoordinator;
  /** Required with budgetCoordinator. A conservative bound for each primary model call. */
  modelReservation?: import("../agent-budget-coordinator.js").AgentTokenReservation;
  timeoutMs?: number;
  onTimeout?: "fail" | "cancel-requested";
  /** Explicit migration escape hatch for pre-fingerprint durable states. */
  allowLegacyHarnessResume?: boolean;
  /** Explicit migration escape hatch for states created before environment binding. */
  allowLegacyExecutionEnvironmentResume?: boolean;
  /** Disable only for stores that intentionally provide CAS without worker leases. */
  leaseMode?: "required" | "disabled";
  /** Duration of the exclusive worker lease. Defaults to 30 seconds. */
  leaseTtlMs?: number;
  /** Lease renewal interval. Defaults to one third of leaseTtlMs. */
  heartbeatMs?: number;
  /** How often an active worker checks durable cancellation. Defaults to 1 second. */
  cancellationPollMs?: number;
  /** Maximum retained events for agent stream replay. Defaults to 4096. */
  maxStreamEvents?: number;
  /** Maximum serialized durable state size. Defaults to 4 MiB. */
  maxStateBytes?: number;
  /** Optional preflight limits enforced before model and tool operations. */
  budget?: {
    maxSteps?: number;
    maxToolCalls?: number;
    maxToolErrors?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxTotalTokens?: number;
    includeChildRuns?: boolean;
  };
}

export type AgentCompactionReason =
  | "message-count"
  | "estimated-input-tokens";

export interface AgentCompactionRequest<TContext = any> {
  runId: string;
  agentId?: string;
  scope?: AgentStoreScope;
  beforeStep: number;
  context?: TContext;
  /** Historical prefix being summarized. System messages are never included. */
  messages: ModelMessage[];
  /** Literal tail preserved after the summary. */
  retainedMessages: ModelMessage[];
  reasons: AgentCompactionReason[];
  estimatedTokensBefore: number;
  sourceDigest: string;
  idempotencyKey: string;
  metadata?: Record<string, JsonValue>;
  abortSignal?: AbortSignal;
}

export interface AgentCompactionResult {
  summary: string;
  usage?: TokenUsage;
  metadata?: Record<string, JsonValue>;
}

export type AgentCompactor<TContext = any> = (
  request: AgentCompactionRequest<TContext>
) => AgentCompactionResult | Promise<AgentCompactionResult>;

/** Explicit identity and conservative token reservation for a paid summarizer. */
export interface AgentCompactionAuxiliaryRoute {
  provider: string;
  modelId: string;
  /** Include endpoint, prompt version and pricing revision; never credentials. */
  fingerprint: string;
  priceRevision?: string;
  /** Conservative uncached rates; valuation is an estimate, not an invoice. */
  pricing?: { currency: string; inputCostPer1kTokens: number; outputCostPer1kTokens: number };
  reservation: { inputTokens: number; outputTokens: number; totalTokens: number };
}

export interface AgentCompactionAttempt {
  id: string;
  beforeStep: number;
  sourceDigest: string;
  route: AgentCompactionAuxiliaryRoute;
  status: "in-flight" | "confirmed" | "unknown";
  estimatedCost?: { amount: number; currency: string };
  createdAt: number;
  usage?: TokenUsage;
}

export interface AgentCompactionOptions<TContext = any> {
  /** Compaction runs when either configured threshold is exceeded. */
  maxMessages?: number;
  maxEstimatedInputTokens?: number;
  /** Literal non-system tail retained after compaction. Defaults to 8 messages. */
  keepRecentMessages?: number;
  estimateTokens?: (messages: readonly ModelMessage[]) => number;
  compactor: AgentCompactor<TContext>;
  /** Opt in for paid calls. The callback must obey the reservation and use no tools. */
  auxiliary?: AgentCompactionAuxiliaryRoute;
}

export interface AgentCompactionRecord {
  id: string;
  beforeStep: number;
  createdAt: number;
  reasons: AgentCompactionReason[];
  sourceDigest: string;
  resultDigest: string;
  summaryDigest: string;
  summary: string;
  messageCountBefore: number;
  messageCountAfter: number;
  compactedMessageCount: number;
  retainedMessageCount: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  usage?: TokenUsage;
  metadata?: Record<string, JsonValue>;
}

export interface AgentStepRequest {
  /** Index in the full conversation where this incremental snapshot begins. */
  messageOffset?: number;
  messages: ModelMessage[];
  toolChoice?: ToolChoice;
  toolExecution?: ToolExecutionOptions;
  temperature?: number;
  maxTokens?: number;
  reasoning?: ReasoningConfig;
  providerOptions?: ProviderOptions;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
}

export interface AgentStepResponse {
  messages: ModelMessage[];
  text?: string;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
}

/** Sanitized, durable projection of an agent failure. */
export interface AgentRunError {
  message: string;
  diagnosticCode?: string;
  category?: "provider-tool-call";
  provider?: string;
  transport?: string;
  reason?: ProviderToolCallErrorReason;
  retryable?: boolean;
  effectsPossible?: boolean;
}

export interface AgentStep {
  index: number;
  status: AgentStepStatus;
  startedAt?: number;
  finishedAt?: number;
  request: AgentStepRequest;
  response?: AgentStepResponse;
  toolResults: ToolExecutionResult[];
  error?: AgentRunError;
}

export interface AgentChildRun {
  runId: string;
  agentId?: string;
  parentRunId?: string;
  toolName?: string;
  toolCallId?: string;
  status: AgentStatus;
  outputText: string;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  usage?: TokenUsage;
  /** Auxiliary calls whose usage remains unknown or in flight. */
  unknownCompactionUsage?: boolean;
  /** Descendant summaries; usage above remains this run's own confirmed usage. */
  childRuns?: AgentChildRun[];
  startedAt?: number;
  updatedAt?: number;
  error?: AgentRunError;
  metadata?: Record<string, JsonValue>;
  /** Durable child state retained only while the parent must resume a child approval. */
  resumeState?: AgentRunState;
}

export interface AgentHarnessBinding {
  schemaVersion: 1;
  id: string;
  version: string;
  fingerprint: string;
  algorithm: "sha256";
}

export interface AgentTaskOutcome {
  status: "in_progress" | "resolved" | "denied" | "failed" | "needs_reconciliation";
  operations: Array<{ toolCallId: string; toolName: string; idempotencyKey: string; diagnosticCode: "INDETERMINATE_TOOL_EXECUTION" }>;
}

/** Evidence must be authenticated against an authoritative external source by the verifier. */
export interface AgentToolReconciliationEvidence {
  operationId: string;
  runId: string;
  scope?: AgentStoreScope;
  toolCallId: string;
  toolName: string;
  idempotencyKey: string;
  input: JsonValue;
  output: JsonValue;
  source: string;
  proof: JsonValue;
}

export interface AgentToolReconciliationRecord {
  evidence: AgentToolReconciliationEvidence;
  decision: "confirmed";
  verifiedAt: number;
  previousOutcome?: AgentTaskOutcome;
  previousOutputText: string;
}

export interface AgentRunState {
  schemaVersion: 1;
  taskOutcome?: AgentTaskOutcome;
  reconciliations?: AgentToolReconciliationRecord[];
  /**
   * Monotonic durable-store revision. Legacy states without a revision are
   * normalized to revision 0 before their next write.
   */
  revision?: number;
  /** Tenant/user isolation boundary propagated by the runtime. */
  scope?: AgentStoreScope;
  runId: string;
  idempotencyKey?: string;
  agentId?: string;
  parentRunId?: string;
  provider: string;
  modelId: string;
  harness?: AgentHarnessBinding;
  executionEnvironment?: AgentExecutionEnvironmentBinding;
  status: AgentStatus;
  messages: ModelMessage[];
  steps: AgentStep[];
  toolResults: ToolExecutionResult[];
  currentStep: number;
  maxSteps: number;
  outputText: string;
  finalOutput?: JsonValue;
  outputMode?: Exclude<StructuredOutputMode, "auto">;
  finishReason?: FinishReason;
  providerFinishReason?: string;
  usage?: TokenUsage;
  pendingApprovals: AgentApprovalRequest[];
  approvalHistory?: AgentApprovalResolution[];
  childRuns?: AgentChildRun[];
  compactions?: AgentCompactionRecord[];
  compactionAttempts?: AgentCompactionAttempt[];
  compactionRouteFingerprint?: string;
  budgetCoordinatorId?: string;
  metadata?: Record<string, JsonValue>;
  handoff?: AgentHandoff;
  startedAt?: number;
  updatedAt?: number;
  cancelledAt?: number;
  cancellationReason?: string;
  error?: AgentRunError;
}

export interface AgentHandoff {
  id: string;
  fromRunId: string;
  scope?: AgentStoreScope;
  fromAgentId?: string;
  toAgentId?: string;
  summary: string;
  contextMessages: ModelMessage[];
  metadata?: Record<string, JsonValue>;
}
