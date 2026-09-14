import {
  ConflictError,
  GuardrailTriggeredError,
  ProviderHTTPError,
  ValidationError,
  createAgent,
  calculateModelCost,
  createStructuredOutputPrompt,
  createTextMessage,
  generateObject,
  generateText,
  runAgent,
  streamAgent,
  streamObject,
  streamText,
  type AgentRunOutput,
  type AgentStreamResult,
  type GenerateObjectOptions,
  type GenerateObjectOutput,
  type GenerateResult,
  type GenerateTextOptions,
  type GenerateTextOutput,
  type LanguageModel,
  type ModelGenerateInput,
  type ProviderAdapter,
  type StreamEvent,
  type StreamObjectResult,
  type StreamTextResult,
  type TokenUsage
} from "@zhivex-ai/core";
import type { ZodTypeAny } from "zod";
import { GatewayCircuitOpenError } from "./circuit-breaker.js";
import { scoreAdaptiveTarget, validateAdaptivePolicy } from "./adaptive-routing.js";
export type { GatewayAdaptiveCandidate, GatewayAdaptiveRoutingPolicy, GatewayQualityProfile } from "./adaptive-routing.js";
export { createGatewayCircuitBreaker, GatewayCircuitOpenError } from "./circuit-breaker.js";
export type { GatewayCircuitBreaker, GatewayCircuitOptions, GatewayCircuitPermit, GatewayCircuitSnapshot, GatewayCircuitState } from "./circuit-breaker.js";
import type { GatewayMetricsHandle, GatewayMetricOutcome } from "./metrics.js";
export { createGatewayMetrics } from "./metrics.js";
export type { GatewayMetricsHandle, GatewayMetricsOptions, GatewayMetricsSnapshot, GatewayMetricsStore, GatewayMetricOutcome } from "./metrics.js";

import { createRouteDecision, gatewayMessagesToModelMessages } from "./compat.js";
import { hasToolHistory, validateGatewayMessages } from "./history.js";
import {
  GatewayError,
  type GatewayAgentRequest,
  type GatewayAgentResponse,
  type GatewayAgentStreamResult,
  type GatewayAttempt,
  type GatewayAttemptReasonCode,
  type GatewayConfig,
  type GatewayGenerateObjectRequest,
  type GatewayModelTarget,
  type GatewayObjectResponse,
  type GatewayProviderId,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayRoutingMode,
  type GatewayStreamObjectResult,
  type GatewayStreamTextResult,
  type GatewayTaskIntent
} from "./types.js";

export { GatewayError } from "./types.js";
export type {
  GatewayAgentRequest,
  GatewayAgentResponse,
  GatewayAgentStreamResult,
  GatewayAttempt,
  GatewayAttemptReasonCode,
  GatewayConfig,
  GatewayGenerateObjectRequest,
  GatewayImageAttachment,
  GatewayInputMessage,
  GatewayMessage,
  GatewayModelTarget,
  GatewayObjectResponse,
  GatewayProviderId,
  GatewayRequest,
  GatewayResponse,
  GatewayRouteDecisionReasonCode,
  GatewayRoutingMode,
  GatewayRoutingScoreContext,
  GatewayStreamObjectResult,
  GatewayStreamTextResult,
  GatewayTaskIntent,
  GatewayUnknownCostPolicy
} from "./types.js";

type RouteSkip = {
  reasonCode: Extract<
    GatewayAttemptReasonCode,
    "model-capabilities" | "agent-capabilities" | "cost-budget" | "operation-skip"
  >;
  message: string;
};

type RouteCandidate = {
  target: GatewayModelTarget;
  targetRank: number;
  model: LanguageModel;
};

type RouteRequest = Pick<
  GatewayRequest,
  | "primary"
  | "fallbacks"
  | "routingMode"
  | "taskIntent"
  | "requiredCapabilities"
  | "maxCostPer1kTokens"
  | "tools"
  | "toolChoice"
  | "reasoning"
  | "abortSignal"
  | "maxTokens"
> & {
  messages?: GatewayRequest["messages"];
  prompt?: string;
  systemPrompt?: string;
  system?: string;
  instructions?: string;
};

type RouteRequiredCapabilities = NonNullable<GatewayRequest["requiredCapabilities"]> & {
  toolChoice?: boolean;
};

type ErrorDisposition = {
  error: GatewayError;
  retrySameTarget: boolean;
  fallbackNextTarget: boolean;
  retryAfterMs?: number;
};

type RouteContext = {
  autoObject?: boolean;
  toolHistory: boolean;
  attempts: GatewayAttempt[];
  candidates: RouteCandidate[];
  routeDecision: GatewayResponse["routeDecision"];
  startedAt: number;
  winner?: RouteCandidate;
  flushAttempts: () => Promise<void>;
  recordAttempt: (attempt: GatewayAttempt) => Promise<void>;
  lock: (candidate: RouteCandidate) => Promise<void>;
};

const DEFAULT_MAX_FALLBACKS = 8;
const MAX_MAX_FALLBACKS = 32;
const DEFAULT_MAX_TOTAL_ATTEMPTS = 32;
const MAX_MAX_TOTAL_ATTEMPTS = 128;
const MAX_MAX_RETRIES = 5;
const DEFAULT_OBSERVER_TIMEOUT_MS = 1_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
const MAX_MODEL_ID_CHARS = 256;
const GATEWAY_PROVIDERS = new Set<GatewayProviderId>([
  "openai",
  "xai",
  "meta",
  "anthropic",
  "gemini",
  "vertex",
  "qwen",
  "kimi",
  "deepseek",
  "zai",
  "bedrock",
  "ollama",
  "azure-openai",
  "openrouter"
]);

const defaultScoreTarget = (
  mode: GatewayRoutingMode,
  intent: GatewayTaskIntent,
  target: GatewayModelTarget,
  config: GatewayConfig
) => {
  const model = target.modelId.toLowerCase();
  const localBoost = target.provider === "ollama" ? -2 : 0;
  const qualityBoost = model.includes("pro") || model.includes("claude") ? 2 : 0;
  const speedBoost = model.includes("flash") || model.includes("lite") ? 2 : 0;
  const reasoningBoost = model.includes("pro") || model.includes("claude") ? 2 : 0;
  const catalogCost = config.modelCatalog?.find(target.provider, target.modelId)?.costPer1kTokens;
  const costPenalty = config.providerCostsPer1kTokens?.[target.provider] ?? catalogCost ?? 0;
  const latencyBiasMs = config.latencyBiasMs?.[target.provider] ?? 0;
  if (!Number.isFinite(costPenalty) || costPenalty < 0) {
    throw new GatewayError(
      `Gateway cost for ${target.provider}/${target.modelId} must be a finite non-negative number.`,
      false
    );
  }
  if (!Number.isFinite(latencyBiasMs) || latencyBiasMs < 0) {
    throw new GatewayError(
      `Gateway latency bias for ${target.provider} must be a finite non-negative number.`,
      false
    );
  }
  const latencyPenalty = latencyBiasMs / 100;

  if (mode === "speed") {
    return speedBoost + localBoost - latencyPenalty;
  }
  if (mode === "quality") {
    return qualityBoost + (intent === "reasoning" ? reasoningBoost : 0) - costPenalty;
  }
  return speedBoost + qualityBoost + localBoost + (intent === "reasoning" ? 1 : 0) - costPenalty - latencyPenalty;
};

const scoreTarget = (
  mode: GatewayRoutingMode,
  intent: GatewayTaskIntent,
  target: GatewayModelTarget,
  primary: GatewayModelTarget,
  config: GatewayConfig
) => {
  if (!config.scoreTarget) {
    return defaultScoreTarget(mode, intent, target, config);
  }

  const score = config.scoreTarget({
    mode,
    intent,
    target,
    isPrimary: target.provider === primary.provider && target.modelId === primary.modelId,
    configuredCostPer1kTokens: config.providerCostsPer1kTokens?.[target.provider],
    catalogCostPer1kTokens: config.modelCatalog?.find(target.provider, target.modelId)?.costPer1kTokens,
    latencyBiasMs: config.latencyBiasMs?.[target.provider]
  });

  if (!Number.isFinite(score)) {
    throw new GatewayError("Gateway scoreTarget() must return a finite number.", false);
  }
  return score;
};

const boundedInteger = (
  name: string,
  value: number | undefined,
  defaultValue: number,
  options: { min: number; max: number }
) => {
  const normalized = value ?? defaultValue;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < options.min ||
    normalized > options.max
  ) {
    throw new GatewayError(
      `${name} must be a safe integer between ${options.min} and ${options.max}.`,
      false
    );
  }
  return normalized;
};

const getMaxFallbacks = (config: GatewayConfig) =>
  boundedInteger("Gateway maxFallbacks", config.maxFallbacks, DEFAULT_MAX_FALLBACKS, {
    min: 0,
    max: MAX_MAX_FALLBACKS
  });

const getMaxTotalAttempts = (config: GatewayConfig) =>
  boundedInteger(
    "Gateway maxTotalAttempts",
    config.maxTotalAttempts,
    DEFAULT_MAX_TOTAL_ATTEMPTS,
    { min: 1, max: MAX_MAX_TOTAL_ATTEMPTS }
  );

const getObserverTimeoutMs = (config: GatewayConfig) => {
  const timeoutMs = config.observerTimeoutMs ?? DEFAULT_OBSERVER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new GatewayError(
      "Gateway observerTimeoutMs must be a finite positive number.",
      false
    );
  }
  return timeoutMs;
};

const validateTarget = (target: GatewayModelTarget, label: string) => {
  if (
    !target ||
    typeof target !== "object" ||
    typeof target.provider !== "string" ||
    !GATEWAY_PROVIDERS.has(target.provider as GatewayProviderId)
  ) {
    throw new GatewayError(`${label} contains an unsupported provider.`, false);
  }
  if (
    typeof target.modelId !== "string" ||
    target.modelId.length === 0 ||
    target.modelId.length > MAX_MODEL_ID_CHARS ||
    /[\u0000-\u001f\u007f]/.test(target.modelId)
  ) {
    throw new GatewayError(
      `${label} modelId must contain 1-${MAX_MODEL_ID_CHARS} characters without control characters.`,
      false
    );
  }
};

const validateRouteRequest = (config: GatewayConfig, request: RouteRequest) => {
  if (request.messages !== undefined) validateGatewayMessages(request.messages);
  const fallbacks = request.fallbacks ?? [];
  const maxFallbacks = getMaxFallbacks(config);
  if (fallbacks.length > maxFallbacks) {
    throw new GatewayError(
      `Gateway request contains ${fallbacks.length} fallback targets; the configured maximum is ${maxFallbacks}.`,
      false
    );
  }

  validateTarget(request.primary, "Gateway primary target");
  fallbacks.forEach((target, index) =>
    validateTarget(target, `Gateway fallback target at index ${index}`)
  );

  if (
    request.maxCostPer1kTokens != null &&
    (!Number.isFinite(request.maxCostPer1kTokens) ||
      request.maxCostPer1kTokens < 0)
  ) {
    throw new GatewayError(
      "Gateway maxCostPer1kTokens must be a finite non-negative number.",
      false
    );
  }
};

const orderTargets = (
  mode: GatewayRoutingMode,
  intent: GatewayTaskIntent,
  primary: GatewayModelTarget,
  fallbacks: GatewayModelTarget[],
  config: GatewayConfig
) =>
  [primary, ...fallbacks]
    .filter(
      (target, index, list) =>
        list.findIndex((candidate) => candidate.provider === target.provider && candidate.modelId === target.modelId) === index
    )
    .map((target, index) => ({
      target,
      index,
      score: scoreTarget(mode, intent, target, primary, config)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ target }) => target);

const supportsRequiredCapabilities = (
  model: LanguageModel,
  requiredCapabilities: RouteRequiredCapabilities | undefined
) => {
  if (!requiredCapabilities) {
    return true;
  }

  return Object.entries(requiredCapabilities).every(
    ([key, required]) => required !== true || model.capabilities[key as keyof typeof model.capabilities] === true
  );
};

const agentTierRank = (tier: "tier-a" | "tier-b" | "tier-c" | undefined) =>
  tier === "tier-a" ? 3 : tier === "tier-b" ? 2 : tier === "tier-c" ? 1 : 0;

const supportsRequiredAgentCapabilities = (
  model: LanguageModel,
  requiredAgentCapabilities: GatewayAgentRequest["requiredAgentCapabilities"]
) => {
  if (!requiredAgentCapabilities) {
    return true;
  }

  const capabilities = model.capabilities.agentCapabilities;
  if (!capabilities) {
    return false;
  }

  return Object.entries(requiredAgentCapabilities).every(([key, value]) => {
    if (value == null) {
      return true;
    }

    if (key === "supportTier") {
      return agentTierRank(capabilities.supportTier) >= agentTierRank(value as typeof capabilities.supportTier);
    }

    return value !== true || capabilities[key as keyof typeof capabilities] === true;
  });
};

const costBudgetSkipReason = (
  config: GatewayConfig,
  request: Pick<GatewayRequest, "maxCostPer1kTokens">,
  target: GatewayModelTarget
): string | undefined => {
  if (request.maxCostPer1kTokens == null) {
    return undefined;
  }

  const configuredCost = config.providerCostsPer1kTokens?.[target.provider];
  const catalogCost = config.modelCatalog?.find(target.provider, target.modelId)?.costPer1kTokens;
  const effectiveCost = configuredCost ?? catalogCost;

  if (effectiveCost == null) {
    return config.unknownCostPolicy === "allow"
      ? undefined
      : "Skipped because model cost is unknown under the configured budget.";
  }
  if (!Number.isFinite(effectiveCost) || effectiveCost < 0) {
    throw new GatewayError(
      `Gateway cost for ${target.provider}/${target.modelId} must be a finite non-negative number.`,
      false
    );
  }

  return effectiveCost <= request.maxCostPer1kTokens
    ? undefined
    : "Skipped because provider cost exceeds the configured budget.";
};

const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.trim().length / 4));

const abortReason = (signal: AbortSignal): Error => {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("The gateway request was aborted.", "AbortError");
};

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal ? abortReason(signal) : new DOMException("The gateway request was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const createAttemptControl = (
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
) => {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutError = new GatewayError(`Provider timed out after ${timeoutMs}ms.`, true);
  const onParentAbort = () => controller.abort(parentSignal ? abortReason(parentSignal) : undefined);

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, timeoutMs);

  const stopTimeout = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const waitFor = <T>(promise: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        reject(controller.signal.reason instanceof Error ? controller.signal.reason : timeoutError);
      };

      if (controller.signal.aborted) {
        onAbort();
        return;
      }

      controller.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          if (settled) {
            return;
          }
          settled = true;
          controller.signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });

  return {
    signal: controller.signal,
    waitFor,
    timedOut: () => timedOut,
    timeoutError,
    stopTimeout,
    abort: (reason?: unknown) => controller.abort(reason),
    dispose: () => {
      stopTimeout();
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  };
};

const providerHTTPStatus = (error: unknown): number | undefined => {
  if (error instanceof ProviderHTTPError) {
    return error.status;
  }
  if (
    error instanceof Error &&
    error.name === "ProviderHTTPError" &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return undefined;
};

const redactSensitiveErrorMessage = (message: string): string =>
  message
    .replace(
      /([?&](?:api[-_]?key|key|token|access[-_]?token|secret)=)[^&#\s]*/gi,
      "$1[REDACTED]"
    )
    .replace(/\b(Bearer)\s+[a-z\d._~+/=-]+/gi, "$1 [REDACTED]");

const normalizeError = (error: unknown): ErrorDisposition => {
  if (error instanceof ValidationError || error instanceof ConflictError || error instanceof GuardrailTriggeredError) {
    return {
      error: new GatewayError(redactSensitiveErrorMessage(error.message), false),
      retrySameTarget: false,
      fallbackNextTarget: false
    };
  }

  if (error instanceof GatewayError) {
    return {
      error: new GatewayError(redactSensitiveErrorMessage(error.message), error.retryable),
      retrySameTarget: error.retryable,
      fallbackNextTarget: true
    };
  }

  const status = providerHTTPStatus(error);
  if (status != null) {
    const retryable = status === 408 || status === 429 || status >= 500;
    return {
      error: new GatewayError(
        error instanceof Error ? redactSensitiveErrorMessage(error.message) : `Provider HTTP ${status}.`,
        retryable
      ),
      retrySameTarget: retryable,
      fallbackNextTarget: true,
      retryAfterMs: error instanceof ProviderHTTPError ? error.retryAfterMs : undefined
    };
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return {
        error: new GatewayError(redactSensitiveErrorMessage(error.message), false),
        retrySameTarget: false,
        fallbackNextTarget: false
      };
    }

    const message = error.message.toLowerCase();
    const retryable =
      message.includes("timed out") ||
      message.includes("timeout") ||
      message.includes("429") ||
      message.includes("rate limit") ||
      message.includes("connect") ||
      message.includes("econnrefused") ||
      message.includes("enotfound") ||
      message.includes("network") ||
      /\b50[0234]\b/.test(message);
    return {
      error: new GatewayError(redactSensitiveErrorMessage(error.message), retryable),
      retrySameTarget: retryable,
      fallbackNextTarget: true
    };
  }

  return {
    error: new GatewayError("Unknown gateway error.", false),
    retrySameTarget: false,
    fallbackNextTarget: true
  };
};

const getAttemptTimeoutMs = (config: GatewayConfig, provider: GatewayProviderId) => {
  const timeoutMs = config.attemptTimeoutsMs?.[provider] ?? config.attemptTimeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new GatewayError("Gateway attempt timeouts must be finite positive numbers.", false);
  }
  return timeoutMs;
};

const getStreamIdleTimeoutMs = (
  config: GatewayConfig,
  provider: GatewayProviderId
) => {
  const timeoutMs =
    config.streamIdleTimeoutsMs?.[provider] ??
    config.streamIdleTimeoutMs ??
    DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (timeoutMs === false) {
    return false;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new GatewayError(
      "Gateway stream idle timeouts must be finite positive numbers or false.",
      false
    );
  }
  return timeoutMs;
};

const getMaxRetries = (config: GatewayConfig) => {
  return boundedInteger("Gateway maxRetries", config.maxRetries, 2, {
    min: 0,
    max: MAX_MAX_RETRIES
  });
};

const retryBackoffMs = (config: GatewayConfig, retry: number, retryAfterMs?: number) => {
  const base = config.retryBackoffMs ?? 200;
  if (!Number.isFinite(base) || base < 0) {
    throw new GatewayError("Gateway retryBackoffMs must be a finite non-negative number.", false);
  }
  const serverDelay = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? retryAfterMs : 0;
  return Math.min(60_000, Math.max(base * (retry + 1), serverDelay));
};

const createAttempt = (
  target: GatewayModelTarget,
  ok: boolean,
  latencyMs: number,
  targetRank: number,
  options: Pick<GatewayAttempt, "errorMessage" | "reasonCode" | "retry" | "usage"> = {}
): GatewayAttempt => ({
  provider: target.provider,
  modelId: target.modelId,
  ok,
  latencyMs,
  targetRank,
  ...options
});

const runBoundedObserver = (
  config: GatewayConfig,
  parentSignal: AbortSignal | undefined,
  observer: (signal: AbortSignal) => void | Promise<void>
) => {
  const controller = new AbortController();
  let releaseBoundary: (() => void) | undefined;
  const boundary = new Promise<void>((resolve) => {
    releaseBoundary = resolve;
  });
  const onParentAbort = () => {
    controller.abort(
      parentSignal ? abortReason(parentSignal) : new DOMException("Gateway request aborted.", "AbortError")
    );
    releaseBoundary?.();
  };
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const timeoutMs = getObserverTimeoutMs(config);
  const timer = setTimeout(() => {
    controller.abort(
      new GatewayError(`Gateway observer timed out after ${timeoutMs}ms.`, false)
    );
    releaseBoundary?.();
  }, timeoutMs);

  const cleanup = () => {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  };

  let observerResult: void | Promise<void>;
  try {
    observerResult = observer(controller.signal);
  } catch {
    cleanup();
    return;
  }
  const completion = Promise.resolve(observerResult).catch(() => undefined);
  void Promise.race([completion, boundary]).finally(cleanup);
};

const notifyAttempt = async (
  config: GatewayConfig,
  attempt: GatewayAttempt,
  parentSignal?: AbortSignal
) => {
  if (!config.onAttempt) {
    return;
  }
  runBoundedObserver(config, parentSignal, (abortSignal) =>
    config.onAttempt?.({
      ...attempt,
      retry: attempt.retry ?? 0,
      targetRank: attempt.targetRank ?? 0,
      abortSignal
    })
  );
};

const normalizeUsage = (
  usage: TokenUsage | undefined,
  inputText: string,
  outputText: string
) => {
  const inputTokens = usage?.inputTokens ?? estimateTokens(inputText);
  const outputTokens = usage?.outputTokens ?? estimateTokens(outputText);
  const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
  return {
    ...usage,
    inputTokens,
    outputTokens,
    totalTokens,
    estimated: usage?.inputTokens == null || usage?.outputTokens == null || usage?.totalTokens == null
  };
};

const getInputText = (request: GatewayRequest) =>
  `${request.systemPrompt ?? ""}\n${request.messages.map((message) => "parts" in message ? JSON.stringify(message.parts) : message.content).join("\n")}`.trim();

const requestHasImages = (request: { messages?: GatewayRequest["messages"] }) =>
  request.messages?.some((message) => "parts" in message ? message.parts.some((part) => part.type === "image") : (message.images?.length ?? 0) > 0) ?? false;

const requestHasToolHistory = (request: Pick<RouteRequest, "messages">) =>
  request.messages?.some((message) => "parts" in message && hasToolHistory([message])) ?? false;

// Native Anthropic support predates the optional capability. New adapters opt in explicitly.
const historyTransport = (model: LanguageModel) =>
  model.capabilities.toolHistory ?? (model.provider === "anthropic" ? "native" : undefined);

const historySkipReason = (model: LanguageModel, history: boolean) =>
  history && (!historyTransport(model) || !model.capabilities.tools)
    ? "Skipped because model does not support the gateway tool history contract."
    : undefined;

const historyInputSkipReason = (model: LanguageModel, input: ModelGenerateInput) => {
  if (!hasToolHistory(input.messages)) return undefined;
  if (historyTransport(model) === "json" && input.messages.some((message) => {
    let seenCall = false;
    return message.parts.some((part) => {
      if (part.type === "tool-call") seenCall = true;
      return seenCall && part.type === "text";
    });
  })) return "Skipped because the destination cannot preserve text interleaved after tool calls.";
  if (model.provider !== "deepseek" && model.provider !== "qwen") return undefined;
  const options = input.providerOptions ?? {};
  const thinking = options.thinking as { type?: string } | undefined;
  if ((input.reasoning && (input.reasoning.effort !== "none" || input.reasoning.includeThoughts)) ||
      thinking?.type === "enabled" || options.enable_thinking === true ||
      (options.reasoning_effort !== undefined && options.reasoning_effort !== "none") ||
      options.thinking_budget !== undefined) {
    return "Skipped because portable tool history cannot replay provider-specific thinking state.";
  }
  return undefined;
};

const prepareHistoryInput = (model: LanguageModel, input: ModelGenerateInput, enabled: boolean): ModelGenerateInput => {
  if (!enabled) return input;
  const providerOptions = { ...(input.providerOptions ?? {}) };
  // Portable replay contains no private reasoning state. Default these hybrid models to non-thinking.
  if (model.provider === "deepseek") providerOptions.thinking = { type: "disabled" };
  if (model.provider === "qwen") providerOptions.enable_thinking = false;
  return {
    ...input,
    messages: structuredClone(input.messages),
    toolResultFormat: historyTransport(model) === "json" ? "envelope" : input.toolResultFormat,
    providerOptions
  };
};

const historySignals = new WeakMap<AbortSignal, AbortSignal>();
const historyAbortSignal = (signal?: AbortSignal): AbortSignal | undefined => {
  if (!signal) return undefined;
  const existing = historySignals.get(signal);
  if (existing) return existing;
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Gateway request aborted.", "AbortError"));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  historySignals.set(signal, controller.signal);
  return controller.signal;
};

const prepareAgentHistoryRequest = (request: GatewayAgentRequest): GatewayAgentRequest => {
  if (request.prompt !== undefined && request.messages !== undefined) throw new GatewayError("Pass prompt or messages, not both.", false);
  if (!request.messages?.some(message => "parts" in message)) return request;
  validateGatewayMessages(request.messages);
  if (request.state || request.runId || request.handoff || request.approvals || request.idempotencyKey) {
    throw new GatewayError("Import canonical agent history as a fresh run; resume durable state using state or runId without messages or an import idempotency key.", false);
  }
  return { ...request, metadata: { ...request.metadata, gatewayPortableHistory: true }, abortSignal: historyAbortSignal(request.abortSignal) };
};

const agentHistoryStore = (store: GatewayAgentRequest["store"], context: RouteContext, binding?: string): GatewayAgentRequest["store"] => store ? new Proxy(store, {
  get(target, key) {
    const value = Reflect.get(target, key);
    if (key === "load") return async (...args: Parameters<typeof target.load>) => {
      const state = await target.load(...args);
      if (state && binding !== undefined && state.metadata?.gatewayAgentRouteBinding !== binding) throw new ConflictError("Agent state belongs to a different gateway route binding.");
      if (state?.metadata?.gatewayPortableHistory === true) context.toolHistory = true;
      return state;
    };
    if (key === "claimIdempotencyKey" && target.claimIdempotencyKey) return async (...args: Parameters<NonNullable<typeof target.claimIdempotencyKey>>) => {
      const claim = await target.claimIdempotencyKey!(...args);
      if (binding !== undefined && claim.state.metadata?.gatewayAgentRouteBinding !== binding) throw new ConflictError("Agent idempotency key belongs to a different gateway route binding.");
      if (claim.state.metadata?.gatewayPortableHistory === true) context.toolHistory = true;
      return claim;
    };
    return typeof value === "function" ? value.bind(target) : value;
  }
}) : undefined;

const buildRequiredCapabilities = (
  request: Pick<GatewayRequest, "requiredCapabilities" | "tools" | "toolChoice" | "reasoning"> & {
    messages?: GatewayRequest["messages"];
  },
  extra: NonNullable<GatewayRequest["requiredCapabilities"]> = {}
): RouteRequiredCapabilities => ({
  ...(request.requiredCapabilities ?? {}),
  ...(request.tools || requestHasToolHistory(request) ? { tools: true } : {}),
  ...(request.toolChoice ? { toolChoice: true } : {}),
  ...(request.reasoning ? { reasoning: true } : {}),
  ...(requestHasImages(request) ? { vision: true } : {}),
  ...extra
});

const objectCapabilitySkipReason = <TSchema extends ZodTypeAny>(
  model: LanguageModel,
  request: GatewayGenerateObjectRequest<TSchema>
): string | undefined => {
  const mode = request.mode ?? "auto";

  if (mode === "native" && !model.capabilities.structuredOutput) {
    return "Skipped because model capabilities do not satisfy native structured output.";
  }
  if (mode === "prompted" && !model.capabilities.jsonMode) {
    return "Skipped because model capabilities do not satisfy prompted JSON output.";
  }
  if (mode === "auto" && !model.capabilities.structuredOutput && !model.capabilities.jsonMode) {
    return "Skipped because model capabilities do not satisfy object output.";
  }
  return undefined;
};

const modelInputSkipReason = (model: LanguageModel, input: ModelGenerateInput): string | undefined => {
  if ((input.tools || hasToolHistory(input.messages)) && !model.capabilities.tools) {
    return "Skipped because model does not support tools.";
  }
  if (input.reasoning && !model.capabilities.reasoning) {
    return "Skipped because model does not support reasoning.";
  }
  if (
    input.messages.some((message) => message.parts.some((part) => part.type === "image")) &&
    !model.capabilities.vision
  ) {
    return "Skipped because model does not support image input.";
  }
  if (input.structuredOutput?.mode === "native" && !model.capabilities.structuredOutput) {
    return "Skipped because model does not support native structured output.";
  }
  return undefined;
};

const createTextOptions = (model: LanguageModel, request: GatewayRequest): GenerateTextOptions => ({
  model,
  messages: gatewayMessagesToModelMessages(request.messages, request.systemPrompt),
  tools: request.tools,
  toolChoice: request.toolChoice,
  toolExecution: request.toolExecution,
  maxSteps: request.maxSteps,
  temperature: request.temperature,
  maxTokens: request.maxTokens,
  reasoning: request.reasoning,
  providerOptions: request.providerOptions,
  abortSignal: requestHasToolHistory(request) ? historyAbortSignal(request.abortSignal) : request.abortSignal
});

const enrichTextResult = (
  request: GatewayRequest,
  target: GatewayModelTarget,
  attempts: GatewayAttempt[],
  routeDecision: GatewayResponse["routeDecision"],
  startedAt: number,
  result: GenerateTextOutput
): GatewayResponse => ({
  ...result,
  providerUsed: target.provider,
  modelUsed: target.modelId,
  latencyMs: Date.now() - startedAt,
  attempts: [...attempts],
  usage: normalizeUsage(result.usage, getInputText(request), result.text),
  routeDecision
});

const enrichObjectResult = <TSchema extends ZodTypeAny>(
  request: GatewayRequest,
  target: GatewayModelTarget,
  attempts: GatewayAttempt[],
  routeDecision: GatewayResponse["routeDecision"],
  startedAt: number,
  result: GenerateObjectOutput<TSchema>
): GatewayObjectResponse<TSchema> => ({
  ...result,
  providerUsed: target.provider,
  modelUsed: target.modelId,
  latencyMs: Date.now() - startedAt,
  attempts: [...attempts],
  usage: normalizeUsage(result.usage, getInputText(request), result.text),
  routeDecision
});

const createAgentMessages = (request: GatewayAgentRequest) =>
  request.messages ? gatewayMessagesToModelMessages(request.messages, undefined) : undefined;

const createAgentRunInput = (request: GatewayAgentRequest) => {
  const source =
    request.prompt !== undefined
      ? { prompt: request.prompt }
      : request.messages
        ? { messages: createAgentMessages(request) }
        : {};

  return {
    ...source,
    runId: request.runId,
    scope: request.scope,
    idempotencyKey: request.idempotencyKey,
    parentRunId: request.parentRunId,
    system: request.system,
    state: request.state,
    approvals: request.approvals,
    handoff: request.handoff,
    tools: request.tools,
    toolChoice: request.toolChoice,
    toolExecution: request.toolExecution,
    toolApprovalPolicy: request.toolApprovalPolicy,
    maxSteps: request.maxSteps,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    reasoning: request.reasoning,
    providerOptions: request.providerOptions,
    policy: request.policy,
    metadata: request.metadata,
    context: request.context,
    compaction: request.compaction,
    executionEnvironment: request.executionEnvironment,
    abortSignal: request.abortSignal
  };
};

const enrichAgentResult = (
  target: GatewayModelTarget,
  attempts: GatewayAttempt[],
  routeDecision: GatewayResponse["routeDecision"],
  startedAt: number,
  result: AgentRunOutput
): GatewayAgentResponse => ({
  ...result,
  providerUsed: target.provider,
  modelUsed: target.modelId,
  latencyMs: Date.now() - startedAt,
  attempts: [...attempts],
  routeDecision,
  state: {
    ...result.state,
    routeDecision
  }
});

export const createGateway = (config: GatewayConfig) => {
  if (config.adaptiveRouting) {
    validateAdaptivePolicy(config.adaptiveRouting);
    if (config.scoreTarget) throw new GatewayError("Choose adaptiveRouting or scoreTarget, not both.", false);
  }
  const configuredAgentRequest = (request: GatewayAgentRequest): GatewayAgentRequest => {
    const definition = request.agent;
    if (!definition) return request;
    const defaults = {
      agentId: definition.id, instructions: definition.instructions, tools: Array.isArray(definition.tools) ? Object.fromEntries(definition.tools.map(tool => [tool.name, tool])) : definition.tools,
      maxSteps: definition.maxSteps, temperature: definition.temperature, maxTokens: definition.maxTokens,
      reasoning: definition.reasoning, toolExecution: definition.toolExecution, toolApprovalPolicy: definition.toolApprovalPolicy,
      providerOptions: definition.providerOptions, store: definition.store, memory: definition.memory,
      onTelemetryEvent: definition.onTelemetryEvent, hookFailurePolicy: definition.hookFailurePolicy,
      compaction: definition.compaction, executionEnvironment: definition.executionEnvironment
    };
    const merged = { ...defaults, ...Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined)),
      policy: { ...definition.policy, ...request.policy }, metadata: { ...definition.metadata, ...request.metadata }
    } as GatewayAgentRequest;
    const binding = JSON.stringify([1, merged.agentId ?? null, request.primary, request.fallbacks ?? [], config.adaptiveRouting?.version ?? "legacy", definition.harness?.fingerprint ?? null]);
    merged.metadata = { ...merged.metadata, gatewayAgentRouteBinding: binding };
    if (request.state && request.state.metadata?.gatewayAgentRouteBinding !== binding) throw new ConflictError("Agent state belongs to a different gateway route binding.");
    return merged;
  };

  const beginMetrics = (target: GatewayModelTarget, signal?: AbortSignal) => {
    let handle: GatewayMetricsHandle | undefined;
    try { handle = config.metrics?.begin(target); } catch { /* Metrics cannot affect execution. */ }
    let ended = false;
    const end = (outcome: GatewayMetricOutcome) => {
      if (ended) return; ended = true;
      signal?.removeEventListener("abort", onAbort);
      try { handle?.end(outcome); } catch { /* Best effort. */ }
    };
    const onAbort = () => end("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    return { end, firstText: () => { try { handle?.firstText(); } catch { /* Best effort. */ } } };
  };
  if (config.costAccounting && !config.modelCatalog) throw new GatewayError("costAccounting requires a modelCatalog snapshot.", false);
  if (config.costAccounting?.unknownCostPolicy !== undefined && !["allow", "reject"].includes(config.costAccounting.unknownCostPolicy)) throw new GatewayError("Invalid detailed unknownCostPolicy.", false);
  if (config.costAccounting?.cacheAssumption !== undefined && !["reported", "none"].includes(config.costAccounting.cacheAssumption)) throw new GatewayError("Invalid cacheAssumption.", false);
  const createRouteContext = (
    request: RouteRequest,
    options: {
      defaultIntent?: GatewayTaskIntent;
      extraRequiredCapabilities?: NonNullable<GatewayRequest["requiredCapabilities"]>;
      getSkipReason?: (model: LanguageModel, target: GatewayModelTarget) => RouteSkip | undefined;
      onWinner?: (
        candidate: RouteCandidate,
        attempts: GatewayAttempt[],
        abortSignal: AbortSignal
      ) => void | Promise<void>;
    } = {}
  ): RouteContext => {
    validateRouteRequest(config, request);
    const mode = request.routingMode ?? "balanced";
    const intent = request.taskIntent ?? options.defaultIntent ?? "chat";
    const orderedTargets = config.adaptiveRouting
      ? [request.primary, ...(request.fallbacks ?? [])].filter((target, index, all) => all.findIndex(x => x.provider === target.provider && x.modelId === target.modelId) === index)
      : orderTargets(mode, intent, request.primary, request.fallbacks ?? [], config);
    const routeDecision = createRouteDecision(mode, intent, orderedTargets);
    if (config.costAccounting) {
      routeDecision.estimatedCosts = orderedTargets.map(target => calculateModelCost({
        catalog: config.modelCatalog!, ...target,
        usage: {
          inputTokens: estimateTokens([request.systemPrompt, request.system, request.instructions, request.prompt, JSON.stringify(request.messages ?? [])].filter(Boolean).join("\n")),
          outputTokens: config.costAccounting!.expectedOutputTokens ?? request.maxTokens
        },
        cacheAssumption: "none", estimated: true
      }));
    }
    const attempts: GatewayAttempt[] = [];
    const candidates: RouteCandidate[] = [];
    let notificationChain = Promise.resolve();

    const queueAttempt = (attempt: GatewayAttempt) => {
      attempt = { ...attempt, ...(attempt.errorMessage !== undefined
        ? { errorMessage: redactSensitiveErrorMessage(attempt.errorMessage) } : {}) };
      attempts.push(attempt);
      notificationChain = notificationChain.then(() =>
        notifyAttempt(config, attempt, request.abortSignal)
      );
    };

    const requiredCapabilities = buildRequiredCapabilities(
      request,
      options.extraRequiredCapabilities ?? {}
    );

    for (const [targetRank, target] of orderedTargets.entries()) {
      const adapter = config.adapters[target.provider];
      if (!adapter) {
        queueAttempt(
          createAttempt(target, false, 0, targetRank, {
            reasonCode: "operation-skip",
            errorMessage: `Skipped because no adapter is registered for provider "${target.provider}".`
          })
        );
        continue;
      }

      let model: LanguageModel;
      try {
        model = adapter.languageModel(target.modelId);
      } catch (error) {
        queueAttempt(
          createAttempt(target, false, 0, targetRank, {
            reasonCode: "operation-skip",
            errorMessage: !requestHasToolHistory(request) && error instanceof Error ? error.message : "Provider model construction failed."
          })
        );
        continue;
      }

      if (!supportsRequiredCapabilities(model, requiredCapabilities)) {
        queueAttempt(
          createAttempt(target, false, 0, targetRank, {
            reasonCode: "model-capabilities",
            errorMessage: "Skipped because model capabilities do not satisfy the request."
          })
        );
        continue;
      }

      const historyReason = historySkipReason(model, requestHasToolHistory(request));
      if (historyReason) {
        queueAttempt(createAttempt(target, false, 0, targetRank, {
          reasonCode: "model-capabilities",
          errorMessage: historyReason
        }));
        continue;
      }

      const budgetReason = costBudgetSkipReason(config, request, target);
      if (budgetReason) {
        queueAttempt(
          createAttempt(target, false, 0, targetRank, {
            reasonCode: "cost-budget",
            errorMessage: budgetReason
          })
        );
        continue;
      }

      if (config.costAccounting?.unknownCostPolicy === "reject" && routeDecision.estimatedCosts?.[targetRank]?.status === "unknown") {
        queueAttempt(createAttempt(target, false, 0, targetRank, { reasonCode: "cost-budget", errorMessage: "Skipped because detailed request cost is unknown." }));
        continue;
      }

      const skip = options.getSkipReason?.(model, target);
      if (skip) {
        queueAttempt(
          createAttempt(target, false, 0, targetRank, {
            reasonCode: skip.reasonCode,
            errorMessage: skip.message
          })
        );
        continue;
      }

      candidates.push({ target, targetRank, model });
    }

    if (config.adaptiveRouting) {
      const policy = config.adaptiveRouting;
      const evaluated = orderedTargets.map((target, index) => {
        const candidate = candidates.find(x => x.target === target);
        let snapshot;
        try { snapshot = config.metrics?.snapshot(target); } catch { /* Treat unavailable metrics as cold start. */ }
        const evaluation = scoreAdaptiveTarget(policy, target, intent, snapshot, routeDecision.estimatedCosts?.[index]);
        if (!candidate) evaluation.exclusions.push(...attempts.filter(x => x.provider === target.provider && x.modelId === target.modelId).map(x => x.reasonCode ?? "operation-skip"));
        if (config.circuitBreaker && !config.circuitBreaker.canAttempt(target)) evaluation.exclusions.push("circuit-open");
        if (evaluation.exclusions.length && candidate) queueAttempt(createAttempt(target, false, 0, index, { reasonCode: evaluation.exclusions.includes("circuit-open") ? "circuit-open" : "operation-skip", errorMessage: `Adaptive exclusion: ${evaluation.exclusions.join(", ")}.` }));
        return evaluation;
      });
      routeDecision.reasonCode = "routing-adaptive";
      routeDecision.adaptive = { policyVersion: policy.version, candidates: evaluated };
      const eligible = candidates.filter(candidate => !evaluated.find(x => x.target.provider === candidate.target.provider && x.target.modelId === candidate.target.modelId)!.exclusions.length);
      eligible.sort((left, right) => evaluated.find(x => x.target.provider === right.target.provider && x.target.modelId === right.target.modelId)!.score! - evaluated.find(x => x.target.provider === left.target.provider && x.target.modelId === left.target.modelId)!.score! || left.targetRank - right.targetRank);
      candidates.splice(0, candidates.length, ...eligible);
      candidates.forEach((candidate, index) => { candidate.targetRank = index; });
      routeDecision.orderedTargets = candidates.map(x => x.target);
      routeDecision.reason = `Ordered by adaptive policy ${policy.version}; ties preserve request order.`;
    }

    if (!candidates.length) {
      if (attempts.at(-1)?.reasonCode === "circuit-open") throw new GatewayCircuitOpenError();
      throw new GatewayError(
        attempts.at(-1)?.errorMessage ?? "No gateway target satisfied the request.",
        false
      );
    }

    const context: RouteContext = {
      toolHistory: requestHasToolHistory(request),
      attempts,
      candidates,
      routeDecision,
      startedAt: Date.now(),
      flushAttempts: () => notificationChain,
      recordAttempt: async (attempt) => {
        if (config.costAccounting && ["provider-success", "provider-error", "request-aborted"].includes(attempt.reasonCode ?? "")) {
          const costInput = { catalog: config.modelCatalog!, provider: attempt.provider, modelId: attempt.modelId };
          try {
            attempt = { ...attempt, cost: calculateModelCost({ ...costInput, usage: attempt.usage, cacheAssumption: config.costAccounting.cacheAssumption, reasoningAccounting: config.costAccounting.reasoningAccounting?.[attempt.provider] }) };
          } catch {
            // Accounting cannot turn a successful model invocation into a retry.
            const cost = calculateModelCost(costInput);
            cost.unknownReasons.push("invalid-reported-usage");
            attempt = { ...attempt, cost };
          }
        }
        queueAttempt(attempt);
        await notificationChain;
      },
      lock: async (candidate) => {
        if (
          context.winner?.target.provider === candidate.target.provider &&
          context.winner.target.modelId === candidate.target.modelId
        ) {
          return;
        }
        context.winner = candidate;
        if (options.onWinner) {
          runBoundedObserver(config, request.abortSignal, (abortSignal) =>
            options.onWinner?.(candidate, [...attempts], abortSignal)
          );
        }
      }
    };

    return context;
  };

  const createRoutedLanguageModel = (context: RouteContext): LanguageModel => {
    const first = context.candidates[0]!;
    const maxTotalAttempts = getMaxTotalAttempts(config);
    let totalProviderAttempts = 0;
    const prepareInput = (model: LanguageModel, input: ModelGenerateInput): ModelGenerateInput => {
      const structured = input.structuredOutput;
      if (!context.autoObject || !structured || model.capabilities.structuredOutput) return input;
      return {
        ...input,
        structuredOutput: undefined,
        messages: [...input.messages, createTextMessage("system", createStructuredOutputPrompt(structured.schema, {
          name: structured.name, description: structured.description
        }))]
      };
    };
    const dispositionFor = (error: unknown): ErrorDisposition => {
      const disposition = normalizeError(error);
      if (context.toolHistory) {
        disposition.error = new GatewayError(
          "Gateway provider failed while continuing tool history.",
          disposition.error.retryable
        );
      }
      return disposition;
    };

    const reserveProviderAttempt = () => {
      if (totalProviderAttempts >= maxTotalAttempts) {
        throw new GatewayError(
          `Gateway operation exceeded the configured maximum of ${maxTotalAttempts} provider attempts.`,
          false
        );
      }
      totalProviderAttempts += 1;
    };

    const recordInputSkip = async (candidate: RouteCandidate, message: string) => {
      await context.recordAttempt(
        createAttempt(candidate.target, false, 0, candidate.targetRank, {
          reasonCode: "operation-skip",
          errorMessage: message
        })
      );
    };

    const throwFinalError = (): never => {
      if (context.attempts.at(-1)?.reasonCode === "circuit-open") throw new GatewayCircuitOpenError();
      throw new GatewayError(
        context.attempts.at(-1)?.errorMessage ?? "All gateway attempts failed.",
        false
      );
    };

    const generate = async (input: ModelGenerateInput): Promise<GenerateResult> => {
      await context.flushAttempts();
      const candidates = context.winner
        ? [context.winner, ...context.candidates.filter((candidate) => candidate !== context.winner)]
        : context.candidates;
      const maxRetries = getMaxRetries(config);

      for (const candidate of candidates) {
        const candidateInput = prepareInput(candidate.model, input);
        const inputSkipReason = modelInputSkipReason(candidate.model, candidateInput) ??
          (context.toolHistory ? historySkipReason(candidate.model, hasToolHistory(input.messages)) ?? historyInputSkipReason(candidate.model, input) : undefined);
        if (inputSkipReason) {
          await recordInputSkip(candidate, inputSkipReason);
          continue;
        }

        for (let retry = 0; retry <= maxRetries; retry += 1) {
          const timeoutMs = getAttemptTimeoutMs(config, candidate.target.provider);
          const permit = config.circuitBreaker?.acquire(candidate.target);
          if (config.circuitBreaker && !permit) {
            await context.recordAttempt(createAttempt(candidate.target, false, 0, candidate.targetRank, { reasonCode: "circuit-open", errorMessage: "Destination circuit is open or probe capacity is exhausted." }));
            break;
          }
          try { reserveProviderAttempt(); } catch (error) { permit?.end("neutral"); throw error; }
          const attemptStartedAt = Date.now();
          const control = createAttemptControl(
            input.abortSignal,
            timeoutMs
          );
          const metrics = beginMetrics(candidate.target, input.abortSignal);

          try {
            const result = await control.waitFor(
              candidate.model.generate({
                ...prepareHistoryInput(candidate.model, candidateInput, context.toolHistory),
                abortSignal: control.signal
              })
            );
            control.stopTimeout();
            metrics.end("success");
            permit?.end("success");
            await context.recordAttempt(
              createAttempt(candidate.target, true, Date.now() - attemptStartedAt, candidate.targetRank, {
                retry,
                reasonCode: "provider-success",
                ...(config.costAccounting ? { usage: result.usage } : {})
              })
            );
            await context.lock(candidate);
            control.dispose();
            return result;
          } catch (rawError) {
            const callerAborted = input.abortSignal?.aborted === true;
            metrics.end(callerAborted ? "cancelled" : "error");
            const error = control.timedOut() ? control.timeoutError : rawError;
            control.abort(error);
            control.dispose();

            if (callerAborted) {
              permit?.end("neutral");
              await context.recordAttempt(
                createAttempt(candidate.target, false, Date.now() - attemptStartedAt, candidate.targetRank, {
                  retry,
                  reasonCode: "request-aborted",
                  errorMessage: abortReason(input.abortSignal!).message
                })
              );
              throw abortReason(input.abortSignal!);
            }

            const disposition = dispositionFor(error);
            permit?.end(disposition.retrySameTarget ? "retryable-error" : "neutral", disposition.retryAfterMs);
            await context.recordAttempt(
              createAttempt(candidate.target, false, Date.now() - attemptStartedAt, candidate.targetRank, {
                retry,
                reasonCode: "provider-error",
                errorMessage: disposition.error.message
              })
            );

            if (config.circuitBreaker?.snapshot(candidate.target)?.state === "open") break;
            if (retry < maxRetries && disposition.retrySameTarget) {
              await abortableSleep(retryBackoffMs(config, retry, disposition.retryAfterMs), input.abortSignal);
              continue;
            }
            if (!disposition.fallbackNextTarget) {
              throw disposition.error;
            }
            break;
          }
        }
      }

      return throwFinalError();
    };

    const stream = async (input: ModelGenerateInput): Promise<AsyncIterable<StreamEvent>> => {
      await context.flushAttempts();
      const candidates = context.winner
        ? [context.winner, ...context.candidates.filter((candidate) => candidate !== context.winner)]
        : context.candidates;
      const maxRetries = getMaxRetries(config);

      for (const candidate of candidates) {
        const candidateInput = prepareInput(candidate.model, input);
        const inputSkipReason = modelInputSkipReason(candidate.model, candidateInput) ??
          (context.toolHistory ? historySkipReason(candidate.model, hasToolHistory(input.messages)) ?? historyInputSkipReason(candidate.model, input) : undefined);
        if (inputSkipReason) {
          await recordInputSkip(candidate, inputSkipReason);
          continue;
        }
        if (!candidate.model.stream) {
          await recordInputSkip(candidate, "Skipped because model does not support streaming.");
          continue;
        }

        for (let retry = 0; retry <= maxRetries; retry += 1) {
          const timeoutMs = getAttemptTimeoutMs(config, candidate.target.provider);
          const permit = config.circuitBreaker?.acquire(candidate.target);
          if (config.circuitBreaker && !permit) {
            await context.recordAttempt(createAttempt(candidate.target, false, 0, candidate.targetRank, { reasonCode: "circuit-open", errorMessage: "Destination circuit is open or probe capacity is exhausted." }));
            break;
          }
          try { reserveProviderAttempt(); } catch (error) { permit?.end("neutral"); throw error; }
          const attemptStartedAt = Date.now();
          const control = createAttemptControl(
            input.abortSignal,
            timeoutMs
          );
          let iterator: AsyncIterator<StreamEvent> | undefined;
          const metrics = beginMetrics(candidate.target, input.abortSignal);

          try {
            const providerStream = await control.waitFor(
              candidate.model.stream({
                ...prepareHistoryInput(candidate.model, candidateInput, context.toolHistory),
                abortSignal: control.signal
              })
            );
            iterator = providerStream[Symbol.asyncIterator]();
            const firstEvent = await control.waitFor(iterator.next());

            if (firstEvent.done) {
              throw new GatewayError("Provider stream ended before emitting an event.", false);
            }
            if (firstEvent.value.type === "error") {
              throw firstEvent.value.error;
            }
            if (firstEvent.value.type === "text-delta") metrics.firstText();

            control.stopTimeout();
            await context.lock(candidate);
            const streamIdleTimeoutMs = getStreamIdleTimeoutMs(
              config,
              candidate.target.provider
            );
            const nextEvent = async () => {
              if (streamIdleTimeoutMs === false) {
                return control.waitFor(iterator!.next());
              }
              const idleError = new GatewayError(
                `Provider stream was idle for more than ${streamIdleTimeoutMs}ms.`,
                false
              );
              const timer = setTimeout(
                () => control.abort(idleError),
                streamIdleTimeoutMs
              );
              try {
                return await control.waitFor(iterator!.next());
              } finally {
                clearTimeout(timer);
              }
            };

            return (async function* () {
              let completed = false;
              let usage: TokenUsage | undefined = firstEvent.value.type === "finish" ? firstEvent.value.usage : undefined;
              try {
                yield firstEvent.value;
                for (;;) {
                  const next = await nextEvent();
                  if (next.done) {
                    completed = true;
                    metrics.end("success");
                    permit?.end("success");
                    await context.recordAttempt(createAttempt(candidate.target, true, Date.now() - attemptStartedAt, candidate.targetRank, {
                      retry, reasonCode: "provider-success", ...(config.costAccounting ? { usage } : {})
                    }));
                    return;
                  }
                  if (next.value.type === "error") throw next.value.error;
                  if (next.value.type === "text-delta") metrics.firstText();
                  if (next.value.type === "finish" && next.value.usage) usage = { ...usage, ...next.value.usage };
                  yield next.value;
                }
              } catch (error) {
                const aborted = input.abortSignal?.aborted === true;
                metrics.end(aborted ? "cancelled" : "error");
                const disposition = dispositionFor(error);
                permit?.end(aborted ? "neutral" : disposition.retrySameTarget ? "retryable-error" : "neutral", disposition.retryAfterMs);
                const diagnostic = disposition.error;
                const failure = aborted ? abortReason(input.abortSignal!) : context.toolHistory ? diagnostic : error;
                await context.recordAttempt(createAttempt(candidate.target, false, Date.now() - attemptStartedAt, candidate.targetRank, {
                  retry,
                  ...(config.costAccounting ? { usage } : {}),
                  reasonCode: aborted ? "request-aborted" : "provider-error",
                  errorMessage: aborted ? abortReason(input.abortSignal!).message : diagnostic.message
                }));
                throw failure;
              } finally {
                if (!completed) {
                  metrics.end("cancelled");
                  permit?.end("neutral");
                  control.abort(new DOMException("Gateway stream consumer closed.", "AbortError"));
                }
                control.dispose();
                // Cleanup is best-effort: an iterator may ignore abort while next() is pending.
                // Never let return() mask the original failure or hold collect() open.
                if (iterator?.return) {
                  try {
                    void Promise.resolve(iterator.return()).catch(() => undefined);
                  } catch { /* Synchronous cleanup failures are also best-effort. */ }
                }
              }
            })();
          } catch (rawError) {
            const callerAborted = input.abortSignal?.aborted === true;
            metrics.end(callerAborted ? "cancelled" : "error");
            const error = control.timedOut() ? control.timeoutError : rawError;
            control.abort(error);
            control.dispose();
            if (iterator?.return) {
              try {
                void Promise.resolve(iterator.return()).catch(() => undefined);
              } catch { /* Cleanup must not prevent fallback. */ }
            }

            if (callerAborted) {
              permit?.end("neutral");
              await context.recordAttempt(
                createAttempt(candidate.target, false, Date.now() - attemptStartedAt, candidate.targetRank, {
                  retry,
                  reasonCode: "request-aborted",
                  errorMessage: abortReason(input.abortSignal!).message
                })
              );
              throw abortReason(input.abortSignal!);
            }

            const disposition = dispositionFor(error);
            permit?.end(disposition.retrySameTarget ? "retryable-error" : "neutral", disposition.retryAfterMs);
            await context.recordAttempt(
              createAttempt(candidate.target, false, Date.now() - attemptStartedAt, candidate.targetRank, {
                retry,
                reasonCode: "provider-error",
                errorMessage: disposition.error.message
              })
            );

            if (config.circuitBreaker?.snapshot(candidate.target)?.state === "open") break;
            if (retry < maxRetries && disposition.retrySameTarget) {
              await abortableSleep(retryBackoffMs(config, retry, disposition.retryAfterMs), input.abortSignal);
              continue;
            }
            if (!disposition.fallbackNextTarget) {
              throw disposition.error;
            }
            break;
          }
        }
      }

      return throwFinalError();
    };

    return {
      get provider() {
        return context.winner?.model.provider ?? first.model.provider;
      },
      get modelId() {
        return context.winner?.model.modelId ?? first.model.modelId;
      },
      get capabilities() {
        const capabilities = context.winner?.model.capabilities ?? first.model.capabilities;
        // Keep the schema in Core input; each destination resolves auto independently.
        return context.autoObject ? { ...capabilities, structuredOutput: true } : capabilities;
      },
      generate,
      stream
    };
  };

  const targetForResult = (context: RouteContext) =>
    (context.winner ?? context.candidates[0]!).target;

  const createStandardRoute = (
    request: RouteRequest,
    options: {
      defaultIntent?: GatewayTaskIntent;
      extraRequiredCapabilities?: NonNullable<GatewayRequest["requiredCapabilities"]>;
      getSkipReason?: (model: LanguageModel, target: GatewayModelTarget) => RouteSkip | undefined;
      onWinner?: (
        candidate: RouteCandidate,
        attempts: GatewayAttempt[],
        abortSignal: AbortSignal
      ) => void | Promise<void>;
    } = {}
  ) => {
    const context = createRouteContext(request, options);
    return {
      context,
      model: createRoutedLanguageModel(context)
    };
  };

  const gateway = {
    async generate(request: GatewayRequest): Promise<GatewayResponse> {
      const route = createStandardRoute(request);
      const result = await generateText(createTextOptions(route.model, request));
      return enrichTextResult(
        request,
        targetForResult(route.context),
        route.context.attempts,
        route.context.routeDecision,
        route.context.startedAt,
        result
      );
    },

    streamText(request: GatewayRequest): GatewayStreamTextResult {
      const route = createStandardRoute(request, {
        extraRequiredCapabilities: { streaming: true }
      });
      const streamResult = streamText(createTextOptions(route.model, request));

      return {
        eventStream: streamResult.eventStream,
        textStream: streamResult.textStream,
        collect: async () => {
          const result = await streamResult.collect();
          return enrichTextResult(
            request,
            targetForResult(route.context),
            route.context.attempts,
            route.context.routeDecision,
            route.context.startedAt,
            result
          );
        }
      };
    },

    async generateObject<TSchema extends ZodTypeAny>(
      request: GatewayGenerateObjectRequest<TSchema>
    ): Promise<GatewayObjectResponse<TSchema>> {
      const route = createStandardRoute(request, {
        getSkipReason: (model) => {
          const message = objectCapabilitySkipReason(model, request);
          return message ? { reasonCode: "operation-skip", message } : undefined;
        }
      });
      route.context.autoObject = (request.mode ?? "auto") === "auto";
      const result = await generateObject({
        ...createTextOptions(route.model, request),
        schema: request.schema,
        mode: request.mode,
        schemaName: request.schemaName,
        schemaDescription: request.schemaDescription
      } as GenerateObjectOptions<TSchema>);

      return enrichObjectResult(
        request,
        targetForResult(route.context),
        route.context.attempts,
        route.context.routeDecision,
        route.context.startedAt,
        { ...result, objectMode: route.context.autoObject
          ? (route.context.winner!.model.capabilities.structuredOutput ? "native" : "prompted")
          : result.objectMode } as GenerateObjectOutput<TSchema>
      );
    },

    streamObject<TSchema extends ZodTypeAny>(
      request: GatewayGenerateObjectRequest<TSchema>
    ): GatewayStreamObjectResult<TSchema> {
      const route = createStandardRoute(request, {
        extraRequiredCapabilities: { streaming: true },
        getSkipReason: (model) => {
          const message = objectCapabilitySkipReason(model, request);
          return message ? { reasonCode: "operation-skip", message } : undefined;
        }
      });
      route.context.autoObject = (request.mode ?? "auto") === "auto";
      const streamResult = streamObject({
        ...createTextOptions(route.model, request),
        schema: request.schema,
        mode: request.mode,
        schemaName: request.schemaName,
        schemaDescription: request.schemaDescription
      } as GenerateObjectOptions<TSchema>) as StreamObjectResult<TSchema>;

      return {
        eventStream: streamResult.eventStream,
        partialObjectStream: streamResult.partialObjectStream,
        textStream: streamResult.textStream,
        collect: async () => {
          const result = await streamResult.collect();
          return enrichObjectResult(
            request,
            targetForResult(route.context),
            route.context.attempts,
            route.context.routeDecision,
            route.context.startedAt,
            { ...result, objectMode: route.context.autoObject
              ? (route.context.winner!.model.capabilities.structuredOutput ? "native" : "prompted")
              : result.objectMode }
          );
        }
      };
    },

    async runAgent(request: GatewayAgentRequest): Promise<GatewayAgentResponse> {
      request = prepareAgentHistoryRequest(configuredAgentRequest(request));
      const route = createStandardRoute(request, {
        defaultIntent: "tool-heavy",
        getSkipReason: (model) =>
          supportsRequiredAgentCapabilities(model, request.requiredAgentCapabilities)
            ? undefined
            : {
                reasonCode: "agent-capabilities",
                message: "Skipped because agent capabilities do not satisfy the request."
              },
        onWinner: async (candidate, attempts, abortSignal) => {
          await config.onAgentRoute?.({
            provider: candidate.target.provider,
            modelId: candidate.target.modelId,
            routeDecision: route.context.routeDecision,
            attempts,
            targetRank: candidate.targetRank,
            abortSignal
          });
        }
      });
      if (request.state?.metadata?.gatewayPortableHistory === true) route.context.toolHistory = true;
      const agent = createAgent({
        ...request.agent,
        id: request.agentId,
        model: route.model,
        instructions: request.instructions,
        tools: request.tools,
        maxSteps: request.maxSteps,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        reasoning: request.reasoning,
        toolExecution: request.toolExecution,
        toolApprovalPolicy: request.toolApprovalPolicy,
        providerOptions: request.providerOptions,
        policy: request.policy,
        metadata: request.metadata,
        store: agentHistoryStore(request.store, route.context, request.agent ? request.metadata?.gatewayAgentRouteBinding as string : undefined),
        memory: request.memory,
        onTelemetryEvent: request.onTelemetryEvent,
        hookFailurePolicy: request.hookFailurePolicy
      });
      const result = await runAgent(agent, createAgentRunInput(request));

      return enrichAgentResult(
        targetForResult(route.context),
        route.context.attempts,
        route.context.routeDecision,
        route.context.startedAt,
        result
      );
    },

    streamAgent(request: GatewayAgentRequest): GatewayAgentStreamResult {
      request = prepareAgentHistoryRequest(configuredAgentRequest(request));
      const route = createStandardRoute(request, {
        defaultIntent: "tool-heavy",
        extraRequiredCapabilities: { streaming: true },
        getSkipReason: (model) =>
          supportsRequiredAgentCapabilities(model, request.requiredAgentCapabilities)
            ? undefined
            : {
                reasonCode: "agent-capabilities",
                message: "Skipped because agent capabilities do not satisfy the request."
              },
        onWinner: async (candidate, attempts, abortSignal) => {
          await config.onAgentRoute?.({
            provider: candidate.target.provider,
            modelId: candidate.target.modelId,
            routeDecision: route.context.routeDecision,
            attempts,
            targetRank: candidate.targetRank,
            abortSignal
          });
        }
      });
      if (request.state?.metadata?.gatewayPortableHistory === true) route.context.toolHistory = true;
      const agent = createAgent({
        ...request.agent,
        id: request.agentId,
        model: route.model,
        instructions: request.instructions,
        tools: request.tools,
        maxSteps: request.maxSteps,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        reasoning: request.reasoning,
        toolExecution: request.toolExecution,
        toolApprovalPolicy: request.toolApprovalPolicy,
        providerOptions: request.providerOptions,
        policy: request.policy,
        metadata: request.metadata,
        store: agentHistoryStore(request.store, route.context, request.agent ? request.metadata?.gatewayAgentRouteBinding as string : undefined),
        memory: request.memory,
        onTelemetryEvent: request.onTelemetryEvent,
        hookFailurePolicy: request.hookFailurePolicy
      });
      const streamResult: AgentStreamResult = streamAgent(agent, createAgentRunInput(request));

      return {
        eventStream: streamResult.eventStream,
        textStream: streamResult.textStream,
        collect: async () => {
          const result = await streamResult.collect();
          return enrichAgentResult(
            targetForResult(route.context),
            route.context.attempts,
            route.context.routeDecision,
            route.context.startedAt,
            result
          );
        }
      };
    }
  };

  const managedStream = <TRequest extends { abortSignal?: AbortSignal }, TResult extends { collect: () => Promise<unknown> }>(
    request: TRequest, start: (request: TRequest) => TResult
  ): TResult => {
    if (!config.metrics && !config.circuitBreaker) return start(request);
    const controller = new AbortController();
    const abort = () => controller.abort(new DOMException("Gateway stream consumer closed.", "AbortError"));
    request.abortSignal?.addEventListener("abort", abort, { once: true });
    if (request.abortSignal?.aborted) abort();
    const cleanup = () => request.abortSignal?.removeEventListener("abort", abort);
    try {
      const result = start({ ...request, abortSignal: controller.signal });
      const completion = result.collect().finally(cleanup);
      void completion.catch(() => undefined);
      const wrapped = { ...result, collect: () => completion } as TResult;
      for (const key of ["eventStream", "textStream", "partialObjectStream"] as const) {
        const source = (result as Record<string, unknown>)[key] as AsyncIterable<unknown> | undefined;
        if (!source) continue;
        (wrapped as Record<string, unknown>)[key] = {
          [Symbol.asyncIterator]() {
            const iterator = source[Symbol.asyncIterator]();
            return {
              next: () => iterator.next(),
              return: async () => {
                abort(); cleanup();
                try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* Best effort. */ }
                return { done: true as const, value: undefined };
              }
            };
          }
        };
      }
      return wrapped;
    } catch (error) { abort(); cleanup(); throw error; }
  };
  return {
    ...gateway,
    streamText: (request: GatewayRequest) => managedStream(request, gateway.streamText),
    streamObject: <TSchema extends ZodTypeAny>(request: GatewayGenerateObjectRequest<TSchema>) => managedStream(request, gateway.streamObject<TSchema>),
    streamAgent: (request: GatewayAgentRequest) => managedStream(request, gateway.streamAgent)
  };
};
