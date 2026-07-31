import {
  ConflictError,
  GuardrailTriggeredError,
  ProviderHTTPError,
  ValidationError,
  createAgent,
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
  type StreamTextResult
} from "@zhivex-ai/core";
import type { ZodTypeAny } from "zod";

import { createRouteDecision, gatewayMessagesToModelMessages } from "./compat.js";
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
> & {
  messages?: GatewayRequest["messages"];
};

type RouteRequiredCapabilities = NonNullable<GatewayRequest["requiredCapabilities"]> & {
  toolChoice?: boolean;
};

type ErrorDisposition = {
  error: GatewayError;
  retrySameTarget: boolean;
  fallbackNextTarget: boolean;
};

type RouteContext = {
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

const normalizeError = (error: unknown): ErrorDisposition => {
  if (error instanceof ValidationError || error instanceof ConflictError || error instanceof GuardrailTriggeredError) {
    return {
      error: new GatewayError(error.message, false),
      retrySameTarget: false,
      fallbackNextTarget: false
    };
  }

  if (error instanceof GatewayError) {
    return {
      error,
      retrySameTarget: error.retryable,
      fallbackNextTarget: true
    };
  }

  const status = providerHTTPStatus(error);
  if (status != null) {
    const retryable = status === 408 || status === 429 || status >= 500;
    return {
      error: new GatewayError(error instanceof Error ? error.message : `Provider HTTP ${status}.`, retryable),
      retrySameTarget: retryable,
      fallbackNextTarget: true
    };
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return {
        error: new GatewayError(error.message, false),
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
      error: new GatewayError(error.message, retryable),
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

const retryBackoffMs = (config: GatewayConfig, retry: number) => {
  const base = config.retryBackoffMs ?? 200;
  if (!Number.isFinite(base) || base < 0) {
    throw new GatewayError("Gateway retryBackoffMs must be a finite non-negative number.", false);
  }
  return base * (retry + 1);
};

const createAttempt = (
  target: GatewayModelTarget,
  ok: boolean,
  latencyMs: number,
  targetRank: number,
  options: Pick<GatewayAttempt, "errorMessage" | "reasonCode" | "retry"> = {}
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
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
  inputText: string,
  outputText: string
) => {
  const inputTokens = usage?.inputTokens ?? estimateTokens(inputText);
  const outputTokens = usage?.outputTokens ?? estimateTokens(outputText);
  const totalTokens = usage?.totalTokens ?? inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimated: usage?.inputTokens == null || usage?.outputTokens == null || usage?.totalTokens == null
  };
};

const getInputText = (request: GatewayRequest) =>
  `${request.systemPrompt ?? ""}\n${request.messages.map((message) => message.content).join("\n")}`.trim();

const requestHasImages = (request: { messages?: GatewayRequest["messages"] }) =>
  request.messages?.some((message) => (message.images?.length ?? 0) > 0) ?? false;

const buildRequiredCapabilities = (
  request: Pick<GatewayRequest, "requiredCapabilities" | "tools" | "toolChoice" | "reasoning"> & {
    messages?: GatewayRequest["messages"];
  },
  extra: NonNullable<GatewayRequest["requiredCapabilities"]> = {}
): RouteRequiredCapabilities => ({
  ...(request.requiredCapabilities ?? {}),
  ...(request.tools ? { tools: true } : {}),
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
  if (input.tools && !model.capabilities.tools) {
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
  abortSignal: request.abortSignal
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
    const orderedTargets = orderTargets(mode, intent, request.primary, request.fallbacks ?? [], config);
    const routeDecision = createRouteDecision(mode, intent, orderedTargets);
    const attempts: GatewayAttempt[] = [];
    const candidates: RouteCandidate[] = [];
    let notificationChain = Promise.resolve();

    const queueAttempt = (attempt: GatewayAttempt) => {
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
            errorMessage: error instanceof Error ? error.message : "Provider model construction failed."
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

    if (!candidates.length) {
      throw new GatewayError(
        attempts.at(-1)?.errorMessage ?? "No gateway target satisfied the request.",
        false
      );
    }

    const context: RouteContext = {
      attempts,
      candidates,
      routeDecision,
      startedAt: Date.now(),
      flushAttempts: () => notificationChain,
      recordAttempt: async (attempt) => {
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
        const inputSkipReason = modelInputSkipReason(candidate.model, input);
        if (inputSkipReason) {
          await recordInputSkip(candidate, inputSkipReason);
          continue;
        }

        for (let retry = 0; retry <= maxRetries; retry += 1) {
          reserveProviderAttempt();
          const attemptStartedAt = Date.now();
          const control = createAttemptControl(
            input.abortSignal,
            getAttemptTimeoutMs(config, candidate.target.provider)
          );

          try {
            const result = await control.waitFor(
              candidate.model.generate({
                ...input,
                abortSignal: control.signal
              })
            );
            control.stopTimeout();
            await context.recordAttempt(
              createAttempt(candidate.target, true, Date.now() - attemptStartedAt, candidate.targetRank, {
                retry,
                reasonCode: "provider-success"
              })
            );
            await context.lock(candidate);
            control.dispose();
            return result;
          } catch (rawError) {
            const callerAborted = input.abortSignal?.aborted === true;
            const error = control.timedOut() ? control.timeoutError : rawError;
            control.abort(error);
            control.dispose();

            if (callerAborted) {
              await context.recordAttempt(
                createAttempt(candidate.target, false, Date.now() - attemptStartedAt, candidate.targetRank, {
                  retry,
                  reasonCode: "request-aborted",
                  errorMessage: abortReason(input.abortSignal!).message
                })
              );
              throw abortReason(input.abortSignal!);
            }

            const disposition = normalizeError(error);
            await context.recordAttempt(
              createAttempt(candidate.target, false, Date.now() - attemptStartedAt, candidate.targetRank, {
                retry,
                reasonCode: "provider-error",
                errorMessage: disposition.error.message
              })
            );

            if (retry < maxRetries && disposition.retrySameTarget) {
              await abortableSleep(retryBackoffMs(config, retry), input.abortSignal);
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
        const inputSkipReason = modelInputSkipReason(candidate.model, input);
        if (inputSkipReason) {
          await recordInputSkip(candidate, inputSkipReason);
          continue;
        }
        if (!candidate.model.stream) {
          await recordInputSkip(candidate, "Skipped because model does not support streaming.");
          continue;
        }

        for (let retry = 0; retry <= maxRetries; retry += 1) {
          reserveProviderAttempt();
          const attemptStartedAt = Date.now();
          const control = createAttemptControl(
            input.abortSignal,
            getAttemptTimeoutMs(config, candidate.target.provider)
          );
          let iterator: AsyncIterator<StreamEvent> | undefined;

          try {
            const providerStream = await control.waitFor(
              candidate.model.stream({
                ...input,
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

            control.stopTimeout();
            await context.recordAttempt(
              createAttempt(candidate.target, true, Date.now() - attemptStartedAt, candidate.targetRank, {
                retry,
                reasonCode: "provider-success"
              })
            );
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
              try {
                yield firstEvent.value;
                for (;;) {
                  const next = await nextEvent();
                  if (next.done) {
                    completed = true;
                    return;
                  }
                  yield next.value;
                }
              } finally {
                if (!completed) {
                  control.abort(new DOMException("Gateway stream consumer closed.", "AbortError"));
                }
                control.dispose();
                if (iterator?.return) {
                  await iterator.return();
                }
              }
            })();
          } catch (rawError) {
            const callerAborted = input.abortSignal?.aborted === true;
            const error = control.timedOut() ? control.timeoutError : rawError;
            control.abort(error);
            control.dispose();
            if (iterator?.return) {
              void iterator.return().catch(() => undefined);
            }

            if (callerAborted) {
              await context.recordAttempt(
                createAttempt(candidate.target, false, Date.now() - attemptStartedAt, candidate.targetRank, {
                  retry,
                  reasonCode: "request-aborted",
                  errorMessage: abortReason(input.abortSignal!).message
                })
              );
              throw abortReason(input.abortSignal!);
            }

            const disposition = normalizeError(error);
            await context.recordAttempt(
              createAttempt(candidate.target, false, Date.now() - attemptStartedAt, candidate.targetRank, {
                retry,
                reasonCode: "provider-error",
                errorMessage: disposition.error.message
              })
            );

            if (retry < maxRetries && disposition.retrySameTarget) {
              await abortableSleep(retryBackoffMs(config, retry), input.abortSignal);
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
        return context.winner?.model.capabilities ?? first.model.capabilities;
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

  return {
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
        result as GenerateObjectOutput<TSchema>
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
            result
          );
        }
      };
    },

    async runAgent(request: GatewayAgentRequest): Promise<GatewayAgentResponse> {
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
      const agent = createAgent({
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
        store: request.store,
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
      const agent = createAgent({
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
        store: request.store,
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
};
