import type { ProviderAdapter, TokenUsage } from "@zhivex-ai/core";

export type GatewayProviderId = "openai" | "anthropic" | "gemini" | "bedrock" | "ollama" | "azure-openai" | "openrouter";
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
}

export interface GatewayConfig {
  adapters: Partial<Record<GatewayProviderId, ProviderAdapter>>;
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
