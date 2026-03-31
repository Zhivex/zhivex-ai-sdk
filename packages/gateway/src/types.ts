import type {
  GenerateGroundedTextOptions,
  GenerateObjectOutput,
  GenerateTextOutput,
  GroundedLanguageModel,
  ModelCatalog,
  ProviderAdapter,
  ReasoningConfig,
  StreamObjectResult,
  StreamTextResult,
  TokenUsage,
  ToolChoice,
  ToolExecutionOptions,
  ToolSet
} from "@zhivex-ai/core";
import type { ZodTypeAny } from "zod";

export type GatewayProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "vertex"
  | "qwen"
  | "kimi"
  | "bedrock"
  | "ollama"
  | "azure-openai"
  | "openrouter";
export type GatewayRoutingMode = "speed" | "balanced" | "quality";
export type GatewayTaskIntent = "chat" | "reasoning" | "tool-heavy";

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

export interface GatewayAttempt {
  provider: GatewayProviderId;
  modelId: string;
  ok: boolean;
  latencyMs: number;
  errorMessage?: string;
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

export interface GatewayStreamObjectResult<TSchema extends ZodTypeAny> extends Omit<StreamObjectResult<TSchema>, "collect"> {
  collect: () => Promise<GatewayObjectResponse<TSchema>>;
}

export interface GatewayConfig {
  adapters: Partial<Record<GatewayProviderId, ProviderAdapter>>;
  groundedAdapters?: Partial<Record<GatewayProviderId, Pick<ProviderAdapter, "groundedLanguageModel">>>;
  modelCatalog?: ModelCatalog;
  providerCostsPer1kTokens?: Partial<Record<GatewayProviderId, number>>;
  latencyBiasMs?: Partial<Record<GatewayProviderId, number>>;
  maxRetries?: number;
  attemptTimeoutMs?: number;
  attemptTimeoutsMs?: Partial<Record<GatewayProviderId, number>>;
  retryBackoffMs?: number;
  onAttempt?: (attempt: GatewayAttempt & { retry: number; targetRank: number }) => void | Promise<void>;
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
