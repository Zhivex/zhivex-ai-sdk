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
import { toToolSet } from "./tool-registry.js";
import type {
  GenerateResult,
  GenerateTextOptions,
  GenerateTextOutput,
  ModelGenerateInput,
  ModelMessage,
  StreamTextResult,
  StreamEvent,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolCall,
  ToolExecutionResult
} from "./types.js";

const withToolTimeout = async <T>(operation: Promise<T>, timeoutMs?: number): Promise<T> => {
  if (!timeoutMs) {
    return operation;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms.`)), timeoutMs);
    operation
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

  if (reasoning.effort === undefined && reasoning.budgetTokens === undefined) {
    throw new ValidationError('The "reasoning" config must include at least one supported field.');
  }

  if (
    reasoning.budgetTokens !== undefined &&
    (!Number.isInteger(reasoning.budgetTokens) || reasoning.budgetTokens <= 0)
  ) {
    throw new ValidationError('The "reasoning.budgetTokens" field must be a positive integer.');
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

const toRequest = (options: GenerateTextOptions, messages: ModelMessage[]): ModelGenerateInput => ({
  messages,
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
        isError: true
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
      const output = serializeJsonValue(await withToolTimeout(Promise.resolve(tool.execute(parsedInput)), timeoutMs));
      const result = {
        toolCallId: call.id,
        toolName: call.name,
        output,
        isError: false
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
        isError: true
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

  for (let step = 0; step < maxSteps; step += 1) {
    const request = toRequest(options, allMessages);
    const response = await options.model.generate(request);
    steps.push({ request, response });
    finalResult = response;

    const responseMessages = resultMessages(response);
    if (responseMessages.length) {
      allMessages.push(...responseMessages);
      generatedMessages.push(...responseMessages);
    }

    const toolCalls = extractToolCalls(responseMessages);
    if (!toolCalls.length) {
      break;
    }

    const currentToolResults = await executeTools(toolCalls, options, {
      request,
      step: step + 1,
      tools: resolvedTools
    });
    toolResults.push(...currentToolResults);

    for (const result of currentToolResults) {
      allMessages.push({
        role: "tool",
        parts: [toolResultPart(result)]
      });
    }
  }

  if (!finalResult) {
    throw new ParseError("Model did not return a result.");
  }

  return {
    text: getTextFromMessages(generatedMessages),
    finishReason: finalResult.finishReason,
    providerFinishReason: finalResult.providerFinishReason,
    usage: finalResult.usage,
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

  const subscribers = new Set<(value: IteratorResult<StreamEvent>) => void>();
  const history: IteratorResult<StreamEvent>[] = [];
  let done = false;
  let finalResultPromise: Promise<GenerateTextOutput> | undefined;

  const publish = (value: IteratorResult<StreamEvent>) => {
    history.push(value);
    for (const subscriber of subscribers) {
      subscriber(value);
    }
    if (value.done) {
      done = true;
    }
  };

  const createEventStream = async function* () {
    let cursor = 0;

    while (true) {
      while (cursor < history.length) {
        const item = history[cursor];
        cursor += 1;
        if (item.done) {
          return;
        }
        yield item.value;
      }

      if (done) {
        return;
      }

      await new Promise<IteratorResult<StreamEvent>>((resolve) => {
        const subscriber = (value: IteratorResult<StreamEvent>) => {
          subscribers.delete(subscriber);
          resolve(value);
        };
        subscribers.add(subscriber);
      });
    }
  };

  const runner = async (): Promise<GenerateTextOutput> => {
    const allMessages = [...baseMessages];
    const generatedMessages: ModelMessage[] = [];
    const steps: GenerateTextOutput["steps"] = [];
    const toolResults: ToolExecutionResult[] = [];
    let finalResult: GenerateResult | undefined;

    for (let step = 0; step < maxSteps; step += 1) {
      const request = toRequest(options, allMessages);
      const stream = await streamModel(request);
      const stepMessages: ModelMessage[] = [];
      let textBuffer = "";
      let finishReason = normalizeFinishReason("stop");
      let providerFinishReason: string | undefined;
      let usage = undefined;

      for await (const event of stream) {
        publish({ done: false, value: event });

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

        if (event.type === "finish") {
          finishReason = event.finishReason;
          providerFinishReason = event.providerFinishReason;
          usage = event.usage;
        }
      }

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
        finishReason,
        providerFinishReason,
        usage
      };

      steps.push({ request, response: finalResult });
      allMessages.push(...stepMessages);
      generatedMessages.push(...stepMessages);

      const toolCalls = extractToolCalls(stepMessages);
      if (!toolCalls.length) {
        break;
      }

        const currentToolResults = await executeTools(toolCalls, options, {
          request,
          step: step + 1,
          tools: resolvedTools
        });
      toolResults.push(...currentToolResults);

      for (const toolResult of currentToolResults) {
        publish({ done: false, value: { type: "tool-result", toolResult } });
        allMessages.push({
          role: "tool",
          parts: [toolResultPart(toolResult)]
        });
      }
    }

    if (!finalResult) {
      throw new ParseError("Model did not return a result.");
    }

    publish({
      done: false,
      value: {
        type: "finish",
        finishReason: finalResult.finishReason,
        providerFinishReason: finalResult.providerFinishReason,
        usage: finalResult.usage
      }
    });
    publish({ done: true, value: undefined });

    return {
      text: getTextFromMessages(generatedMessages),
      finishReason: finalResult.finishReason,
      providerFinishReason: finalResult.providerFinishReason,
      usage: finalResult.usage,
      steps,
      messages: allMessages,
      toolResults
    };
  };

  finalResultPromise = runner().catch((error) => {
    publish({ done: false, value: { type: "error", error: error instanceof Error ? error : new Error(String(error)) } });
    publish({ done: true, value: undefined });
    throw error;
  });

  return {
    eventStream: createEventStream(),
    textStream: (async function* () {
      for await (const event of createEventStream()) {
        if (event.type === "text-delta") {
          yield event.textDelta;
        }
      }
    })(),
    collect: async () => finalResultPromise
  };
};
