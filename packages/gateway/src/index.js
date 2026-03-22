import { generateText } from "@zhivex-ai/core";
import { createRouteDecision, gatewayMessagesToModelMessages, stripImagesForUnsupportedModel } from "./compat.js";
import { GatewayError } from "./types.js";
const scoreTarget = (mode, intent, target) => {
    const model = target.modelId.toLowerCase();
    const localBoost = target.provider === "ollama" ? -2 : 0;
    const qualityBoost = model.includes("pro") || model.includes("claude") ? 2 : 0;
    const speedBoost = model.includes("flash") || model.includes("lite") ? 2 : 0;
    const reasoningBoost = model.includes("pro") || model.includes("claude") ? 2 : 0;
    if (mode === "speed") {
        return speedBoost + localBoost;
    }
    if (mode === "quality") {
        return qualityBoost + (intent === "reasoning" ? reasoningBoost : 0);
    }
    return speedBoost + qualityBoost + localBoost + (intent === "reasoning" ? 1 : 0);
};
const orderTargets = (mode, intent, primary, fallbacks) => [primary, ...fallbacks]
    .filter((target, index, list) => list.findIndex((candidate) => candidate.provider === target.provider && candidate.modelId === target.modelId) === index)
    .sort((left, right) => scoreTarget(mode, intent, right) - scoreTarget(mode, intent, left));
const estimateTokens = (text) => Math.max(1, Math.ceil(text.trim().length / 4));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = async (promise, timeoutMs) => new Promise((resolve, reject) => {
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
const normalizeError = (error) => {
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
const getAttemptTimeoutMs = (config, provider) => config.attemptTimeoutsMs?.[provider] ?? config.attemptTimeoutMs ?? 20_000;
const retryBackoffMs = (config, retry) => (config.retryBackoffMs ?? 200) * (retry + 1);
const normalizeUsage = (usage, inputText, outputText) => {
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
export const createGateway = (config) => {
    const getAdapter = (provider) => {
        const adapter = config.adapters[provider];
        if (!adapter) {
            throw new GatewayError(`No adapter registered for provider "${provider}".`, false);
        }
        return adapter;
    };
    return {
        async generate(request) {
            const attempts = [];
            const startedAt = Date.now();
            const mode = request.routingMode ?? "balanced";
            const intent = request.taskIntent ?? "chat";
            const orderedTargets = orderTargets(mode, intent, request.primary, request.fallbacks ?? []);
            const routeDecision = createRouteDecision(mode, intent, orderedTargets);
            const maxRetries = Math.max(0, config.maxRetries ?? 2);
            for (const target of orderedTargets) {
                for (let retry = 0; retry <= maxRetries; retry += 1) {
                    const attemptStartedAt = Date.now();
                    try {
                        const adapter = getAdapter(target.provider);
                        const providerMessages = stripImagesForUnsupportedModel(request.messages, target.provider, target.modelId);
                        const result = await withTimeout(generateText({
                            model: adapter.languageModel(target.modelId),
                            messages: gatewayMessagesToModelMessages(providerMessages, request.systemPrompt),
                            temperature: request.temperature,
                            maxTokens: request.maxTokens,
                            abortSignal: request.abortSignal
                        }), getAttemptTimeoutMs(config, target.provider));
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
                    }
                    catch (error) {
                        const normalized = normalizeError(error);
                        attempts.push({
                            provider: target.provider,
                            modelId: target.modelId,
                            ok: false,
                            latencyMs: Date.now() - attemptStartedAt,
                            errorMessage: normalized.message
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
//# sourceMappingURL=index.js.map