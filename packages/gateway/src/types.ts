import type {
  AgentApprovalResponse,
  AgentDefinition,
  AgentRunInput,
  AgentCapabilities,
  AgentHookFailurePolicy,
  AgentHandoff,
  AgentMemoryStore,
  AgentRunPolicy,
  AgentRunOutput,
  AgentRunState,
  AgentRunStore,
  AgentStoreScope,
  AgentStreamResult,
  AgentSupportTier,
  AgentTelemetryObserver,
  GenerateObjectOutput,
  GenerateTextOutput,
  JsonValue,
  ModelCatalog,
  ModelCostValuation,
  ModelMessage,
  ProviderAdapter,
  ReasoningConfig,
  StreamObjectResult,
  StreamTextResult,
  TokenUsage,
  ToolApprovalPolicy,
  ToolChoice,
  ToolExecutionOptions,
  ToolSet
} from "@zhivex-ai/core";
import type { ZodTypeAny } from "zod";
import type { GatewayMetricsStore } from "./metrics.js";
import type { GatewayCircuitBreaker } from "./circuit-breaker.js";
import type { GatewayAdaptiveCandidate, GatewayAdaptiveRoutingPolicy } from "./adaptive-routing.js";

export type GatewayProviderId =
  | "openai"
  | "xai"
  | "meta"
  | "anthropic"
  | "gemini"
  | "vertex"
  | "qwen"
  | "kimi"
  | "deepseek"
  | "zai"
  | "bedrock"
  | "ollama"
  | "azure-openai"
  | "openrouter";
export type GatewayRoutingMode = "speed" | "balanced" | "quality";
export type GatewayTaskIntent = "chat" | "reasoning" | "tool-heavy";
export type GatewayUnknownCostPolicy = "reject" | "allow";
export type GatewayAttemptReasonCode =
  | "model-capabilities"
  | "agent-capabilities"
  | "cost-budget"
  | "operation-skip"
  | "request-aborted"
  | "provider-error"
  | "provider-success"
  | "circuit-open"
  | "admission-denied"
  | "budget-denied";
export type GatewayRouteDecisionReasonCode =
  | "routing-speed"
  | "routing-balanced"
  | "routing-quality"
  | "routing-adaptive";

export interface GatewayImageAttachment {
  dataUrl: string;
  mimeType: string;
}

export interface GatewayMessage {
  role: "user" | "assistant";
  content: string;
  images?: GatewayImageAttachment[];
}

/** Legacy text/image messages or canonical core messages. See the supported history subset in README. */
export type GatewayInputMessage = GatewayMessage | ModelMessage;

export interface GatewayModelTarget {
  provider: GatewayProviderId;
  modelId: string;
  /** Identifies a separately configured endpoint/region/credential. */
  deploymentId?: string;
}

export interface GatewayRequest {
  messages: GatewayInputMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSet;
  toolChoice?: ToolChoice;
  toolExecution?: ToolExecutionOptions;
  maxSteps?: number;
  reasoning?: ReasoningConfig;
  providerOptions?: Record<string, unknown>;
  requiredCapabilities?: Partial<Record<"streaming" | "tools" | "structuredOutput" | "jsonMode" | "vision" | "reasoning", boolean>>;
  maxCostPer1kTokens?: number;
  routingMode?: GatewayRoutingMode;
  taskIntent?: GatewayTaskIntent;
  abortSignal?: AbortSignal;
  /** Total operation deadline, including tools, retries and observers. */
  timeoutMs?: number;
  /** Trusted application budget scope; never accept directly from an untrusted client. */
  budgetScope?: string;
  /** Cache partition, in addition to the configured authentication scope. */
  cacheScope?: string;
  /** Stable conversation/prompt-prefix key, scoped by cacheScope and budgetScope. */
  affinityKey?: string;
  primary: GatewayModelTarget;
  fallbacks?: GatewayModelTarget[];
}

export interface GatewayAgentRequest extends Omit<GatewayRequest, "messages" | "systemPrompt"> {
  /** Reuse a configured definition while routing its model through the existing Core loop. */
  agent?: AgentDefinition;
  context?: AgentRunInput["context"];
  compaction?: AgentRunInput["compaction"];
  executionEnvironment?: AgentRunInput["executionEnvironment"];
  prompt?: string;
  messages?: GatewayInputMessage[];
  system?: string;
  instructions?: string;
  agentId?: string;
  runId?: string;
  scope?: AgentStoreScope;
  idempotencyKey?: string;
  parentRunId?: string;
  state?: AgentRunState;
  approvals?: AgentApprovalResponse[];
  handoff?: AgentHandoff;
  metadata?: Record<string, JsonValue>;
  store?: AgentRunStore;
  memory?: AgentMemoryStore;
  onTelemetryEvent?: AgentTelemetryObserver;
  hookFailurePolicy?: AgentHookFailurePolicy;
  toolApprovalPolicy?: ToolApprovalPolicy;
  policy?: AgentRunPolicy;
  requiredAgentCapabilities?: Partial<Omit<AgentCapabilities, "supportTier">> & {
    supportTier?: AgentSupportTier;
  };
}

export interface GatewayAttempt {
  deploymentId?: string;
  cacheHit?: boolean;
  provider: GatewayProviderId;
  modelId: string;
  ok: boolean;
  latencyMs: number;
  errorMessage?: string;
  reasonCode?: GatewayAttemptReasonCode;
  retry?: number;
  targetRank?: number;
  /** Reported provider usage for this attempt, never an estimated request total. */
  usage?: TokenUsage;
  cost?: ModelCostValuation;
}

export interface GatewayResponse {
  text: string;
  finishReason?: GenerateTextOutput["finishReason"];
  providerFinishReason?: GenerateTextOutput["providerFinishReason"];
  providerUsed: GatewayProviderId;
  modelUsed: string;
  latencyMs: number;
  attempts: GatewayAttempt[];
  usage: TokenUsage & { estimated: boolean };
  routeDecision: {
    mode: GatewayRoutingMode;
    intent: GatewayTaskIntent;
    orderedTargets: GatewayModelTarget[];
    reasonCode?: GatewayRouteDecisionReasonCode;
    reason: string;
    estimatedCosts?: ModelCostValuation[];
    adaptive?: { policyVersion: string; candidates: GatewayAdaptiveCandidate[]; exploration?: boolean; affinity?: boolean };
  };
  steps: GenerateTextOutput["steps"];
  messages: GenerateTextOutput["messages"];
  toolResults: GenerateTextOutput["toolResults"];
}

export interface GatewayGenerateObjectRequest<TSchema extends ZodTypeAny> extends GatewayRequest {
  schema: TSchema;
  mode?: "auto" | "native" | "prompted";
  schemaName?: string;
  schemaDescription?: string;
}

export interface GatewayObjectResponse<TSchema extends ZodTypeAny>
  extends Omit<GatewayResponse, "text" | "usage">,
    Omit<GenerateObjectOutput<TSchema>, "usage"> {
  text: string;
  usage: GatewayResponse["usage"];
}

export interface GatewayStreamTextResult extends Omit<StreamTextResult, "collect"> {
  collect: () => Promise<GatewayResponse>;
}

export interface GatewayAgentResponse extends Omit<AgentRunOutput, "state"> {
  state: AgentRunState & {
    routeDecision: GatewayResponse["routeDecision"];
  };
  providerUsed: GatewayProviderId;
  modelUsed: string;
  latencyMs: number;
  attempts: GatewayAttempt[];
  routeDecision: GatewayResponse["routeDecision"];
}

export interface GatewayAgentStreamResult extends Omit<AgentStreamResult, "collect"> {
  collect: () => Promise<GatewayAgentResponse>;
}

export interface GatewayStreamObjectResult<TSchema extends ZodTypeAny> extends Omit<StreamObjectResult<TSchema>, "collect"> {
  collect: () => Promise<GatewayObjectResponse<TSchema>>;
}

export interface GatewayRoutingScoreContext {
  mode: GatewayRoutingMode;
  intent: GatewayTaskIntent;
  target: GatewayModelTarget;
  isPrimary: boolean;
  configuredCostPer1kTokens?: number;
  catalogCostPer1kTokens?: number;
  latencyBiasMs?: number;
}

export interface GatewayConfig {
  /** Explicit deployment registrations; unknown IDs never fall back to the default adapter. */
  deployments?: Record<string, { provider: GatewayProviderId; adapter: ProviderAdapter }>;
  timeoutMs?: number;
  affinity?: { ttlMs?: number; maxEntries?: number; maxScoreLoss?: number };
  admission?: import("./admission.js").GatewayAdmissionController;
  /** Maximum wait for asynchronous settlement/release before reporting failure. */
  resourceTimeoutMs?: number;
  budget?: { store: import("./budget.js").GatewayBudgetStore; currency: string; reserveAmount: number };
  cache?: { store: import("@zhivex-ai/core").GenerateCache; scope: string; timeoutMs?: number };
  /** Legacy preserves detached callbacks. Background bounds capacity; await waits per attempt. */
  observerMode?: "legacy" | "await" | "background";
  observerQueueCapacity?: number;
  adapters: Partial<Record<GatewayProviderId, ProviderAdapter>>;
  metrics?: GatewayMetricsStore;
  circuitBreaker?: GatewayCircuitBreaker;
  adaptiveRouting?: GatewayAdaptiveRoutingPolicy;
  modelCatalog?: ModelCatalog;
  /** Opt-in valuation from the detailed catalog; does not replace the legacy rate budget. */
  costAccounting?: {
    unknownCostPolicy?: GatewayUnknownCostPolicy;
    expectedOutputTokens?: number;
    cacheAssumption?: "reported" | "none";
    reasoningAccounting?: Partial<Record<GatewayProviderId, "included" | "additional">>;
  };
  providerCostsPer1kTokens?: Partial<Record<GatewayProviderId, number>>;
  latencyBiasMs?: Partial<Record<GatewayProviderId, number>>;
  unknownCostPolicy?: GatewayUnknownCostPolicy;
  scoreTarget?: (context: GatewayRoutingScoreContext) => number;
  /** Maximum fallback targets accepted per request. Defaults to 8 and cannot exceed 32. */
  maxFallbacks?: number;
  /** Retries per target. Defaults to 2 and cannot exceed 5. */
  maxRetries?: number;
  /** Maximum provider calls across one routed operation, including agent steps. Defaults to 32 and cannot exceed 128. */
  maxTotalAttempts?: number;
  attemptTimeoutMs?: number;
  attemptTimeoutsMs?: Partial<Record<GatewayProviderId, number>>;
  /** Maximum wait between provider stream events. Defaults to 60 seconds; set false to disable. */
  streamIdleTimeoutMs?: number | false;
  streamIdleTimeoutsMs?: Partial<Record<GatewayProviderId, number | false>>;
  retryBackoffMs?: number;
  /** Maximum time spent awaiting a best-effort observer. Defaults to 1 second. */
  observerTimeoutMs?: number;
  onAttempt?: (attempt: GatewayAttempt & {
    retry: number;
    targetRank: number;
    abortSignal: AbortSignal;
  }) => void | Promise<void>;
  onAgentRoute?: (selection: {
    provider: GatewayProviderId;
    modelId: string;
    routeDecision: GatewayResponse["routeDecision"];
    attempts: GatewayAttempt[];
    targetRank: number;
    abortSignal: AbortSignal;
  }) => void | Promise<void>;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
