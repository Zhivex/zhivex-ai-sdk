import type {
  AgentApprovalResponse,
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
  | "provider-success";
export type GatewayRouteDecisionReasonCode =
  | "routing-speed"
  | "routing-balanced"
  | "routing-quality";

export interface GatewayImageAttachment {
  dataUrl: string;
  mimeType: string;
}

export interface GatewayMessage {
  role: "user" | "assistant";
  content: string;
  images?: GatewayImageAttachment[];
}

export interface GatewayModelTarget {
  provider: GatewayProviderId;
  modelId: string;
}

export interface GatewayRequest {
  messages: GatewayMessage[];
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
  primary: GatewayModelTarget;
  fallbacks?: GatewayModelTarget[];
}

export interface GatewayAgentRequest extends Omit<GatewayRequest, "messages" | "systemPrompt"> {
  prompt?: string;
  messages?: GatewayMessage[];
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
  provider: GatewayProviderId;
  modelId: string;
  ok: boolean;
  latencyMs: number;
  errorMessage?: string;
  reasonCode?: GatewayAttemptReasonCode;
  retry?: number;
  targetRank?: number;
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
  adapters: Partial<Record<GatewayProviderId, ProviderAdapter>>;
  modelCatalog?: ModelCatalog;
  providerCostsPer1kTokens?: Partial<Record<GatewayProviderId, number>>;
  latencyBiasMs?: Partial<Record<GatewayProviderId, number>>;
  unknownCostPolicy?: GatewayUnknownCostPolicy;
  scoreTarget?: (context: GatewayRoutingScoreContext) => number;
  maxRetries?: number;
  attemptTimeoutMs?: number;
  attemptTimeoutsMs?: Partial<Record<GatewayProviderId, number>>;
  retryBackoffMs?: number;
  onAttempt?: (attempt: GatewayAttempt & { retry: number; targetRank: number }) => void | Promise<void>;
  onAgentRoute?: (selection: {
    provider: GatewayProviderId;
    modelId: string;
    routeDecision: GatewayResponse["routeDecision"];
    attempts: GatewayAttempt[];
    targetRank: number;
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
