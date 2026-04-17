import {
  createAgent,
  generateObject,
  runAgent,
  generateText,
  streamAgent,
  streamObject,
  streamText,
  type AgentRunOutput,
  type AgentStreamResult,
  type GenerateObjectOptions,
  type GenerateObjectOutput,
  type GenerateTextOptions,
  type GenerateTextOutput,
  type LanguageModel,
  type StreamEvent,
  type StreamObjectResult,
  type StreamTextResult,
  type ProviderAdapter
} from "@zhivex-ai/core";
import type { ZodTypeAny } from "zod";

import { createRouteDecision, gatewayMessagesToModelMessages, stripImagesForUnsupportedModel } from "./compat.js";
import {
  GatewayError,
  type GatewayAttempt,
  type GatewayAgentRequest,
  type GatewayAgentResponse,
  type GatewayAgentStreamResult,
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
  return Object.entries(requiredCapabilities).every(
    ([key, required]) => required !== true || capabilities[key as keyof typeof capabilities] === true
  );
};

const agentTierRank = (tier: "tier-a" | "tier-b" | "tier-c" | undefined) =>
  tier === "tier-a" ? 3 : tier === "tier-b" ? 2 : tier === "tier-c" ? 1 : 0;

const supportsRequiredAgentCapabilities = (
  adapter: ProviderAdapter,
  target: GatewayModelTarget,
  requiredAgentCapabilities: GatewayAgentRequest["requiredAgentCapabilities"]
) => {
  if (!requiredAgentCapabilities) {
    return true;
  }

  const capabilities = adapter.languageModel(target.modelId).capabilities.agentCapabilities;
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

const withinCostBudget = (
  config: GatewayConfig,
  request: Pick<GatewayRequest, "maxCostPer1kTokens">,
  target: GatewayModelTarget
) => {
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

const requestMessages = (request: GatewayRequest) =>
  gatewayMessagesToModelMessages(
    stripImagesForUnsupportedModel(request.messages, request.primary.provider, request.primary.modelId),
    request.systemPrompt
  );

const getInputText = (request: GatewayRequest) =>
  `${request.systemPrompt ?? ""}\n${request.messages.map((message) => message.content).join("\n")}`.trim();

const buildRequiredCapabilities = (
  request: Pick<GatewayRequest, "requiredCapabilities" | "tools" | "reasoning">,
  extra: NonNullable<GatewayRequest["requiredCapabilities"]> = {}
): GatewayRequest["requiredCapabilities"] => ({
  ...(request.requiredCapabilities ?? {}),
  ...(request.tools ? { tools: true } : {}),
  ...(request.reasoning ? { reasoning: true } : {}),
  ...extra
});

const createTextOptions = (
  adapter: ProviderAdapter,
  target: GatewayModelTarget,
  request: GatewayRequest
): GenerateTextOptions => ({
  model: adapter.languageModel(target.modelId),
  messages: gatewayMessagesToModelMessages(
    stripImagesForUnsupportedModel(request.messages, target.provider, target.modelId),
    request.systemPrompt
  ),
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
  attempts,
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
  attempts,
  usage: normalizeUsage(result.usage, getInputText(request), result.text),
  routeDecision
});

const createAgentMessages = (request: GatewayAgentRequest, target: GatewayModelTarget) =>
  request.messages
    ? gatewayMessagesToModelMessages(
        stripImagesForUnsupportedModel(request.messages, target.provider, target.modelId),
        undefined
      )
    : undefined;

const createAgentRunInput = (request: GatewayAgentRequest, target: GatewayModelTarget) => {
  const source =
    request.prompt !== undefined
      ? { prompt: request.prompt }
      : request.messages
        ? { messages: createAgentMessages(request, target) }
        : {};

  return {
    ...source,
    system: request.system,
    state: request.state,
    approvals: request.approvals,
    handoff: request.handoff,
    tools: request.tools,
    toolChoice: request.toolChoice,
    toolExecution: request.toolExecution,
    maxSteps: request.maxSteps,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    reasoning: request.reasoning,
    providerOptions: request.providerOptions,
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
  attempts,
  routeDecision,
  state: {
    ...result.state,
    routeDecision
  }
});

export const createGateway = (config: GatewayConfig) => {
  const getAdapter = (provider: GatewayProviderId): ProviderAdapter => {
    const adapter = config.adapters[provider];
    if (!adapter) {
      throw new GatewayError(`No adapter registered for provider "${provider}".`, false);
    }
    return adapter;
  };

  const routeDecisionFor = (request: GatewayRequest) => {
    const mode = request.routingMode ?? "balanced";
    const intent = request.taskIntent ?? "chat";
    const orderedTargets = orderTargets(mode, intent, request.primary, request.fallbacks ?? [], config);
    return {
      mode,
      intent,
      orderedTargets,
      routeDecision: createRouteDecision(mode, intent, orderedTargets)
    };
  };

  const selectAgentTarget = async (request: GatewayAgentRequest) => {
    const mode = request.routingMode ?? "balanced";
    const intent = request.taskIntent ?? "tool-heavy";
    const orderedTargets = orderTargets(mode, intent, request.primary, request.fallbacks ?? [], config);
    const routeDecision = createRouteDecision(mode, intent, orderedTargets);
    const attempts: GatewayAttempt[] = [];

    for (const target of orderedTargets) {
      const adapter = getAdapter(target.provider);

      if (!supportsRequiredCapabilities(adapter, target, buildRequiredCapabilities(request))) {
        attempts.push({
          provider: target.provider,
          modelId: target.modelId,
          ok: false,
          latencyMs: 0,
          errorMessage: "Skipped because model capabilities do not satisfy the request."
        });
        continue;
      }

      if (!supportsRequiredAgentCapabilities(adapter, target, request.requiredAgentCapabilities)) {
        attempts.push({
          provider: target.provider,
          modelId: target.modelId,
          ok: false,
          latencyMs: 0,
          errorMessage: "Skipped because agent capabilities do not satisfy the request."
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

      await config.onAgentRoute?.({
        provider: target.provider,
        modelId: target.modelId,
        routeDecision
      });

      return {
        target,
        attempts,
        routeDecision,
        startedAt: Date.now()
      };
    }

    throw new GatewayError(attempts.at(-1)?.errorMessage ?? "No gateway agent target satisfied the request.", false);
  };

  const runGenerate = async <TResult extends GenerateTextOutput>(
    request: GatewayRequest,
    operation: (adapter: ProviderAdapter, target: GatewayModelTarget) => Promise<TResult>,
    extraRequiredCapabilities: NonNullable<GatewayRequest["requiredCapabilities"]> = {}
  ) => {
    const attempts: GatewayAttempt[] = [];
    const startedAt = Date.now();
    const { orderedTargets, routeDecision } = routeDecisionFor(request);
    const maxRetries = Math.max(0, config.maxRetries ?? 2);
    const requiredCapabilities = buildRequiredCapabilities(request, extraRequiredCapabilities);

    for (const [targetIndex, target] of orderedTargets.entries()) {
      const adapter = getAdapter(target.provider);

      if (!supportsRequiredCapabilities(adapter, target, requiredCapabilities)) {
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
          await config.onAttempt?.({
            provider: target.provider,
            modelId: target.modelId,
            ok: true,
            latencyMs: 0,
            retry,
            targetRank: targetIndex
          });

          const result = await withTimeout(operation(adapter, target), getAttemptTimeoutMs(config, target.provider));
          attempts.push({
            provider: target.provider,
            modelId: target.modelId,
            ok: true,
            latencyMs: Date.now() - attemptStartedAt
          });

          return {
            attempts,
            target,
            startedAt,
            routeDecision,
            result
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
  };

  const runStream = async <TStreamResult extends StreamTextResult | StreamObjectResult<any>>(
    request: GatewayRequest,
    operation: (adapter: ProviderAdapter, target: GatewayModelTarget) => TStreamResult,
    extraRequiredCapabilities: NonNullable<GatewayRequest["requiredCapabilities"]> = {}
  ) => {
    const attempts: GatewayAttempt[] = [];
    const startedAt = Date.now();
    const { orderedTargets, routeDecision } = routeDecisionFor(request);
    const maxRetries = Math.max(0, config.maxRetries ?? 2);
    const requiredCapabilities = buildRequiredCapabilities(request, { streaming: true, ...extraRequiredCapabilities });

    for (const [targetIndex, target] of orderedTargets.entries()) {
      const adapter = getAdapter(target.provider);

      if (!supportsRequiredCapabilities(adapter, target, requiredCapabilities)) {
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
          await config.onAttempt?.({
            provider: target.provider,
            modelId: target.modelId,
            ok: true,
            latencyMs: 0,
            retry,
            targetRank: targetIndex
          });

          const streamResult = operation(adapter, target);
          const iterator = streamResult.eventStream[Symbol.asyncIterator]();
          const first = await withTimeout(iterator.next(), getAttemptTimeoutMs(config, target.provider));

          if (!first.done && first.value.type === "error") {
            throw first.value.error;
          }

          attempts.push({
            provider: target.provider,
            modelId: target.modelId,
            ok: true,
            latencyMs: Date.now() - attemptStartedAt
          });

          return {
            attempts,
            target,
            startedAt,
            routeDecision,
            streamResult
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
  };

  return {
    async generate(request: GatewayRequest): Promise<GatewayResponse> {
      const routed = await runGenerate(request, (adapter, target) => generateText(createTextOptions(adapter, target, request)));
      return enrichTextResult(request, routed.target, routed.attempts, routed.routeDecision, routed.startedAt, routed.result);
    },

    streamText(request: GatewayRequest): GatewayStreamTextResult {
      const selected = runStream(request, (adapter, target) => streamText(createTextOptions(adapter, target, request)));
      let relayPromise: Promise<{
        collect: () => Promise<GatewayResponse>;
      }> | undefined;

      const ensureRelay = async () => {
        if (!relayPromise) {
          relayPromise = selected.then((routed) => ({
            collect: async () =>
              enrichTextResult(
                request,
                routed.target,
                routed.attempts,
                routed.routeDecision,
                routed.startedAt,
                await routed.streamResult.collect()
              )
          }));
        }

        return relayPromise;
      };

      return {
        eventStream: (async function* () {
          const { streamResult } = await selected;
          for await (const event of streamResult.eventStream) {
            yield event;
          }
        })(),
        textStream: (async function* () {
          const { streamResult } = await selected;
          for await (const chunk of streamResult.textStream) {
            yield chunk;
          }
        })(),
        collect: async () => (await ensureRelay()).collect()
      };
    },

    async generateObject<TSchema extends ZodTypeAny>(
      request: GatewayGenerateObjectRequest<TSchema>
    ): Promise<GatewayObjectResponse<TSchema>> {
      const routed = await runGenerate(
        request,
        (adapter, target) =>
          generateObject({
            ...createTextOptions(adapter, target, request),
            schema: request.schema,
            mode: request.mode,
            schemaName: request.schemaName,
            schemaDescription: request.schemaDescription
          } as GenerateObjectOptions<TSchema>)
      );

      return enrichObjectResult(
        request,
        routed.target,
        routed.attempts,
        routed.routeDecision,
        routed.startedAt,
        routed.result as GenerateObjectOutput<TSchema>
      );
    },

    streamObject<TSchema extends ZodTypeAny>(request: GatewayGenerateObjectRequest<TSchema>): GatewayStreamObjectResult<TSchema> {
      const selected = runStream(
        request,
        (adapter, target) =>
          streamObject({
            ...createTextOptions(adapter, target, request),
            schema: request.schema,
            mode: request.mode,
            schemaName: request.schemaName,
            schemaDescription: request.schemaDescription
          } as GenerateObjectOptions<TSchema>)
      );
      let relayPromise: Promise<{
        streamResult: StreamObjectResult<TSchema>;
        collect: () => Promise<GatewayObjectResponse<TSchema>>;
      }> | undefined;

      const ensureRelay = async () => {
        if (!relayPromise) {
          relayPromise = selected.then((routed) => ({
            streamResult: routed.streamResult as StreamObjectResult<TSchema>,
            collect: async () =>
              enrichObjectResult(
                request,
                routed.target,
                routed.attempts,
                routed.routeDecision,
                routed.startedAt,
                await (routed.streamResult as StreamObjectResult<TSchema>).collect()
              )
          }));
        }

        return relayPromise;
      };

      return {
        eventStream: (async function* () {
          const { streamResult } = await selected;
          for await (const event of streamResult.eventStream) {
            yield event;
          }
        })(),
        partialObjectStream: (async function* () {
          const relay = await ensureRelay();
          for await (const partial of relay.streamResult.partialObjectStream) {
            yield partial;
          }
        })(),
        textStream: (async function* () {
          const relay = await ensureRelay();
          for await (const chunk of relay.streamResult.textStream) {
            yield chunk;
          }
        })(),
        collect: async () => (await ensureRelay()).collect()
      };
    },

    async runAgent(request: GatewayAgentRequest): Promise<GatewayAgentResponse> {
      const selection = await selectAgentTarget(request);
      const adapter = getAdapter(selection.target.provider);
      const model = adapter.languageModel(selection.target.modelId) as LanguageModel;
      const agent = createAgent({
        id: request.agentId,
        model,
        instructions: request.instructions,
        tools: request.tools,
        maxSteps: request.maxSteps,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        reasoning: request.reasoning,
        toolExecution: request.toolExecution,
        providerOptions: request.providerOptions,
        metadata: request.metadata,
        store: request.store,
        memory: request.memory,
        onTelemetryEvent: request.onTelemetryEvent
      });

      const result = await runAgent(agent, {
        ...createAgentRunInput(request, selection.target)
      });

      return enrichAgentResult(selection.target, selection.attempts, selection.routeDecision, selection.startedAt, result);
    },

    streamAgent(request: GatewayAgentRequest): GatewayAgentStreamResult {
      const selection = selectAgentTarget(request);
      let relayPromise:
        | Promise<{
            streamResult: AgentStreamResult;
            collect: () => Promise<GatewayAgentResponse>;
          }>
        | undefined;

      const ensureRelay = async () => {
        if (!relayPromise) {
          relayPromise = selection.then(async (selected) => {
            const adapter = getAdapter(selected.target.provider);
            const model = adapter.languageModel(selected.target.modelId) as LanguageModel;
            const agent = createAgent({
              id: request.agentId,
              model,
              instructions: request.instructions,
              tools: request.tools,
              maxSteps: request.maxSteps,
              temperature: request.temperature,
              maxTokens: request.maxTokens,
              reasoning: request.reasoning,
              toolExecution: request.toolExecution,
              providerOptions: request.providerOptions,
              metadata: request.metadata,
              store: request.store,
              memory: request.memory,
              onTelemetryEvent: request.onTelemetryEvent
            });

            const streamResult = streamAgent(agent, {
              ...createAgentRunInput(request, selected.target)
            });

            return {
              streamResult,
              collect: async () =>
                enrichAgentResult(
                  selected.target,
                  selected.attempts,
                  selected.routeDecision,
                  selected.startedAt,
                  await streamResult.collect()
                )
            };
          });
        }

        return relayPromise;
      };

      return {
        eventStream: (async function* () {
          const relay = await ensureRelay();
          for await (const event of relay.streamResult.eventStream) {
            yield event;
          }
        })(),
        textStream: (async function* () {
          const relay = await ensureRelay();
          for await (const chunk of relay.streamResult.textStream) {
            yield chunk;
          }
        })(),
        collect: async () => (await ensureRelay()).collect()
      };
    }
  };
};
