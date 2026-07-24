import { BoundedReplayBroadcast } from "./bounded-broadcast.js";
import { ParseError, UnsupportedFeatureError, ValidationError } from "./errors.js";
import { emitLanguageModelTelemetryEvent } from "./middleware.js";
import {
  createTextMessage,
  getTextFromMessages,
  isCallableToolDefinition,
  normalizeFinishReason,
  providerDataPart,
  resultMessages,
  serializeJsonValue,
  toolCallPart,
  toolResultPart,
  validateMessageParts
} from "./messages.js";
import { mergeAbortSignals } from "./runtime.js";
import { toToolSet } from "./tool-registry.js";
import type {
  GenerateResult,
  GenerateTextOptions,
  GenerateTextOutput,
  ModelGenerateInput,
  ModelMessage,
  StreamTextResult,
  StreamEvent,
  TokenUsage,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolCall,
  ToolExecutionResult
} from "./types.js";

const withToolTimeout = async <T>(
  operation: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs?: number,
  abortSignal?: AbortSignal
): Promise<T> => {
  if (!timeoutMs) {
    return operation(abortSignal);
  }

  const controller = new AbortController();
  const signal = mergeAbortSignals(abortSignal, controller.signal);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Tool execution timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    Promise.resolve()
      .then(() => operation(signal))
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
};

const validateReasoning = (options: Pick<GenerateTextOptions, "model" | "reasoning">) => {
  const { reasoning } = options;
  if (!reasoning) {
    return;
  }

  if (!options.model.capabilities.reasoning) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support reasoning.`
    );
  }

  if (
    reasoning.effort === undefined &&
    reasoning.mode === undefined &&
    reasoning.context === undefined &&
    reasoning.budgetTokens === undefined &&
    reasoning.includeThoughts === undefined
  ) {
    throw new ValidationError('The "reasoning" config must include at least one supported field.');
  }

  if (
    reasoning.budgetTokens !== undefined &&
    (!Number.isInteger(reasoning.budgetTokens) || reasoning.budgetTokens <= 0)
  ) {
    throw new ValidationError('The "reasoning.budgetTokens" field must be a positive integer.');
  }

  const capabilities = options.model.capabilities;
  if (
    reasoning.effort !== undefined &&
    ((capabilities.reasoningEfforts !== undefined &&
      !capabilities.reasoningEfforts.includes(reasoning.effort)) ||
      (reasoning.effort === "max" && capabilities.reasoningEfforts === undefined))
  ) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support reasoning effort "${reasoning.effort}".`
    );
  }

  if (
    reasoning.mode !== undefined &&
    !capabilities.reasoningModes?.includes(reasoning.mode)
  ) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support reasoning mode "${reasoning.mode}".`
    );
  }

  if (
    reasoning.context !== undefined &&
    !capabilities.reasoningContexts?.includes(reasoning.context)
  ) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support reasoning context "${reasoning.context}".`
    );
  }
};

const validateInputSource = (options: Pick<GenerateTextOptions, "prompt" | "messages">) => {
  if (options.prompt !== undefined && options.messages !== undefined) {
    throw new ValidationError('Pass either "prompt" or "messages", but not both.');
  }
};

const buildMessages = (options: Pick<GenerateTextOptions, "prompt" | "messages" | "system">): ModelMessage[] => {
  validateInputSource(options);
  const messages = [...(options.messages ?? [])];
  if (options.system) {
    messages.unshift(createTextMessage("system", options.system));
  }
  if (options.prompt) {
    messages.push(createTextMessage("user", options.prompt));
  }
  return messages;
};

type GenerateTextStepTiming = {
  startedAt: number;
  finishedAt: number;
};

const stepTimings = new WeakMap<ModelGenerateInput, GenerateTextStepTiming>();

/** @internal Used by the agent runtime to preserve the model-call interval. */
export const getGenerateTextStepTiming = (request: ModelGenerateInput): GenerateTextStepTiming | undefined =>
  stepTimings.get(request);

export const aggregateTokenUsage = (usages: Array<TokenUsage | undefined>): TokenUsage | undefined => {
  let aggregate: TokenUsage | undefined;

  for (const usage of usages) {
    if (!usage) {
      continue;
    }

    aggregate ??= {};
    for (const field of [
      "inputTokens",
      "cachedInputTokens",
      "cacheWriteTokens",
      "outputTokens",
      "reasoningTokens",
      "totalTokens"
    ] as const) {
      if (usage[field] !== undefined) {
        aggregate[field] = (aggregate[field] ?? 0) + usage[field];
      }
    }

    if (usage.speed !== undefined) {
      aggregate.speed = usage.speed;
    }
  }

  return aggregate;
};

const toRequest = (options: GenerateTextOptions, messages: ModelMessage[]): ModelGenerateInput => ({
  messages: structuredClone(messages),
  tools: toToolSet(options.tools),
  toolChoice: options.toolChoice,
  toolExecution: options.toolExecution,
  temperature: options.temperature,
  maxTokens: options.maxTokens,
  reasoning: options.reasoning,
  providerOptions: options.providerOptions,
  structuredOutput: options.structuredOutput,
  abortSignal: options.abortSignal,
  timeoutMs: options.timeoutMs,
  maxRetries: options.maxRetries,
  retryBackoffMs: options.retryBackoffMs
});

const executeTools = async (
  toolCalls: ToolCall[],
  options: GenerateTextOptions,
  context: {
    request: ModelGenerateInput;
    step: number;
    tools: NonNullable<ReturnType<typeof toToolSet>>;
  }
): Promise<ToolExecutionResult[]> => {
  const validatedCalls = toolCalls.map((call) => {
    const tool = context.tools[call.name];
    if (!tool) {
      throw new ValidationError(`Tool "${call.name}" was requested by the model but is not registered.`);
    }

    if (!isCallableToolDefinition(tool)) {
      throw new ValidationError(
        `Tool "${call.name}" is provider-hosted and cannot be executed by the local tool loop.`
      );
    }

    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      throw new ValidationError(`Invalid input for tool "${call.name}": ${parsed.error.message}`);
    }

    return {
      call,
      tool,
      parsedInput: parsed.data
    };
  });

  const parallel = options.toolExecution?.parallel ?? options.model.capabilities.parallelToolCalls;
  const maxConcurrency = Math.max(1, options.toolExecution?.maxConcurrency ?? validatedCalls.length ?? 1);
  const timeoutMs = options.toolExecution?.timeoutMs;
  const stopOnError = options.toolExecution?.stopOnError ?? false;
  const results = new Array<ToolExecutionResult>(validatedCalls.length);

  const evaluateApproval = async (
    item: (typeof validatedCalls)[number]
  ): Promise<ToolApprovalDecision> => {
    const request = {
      toolCall: item.call,
      tool: item.tool,
      input: serializeJsonValue(item.parsedInput),
      step: context.step,
      model: options.model,
      request: context.request
    } satisfies ToolApprovalRequest;

    if (!options.toolApprovalPolicy) {
      const decision = item.tool.requiresApproval
        ? {
            approved: false,
            reason: `Tool "${item.call.name}" requires approval, but no toolApprovalPolicy is configured.`
          }
        : { approved: true };
      await options.onToolApprovalDecision?.({
        request,
        decision
      });
      return decision;
    }

    const rawDecision = await options.toolApprovalPolicy(request);
    const decision =
      typeof rawDecision === "boolean"
        ? {
            approved: rawDecision,
            reason: rawDecision ? undefined : `Tool "${item.call.name}" was denied by the approval policy.`
          }
        : rawDecision;

    const normalizedDecision = decision ?? { approved: true };
    await options.onToolApprovalDecision?.({
      request,
      decision: normalizedDecision
    });
    return normalizedDecision;
  };

  const executeSingleTool = async (
    item: (typeof validatedCalls)[number],
    index: number
  ): Promise<void> => {
    const { call, tool, parsedInput } = item;
    const approval = await evaluateApproval(item);
    if (!approval.approved) {
      results[index] = {
        toolCallId: call.id,
        toolName: call.name,
        error: {
          message: approval.reason ?? `Tool "${call.name}" was denied by the approval policy.`
        },
        isError: true,
        providerMetadata: call.providerMetadata
      } satisfies ToolExecutionResult;
      return;
    }

    const startedAt = Date.now();
    await emitLanguageModelTelemetryEvent(options.model, {
      type: "tool-execution-start",
      model: options.model,
      input: context.request,
      step: context.step,
      toolCall: call,
      startedAt
    });

    try {
      const output = serializeJsonValue(await withToolTimeout(
        async (abortSignal) => tool.execute(parsedInput, {
          abortSignal,
          toolCall: call,
          step: context.step,
          model: options.model,
          request: context.request
        }),
        timeoutMs,
        context.request.abortSignal
      ));
      const result = {
        toolCallId: call.id,
        toolName: call.name,
        output,
        isError: false,
        providerMetadata: call.providerMetadata
      } satisfies ToolExecutionResult;
      results[index] = result;

      const finishedAt = Date.now();
      await emitLanguageModelTelemetryEvent(options.model, {
        type: "tool-execution-finish",
        model: options.model,
        input: context.request,
        step: context.step,
        toolCall: call,
        toolResult: result,
        startedAt,
        finishedAt,
        latencyMs: finishedAt - startedAt
      });
    } catch (error) {
      const result = {
        toolCallId: call.id,
        toolName: call.name,
        error: { message: error instanceof Error ? error.message : "Tool execution failed." },
        isError: true,
        providerMetadata: call.providerMetadata
      } satisfies ToolExecutionResult;
      results[index] = result;

      const finishedAt = Date.now();
      await emitLanguageModelTelemetryEvent(options.model, {
        type: "tool-execution-error",
        model: options.model,
        input: context.request,
        step: context.step,
        toolCall: call,
        error: error instanceof Error ? error : new Error(String(error)),
        startedAt,
        finishedAt,
        latencyMs: finishedAt - startedAt
      });
    }
  };

  if (!parallel || validatedCalls.length <= 1) {
    for (const [index, item] of validatedCalls.entries()) {
      await executeSingleTool(item, index);
      if (stopOnError && results[index]?.isError) {
        throw new Error(`Tool "${item.call.name}" failed: ${results[index]?.error?.message ?? "Unknown tool error."}`);
      }
    }

    return results;
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(maxConcurrency, validatedCalls.length) }, async () => {
    while (cursor < validatedCalls.length) {
      const index = cursor;
      cursor += 1;
      await executeSingleTool(validatedCalls[index], index);
    }
  });

  await Promise.all(workers);

  if (stopOnError) {
    const firstError = results.find((result) => result?.isError);
    if (firstError) {
      throw new Error(`Tool "${firstError.toolName}" failed: ${firstError.error?.message ?? "Unknown tool error."}`);
    }
  }

  return results;
};

export const normalizeMessages = buildMessages;

const extractToolCalls = (messages: ModelMessage[]): ToolCall[] =>
  messages.flatMap((message) =>
    message.parts
      .filter((part): part is Extract<ModelMessage["parts"][number], { type: "tool-call" }> => part.type === "tool-call")
      .map((part) => part.toolCall)
  );

const extractUnresolvedToolCalls = (messages: ModelMessage[]): ToolCall[] => {
  const completed = new Set(
    messages.flatMap((message) =>
      message.parts
        .filter((part) => part.type === "tool-result")
        .map((part) => part.toolResult.toolCallId)
    )
  );
  return extractToolCalls(messages).filter((call) => !completed.has(call.id));
};

const validateToolChoice = (options: {
  model: GenerateTextOptions["model"];
  tools?: ReturnType<typeof toToolSet>;
  toolChoice?: GenerateTextOptions["toolChoice"];
}) => {
  if (!options.toolChoice) {
    return;
  }

  if (!options.model.capabilities.tools) {
    throw new UnsupportedFeatureError(`Model "${options.model.provider}/${options.model.modelId}" does not support tools.`);
  }

  if (!options.model.capabilities.toolChoice) {
    throw new UnsupportedFeatureError(
      `Model "${options.model.provider}/${options.model.modelId}" does not support tool choice.`
    );
  }

  if (!options.tools || Object.keys(options.tools).length === 0) {
    throw new ValidationError('The "toolChoice" option requires at least one registered tool.');
  }

  if (typeof options.toolChoice === "object" && !options.tools[options.toolChoice.toolName]) {
    throw new ValidationError(`The selected tool "${options.toolChoice.toolName}" is not registered.`);
  }
};

export const generateText = async (options: GenerateTextOptions): Promise<GenerateTextOutput> => {
  const maxSteps = Math.max(1, options.maxSteps ?? 1);
  const allMessages = buildMessages(options);
  const steps: GenerateTextOutput["steps"] = [];
  const tools = toToolSet(options.tools);
  const resolvedTools = tools ?? {};
  validateMessageParts(options.model, allMessages);
  validateReasoning(options);
  validateToolChoice({
    model: options.model,
    tools,
    toolChoice: options.toolChoice
  });

  if (tools && !options.model.capabilities.tools) {
    throw new UnsupportedFeatureError(`Model "${options.model.provider}/${options.model.modelId}" does not support tools.`);
  }

  const toolResults: ToolExecutionResult[] = [];
  const generatedMessages: ModelMessage[] = [];
  let finalResult: GenerateResult | undefined;

  const pendingToolCalls = extractUnresolvedToolCalls(allMessages);
  if (pendingToolCalls.length) {
    const request = toRequest(options, allMessages);
    const step = options.stepOffset ?? 0;
    await options.onBeforeToolExecution?.({ request, step, toolCalls: pendingToolCalls });
    const recoveredToolResults = await executeTools(pendingToolCalls, options, {
      request,
      step,
      tools: resolvedTools
    });
    toolResults.push(...recoveredToolResults);
    for (const result of recoveredToolResults) {
      allMessages.push({ role: "tool", parts: [toolResultPart(result)] });
    }
    await options.onToolExecutionComplete?.({ request, step, toolResults: recoveredToolResults });
  }

  for (let step = 0; step < maxSteps; step += 1) {
    const request = toRequest(options, allMessages);
    const absoluteStep = (options.stepOffset ?? 0) + step + 1;
    await options.onBeforeModelStep?.({ request, step: absoluteStep });
    const startedAt = Date.now();
    const response = await options.model.generate(request);
    stepTimings.set(request, { startedAt, finishedAt: Date.now() });
    steps.push({ request, response });
    finalResult = response;

    const responseMessages = resultMessages(response);
    if (responseMessages.length) {
      allMessages.push(...responseMessages);
      generatedMessages.push(...responseMessages);
    }

    const toolCalls = extractToolCalls(responseMessages);
    await options.onModelStep?.({ request, response, step: absoluteStep, toolCalls });
    if (!toolCalls.length) {
      break;
    }

    await options.onBeforeToolExecution?.({ request, step: absoluteStep, toolCalls });
    const currentToolResults = await executeTools(toolCalls, options, {
      request,
      step: absoluteStep,
      tools: resolvedTools
    });
    toolResults.push(...currentToolResults);

    for (const result of currentToolResults) {
      allMessages.push({
        role: "tool",
        parts: [toolResultPart(result)]
      });
    }
    await options.onToolExecutionComplete?.({ request, step: absoluteStep, toolResults: currentToolResults });
  }

  if (!finalResult) {
    throw new ParseError("Model did not return a result.");
  }

  return {
    text: getTextFromMessages(generatedMessages),
    finishReason: finalResult.finishReason,
    providerFinishReason: finalResult.providerFinishReason,
    usage: aggregateTokenUsage(steps.map((step) => step.response.usage)),
    steps,
    messages: allMessages,
    toolResults
  };
};

export const streamText = (options: GenerateTextOptions): StreamTextResult => {
  const maxSteps = Math.max(1, options.maxSteps ?? 1);
  const baseMessages = buildMessages(options);
  const tools = toToolSet(options.tools);
  const resolvedTools = tools ?? {};
  validateMessageParts(options.model, baseMessages);
  validateReasoning(options);
  validateToolChoice({
    model: options.model,
    tools,
    toolChoice: options.toolChoice
  });

  if (!options.model.stream) {
    throw new ValidationError(`Model "${options.model.provider}/${options.model.modelId}" does not support streaming.`);
  }
  const streamModel = options.model.stream.bind(options.model);

  if (tools && !options.model.capabilities.tools) {
    throw new UnsupportedFeatureError(`Model "${options.model.provider}/${options.model.modelId}" does not support tools.`);
  }

  const broadcast = new BoundedReplayBroadcast<StreamEvent>();
  let finalResultPromise: Promise<GenerateTextOutput> | undefined;

  const publish = async (event: StreamEvent, terminal = false) => {
    // Progressive binary previews are useful only to live consumers. Retaining
    // them for collect(), textStream, or a late eventStream replay duplicates
    // potentially large buffers without changing the final generated result.
    await broadcast.publish(event, {
      replay: event.type !== "image-generation" || !event.partial,
      terminal
    });
  };

  const createEventStream = (
    accepts: (event: StreamEvent) => boolean = () => true
  ) => broadcast.stream(accepts);

  const runner = async (): Promise<GenerateTextOutput> => {
    const allMessages = [...baseMessages];
    const generatedMessages: ModelMessage[] = [];
    const steps: GenerateTextOutput["steps"] = [];
    const toolResults: ToolExecutionResult[] = [];
    let finalResult: GenerateResult | undefined;

    const pendingToolCalls = extractUnresolvedToolCalls(allMessages);
    if (pendingToolCalls.length) {
      const request = toRequest(options, allMessages);
      const step = options.stepOffset ?? 0;
      await options.onBeforeToolExecution?.({ request, step, toolCalls: pendingToolCalls });
      const recoveredToolResults = await executeTools(pendingToolCalls, options, {
        request,
        step,
        tools: resolvedTools
      });
      toolResults.push(...recoveredToolResults);
      for (const result of recoveredToolResults) {
        await publish({ type: "tool-result", toolResult: result });
        allMessages.push({ role: "tool", parts: [toolResultPart(result)] });
      }
      await options.onToolExecutionComplete?.({ request, step, toolResults: recoveredToolResults });
    }

    for (let step = 0; step < maxSteps; step += 1) {
      const request = toRequest(options, allMessages);
      const absoluteStep = (options.stepOffset ?? 0) + step + 1;
      await options.onBeforeModelStep?.({ request, step: absoluteStep });
      const startedAt = Date.now();
      const stream = await streamModel(request);
      const stepMessages: ModelMessage[] = [];
      let textBuffer = "";
      const generatedImages: NonNullable<GenerateResult["images"]> = [];
      let finishReason = normalizeFinishReason("stop");
      let providerFinishReason: string | undefined;
      let usage = undefined;

      for await (const event of stream) {
        await publish(event);

        if (event.type === "text-delta") {
          textBuffer += event.textDelta;
        }

        if (event.type === "tool-call") {
          const existingAssistant = stepMessages.find((message) => message.role === "assistant");
          if (existingAssistant) {
            existingAssistant.parts.push(toolCallPart(event.toolCall));
          } else {
            stepMessages.push({
              role: "assistant",
              parts: [toolCallPart(event.toolCall)]
            });
          }
        }

        if (event.type === "provider-data") {
          const existingAssistant = stepMessages.find((message) => message.role === "assistant");
          if (existingAssistant) {
            existingAssistant.parts.push(providerDataPart(event.provider, event.data));
          } else {
            stepMessages.push({
              role: "assistant",
              parts: [providerDataPart(event.provider, event.data)]
            });
          }
        }

        if (event.type === "image-generation" && !event.partial) {
          generatedImages.push(event.image);
        }

        if (event.type === "finish") {
          finishReason = event.finishReason;
          providerFinishReason = event.providerFinishReason;
          usage = event.usage;
        }
      }
      stepTimings.set(request, { startedAt, finishedAt: Date.now() });

      if (textBuffer) {
        const assistant = stepMessages.find((message) => message.role === "assistant");
        if (assistant) {
          assistant.parts.unshift({ type: "text", text: textBuffer });
        } else {
          stepMessages.unshift(createTextMessage("assistant", textBuffer));
        }
      }

      finalResult = {
        messages: stepMessages,
        text: textBuffer,
        images: generatedImages.length ? generatedImages : undefined,
        finishReason,
        providerFinishReason,
        usage
      };

      steps.push({ request, response: finalResult });
      allMessages.push(...stepMessages);
      generatedMessages.push(...stepMessages);

      const toolCalls = extractToolCalls(stepMessages);
      await options.onModelStep?.({ request, response: finalResult, step: absoluteStep, toolCalls });
      if (!toolCalls.length) {
        break;
      }

      await options.onBeforeToolExecution?.({ request, step: absoluteStep, toolCalls });
      const currentToolResults = await executeTools(toolCalls, options, {
        request,
        step: absoluteStep,
        tools: resolvedTools
      });
      toolResults.push(...currentToolResults);

      for (const toolResult of currentToolResults) {
        await publish({ type: "tool-result", toolResult });
        allMessages.push({
          role: "tool",
          parts: [toolResultPart(toolResult)]
        });
      }
      await options.onToolExecutionComplete?.({ request, step: absoluteStep, toolResults: currentToolResults });
    }

    if (!finalResult) {
      throw new ParseError("Model did not return a result.");
    }

    const usage = aggregateTokenUsage(steps.map((step) => step.response.usage));

    await publish({
      type: "finish",
      finishReason: finalResult.finishReason,
      providerFinishReason: finalResult.providerFinishReason,
      usage
    }, true);
    broadcast.close();

    return {
      text: getTextFromMessages(generatedMessages),
      finishReason: finalResult.finishReason,
      providerFinishReason: finalResult.providerFinishReason,
      usage,
      steps,
      messages: allMessages,
      toolResults
    };
  };

  finalResultPromise = runner().catch(async (error) => {
    if (!(error instanceof Error && error.name === "StreamBufferOverflowError")) {
      await publish({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }, true);
      broadcast.close();
    }
    throw error;
  });

  return {
    eventStream: createEventStream(),
    textStream: (async function* () {
      for await (const event of createEventStream((candidate) => candidate.type === "text-delta")) {
        if (event.type === "text-delta") {
          yield event.textDelta;
        }
      }
    })(),
    collect: async () => finalResultPromise
  };
};
