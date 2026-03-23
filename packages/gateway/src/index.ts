import { generateText, type ProviderAdapter } from "@zhivex-ai/core";

import { createRouteDecision, gatewayMessagesToModelMessages, stripImagesForUnsupportedModel } from "./compat.js";
import {
  GatewayError,
  type GatewayAttempt,
  type GatewayConfig,
  type GatewayModelTarget,
  type GatewayProviderId,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayRoutingMode,
  type GatewayTaskIntent
} from "./types.js";

const scoreTarget = (
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
  const latencyPenalty = (config.latencyBiasMs?.[target.provider] ?? 0) / 100;

  if (mode === "speed") {
    return speedBoost + localBoost - latencyPenalty;
  }
  if (mode === "quality") {
    return qualityBoost + (intent === "reasoning" ? reasoningBoost : 0) - costPenalty;
  }
  return speedBoost + qualityBoost + localBoost + (intent === "reasoning" ? 1 : 0) - costPenalty - latencyPenalty;
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
    .sort((left, right) => scoreTarget(mode, intent, right, config) - scoreTarget(mode, intent, left, config));

const supportsRequiredCapabilities = (
  adapter: ProviderAdapter,
  target: GatewayModelTarget,
  requiredCapabilities: GatewayRequest["requiredCapabilities"]
) => {
  if (!requiredCapabilities) {
    return true;
  }

  const capabilities = adapter.languageModel(target.modelId).capabilities;
  return Object.entries(requiredCapabilities).every(([key, required]) => required !== true || capabilities[key as keyof typeof capabilities] === true);
};

const withinCostBudget = (config: GatewayConfig, request: GatewayRequest, target: GatewayModelTarget) => {
  if (request.maxCostPer1kTokens == null) {
    return true;
  }

  const configuredCost = config.providerCostsPer1kTokens?.[target.provider];
  const catalogCost = config.modelCatalog?.find(target.provider, target.modelId)?.costPer1kTokens;
  const effectiveCost = configuredCost ?? catalogCost;
  if (effectiveCost == null) {
    return true;
  }

  return effectiveCost <= request.maxCostPer1kTokens;
};

const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.trim().length / 4));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new GatewayError(`Provider timed out after ${timeoutMs}ms.`, true)), timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });

const normalizeError = (error: unknown) => {
  if (error instanceof GatewayError) {
    return error;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("timed out") || message.includes("429") || message.includes("rate")) {
      return new GatewayError(error.message, true);
    }
    if (message.includes("connect") || message.includes("econnrefused") || message.includes("503")) {
      return new GatewayError(error.message, true);
    }
    return new GatewayError(error.message, false);
  }

  return new GatewayError("Unknown gateway error.", false);
};

const getAttemptTimeoutMs = (config: GatewayConfig, provider: GatewayProviderId) =>
  config.attemptTimeoutsMs?.[provider] ?? config.attemptTimeoutMs ?? 20_000;

const retryBackoffMs = (config: GatewayConfig, retry: number) => (config.retryBackoffMs ?? 200) * (retry + 1);

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

export const createGateway = (config: GatewayConfig) => {
  const getAdapter = (provider: GatewayProviderId): ProviderAdapter => {
    const adapter = config.adapters[provider];
    if (!adapter) {
      throw new GatewayError(`No adapter registered for provider "${provider}".`, false);
    }
    return adapter;
  };

  return {
    async generate(request: GatewayRequest): Promise<GatewayResponse> {
      const attempts: GatewayAttempt[] = [];
      const startedAt = Date.now();
      const mode = request.routingMode ?? "balanced";
      const intent = request.taskIntent ?? "chat";
      const orderedTargets = orderTargets(mode, intent, request.primary, request.fallbacks ?? [], config);
      const routeDecision = createRouteDecision(mode, intent, orderedTargets);
      const maxRetries = Math.max(0, config.maxRetries ?? 2);

      for (const [targetIndex, target] of orderedTargets.entries()) {
        const adapter = getAdapter(target.provider);

        if (!supportsRequiredCapabilities(adapter, target, request.requiredCapabilities)) {
          attempts.push({
            provider: target.provider,
            modelId: target.modelId,
            ok: false,
            latencyMs: 0,
            errorMessage: "Skipped because model capabilities do not satisfy the request."
          });
          continue;
        }

        if (!withinCostBudget(config, request, target)) {
          attempts.push({
            provider: target.provider,
            modelId: target.modelId,
            ok: false,
            latencyMs: 0,
            errorMessage: "Skipped because provider cost exceeds the configured budget."
          });
          continue;
        }

        for (let retry = 0; retry <= maxRetries; retry += 1) {
          const attemptStartedAt = Date.now();

          try {
            const providerMessages = stripImagesForUnsupportedModel(request.messages, target.provider, target.modelId);
            await config.onAttempt?.({
              provider: target.provider,
              modelId: target.modelId,
              ok: true,
              latencyMs: 0,
              retry,
              targetRank: targetIndex
            });
            const result = await withTimeout(
              generateText({
                model: adapter.languageModel(target.modelId),
                messages: gatewayMessagesToModelMessages(providerMessages, request.systemPrompt),
                temperature: request.temperature,
                maxTokens: request.maxTokens,
                abortSignal: request.abortSignal
              }),
              getAttemptTimeoutMs(config, target.provider)
            );

            attempts.push({
              provider: target.provider,
              modelId: target.modelId,
              ok: true,
              latencyMs: Date.now() - attemptStartedAt
            });

            const inputText = `${request.systemPrompt ?? ""}\n${providerMessages.map((message) => message.content).join("\n")}`.trim();

            return {
              text: result.text,
              providerUsed: target.provider,
              modelUsed: target.modelId,
              latencyMs: Date.now() - startedAt,
              attempts,
              usage: normalizeUsage(result.usage, inputText, result.text),
              routeDecision
            };
          } catch (error) {
            const normalized = normalizeError(error);

            attempts.push({
              provider: target.provider,
              modelId: target.modelId,
              ok: false,
              latencyMs: Date.now() - attemptStartedAt,
              errorMessage: normalized.message
            });

            await config.onAttempt?.({
              provider: target.provider,
              modelId: target.modelId,
              ok: false,
              latencyMs: Date.now() - attemptStartedAt,
              errorMessage: normalized.message,
              retry,
              targetRank: targetIndex
            });

            if (retry < maxRetries && normalized.retryable) {
              await sleep(retryBackoffMs(config, retry));
              continue;
            }

            break;
          }
        }
      }

      const finalError = attempts.at(-1)?.errorMessage ?? "All gateway attempts failed.";
      throw new GatewayError(finalError, false);
    }
  };
};

export * from "./compat.js";
export * from "./types.js";
