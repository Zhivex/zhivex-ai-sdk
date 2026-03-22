import { ParseError, UnsupportedFeatureError, ValidationError } from "./errors.js";
import {
  createTextMessage,
  getTextFromMessages,
  normalizeFinishReason,
  resultMessages,
  serializeJsonValue,
  toolCallPart,
  toolResultPart,
  validateMessageParts
} from "./messages.js";
import type {
  GenerateResult,
  GenerateTextOptions,
  GenerateTextOutput,
  ModelGenerateInput,
  ModelMessage,
  StreamTextResult,
  StreamEvent,
  ToolCall,
  ToolExecutionResult
} from "./types.js";

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
  tools: options.tools,
  temperature: options.temperature,
  maxTokens: options.maxTokens,
  providerOptions: options.providerOptions,
  structuredOutput: options.structuredOutput,
  abortSignal: options.abortSignal,
  timeoutMs: options.timeoutMs,
  maxRetries: options.maxRetries,
  retryBackoffMs: options.retryBackoffMs
});

const executeTools = async (toolCalls: ToolCall[], options: GenerateTextOptions): Promise<ToolExecutionResult[]> => {
  const results: ToolExecutionResult[] = [];

  for (const call of toolCalls) {
    const tool = options.tools?.[call.name];
    if (!tool) {
      throw new ValidationError(`Tool "${call.name}" was requested by the model but is not registered.`);
    }

    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      throw new ValidationError(`Invalid input for tool "${call.name}": ${parsed.error.message}`);
    }

    try {
      const output = serializeJsonValue(await tool.execute(parsed.data));
      results.push({
        toolCallId: call.id,
        toolName: call.name,
        output,
        isError: false
      });
    } catch (error) {
      results.push({
        toolCallId: call.id,
        toolName: call.name,
        error: { message: error instanceof Error ? error.message : "Tool execution failed." },
        isError: true
      });
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

export const generateText = async (options: GenerateTextOptions): Promise<GenerateTextOutput> => {
  const maxSteps = Math.max(1, options.maxSteps ?? 1);
  const allMessages = buildMessages(options);
  const steps: GenerateTextOutput["steps"] = [];
  validateMessageParts(options.model, allMessages);

  if (options.tools && !options.model.capabilities.tools) {
    throw new UnsupportedFeatureError(`Model "${options.model.provider}/${options.model.modelId}" does not support tools.`);
  }

  const toolResults: ToolExecutionResult[] = [];
  let finalResult: GenerateResult | undefined;

  for (let step = 0; step < maxSteps; step += 1) {
    const request = toRequest(options, allMessages);
    const response = await options.model.generate(request);
    steps.push({ request, response });
    finalResult = response;

    const responseMessages = resultMessages(response);
    if (responseMessages.length) {
      allMessages.push(...responseMessages);
    }

    const toolCalls = extractToolCalls(responseMessages);
    if (!toolCalls.length) {
      break;
    }

    const currentToolResults = await executeTools(toolCalls, options);
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
    text: getTextFromMessages(allMessages),
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
  validateMessageParts(options.model, baseMessages);

  if (!options.model.stream) {
    throw new ValidationError(`Model "${options.model.provider}/${options.model.modelId}" does not support streaming.`);
  }
  const streamModel = options.model.stream.bind(options.model);

  if (options.tools && !options.model.capabilities.tools) {
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

      const toolCalls = extractToolCalls(stepMessages);
      if (!toolCalls.length) {
        break;
      }

      const currentToolResults = await executeTools(toolCalls, options);
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
      text: getTextFromMessages(allMessages),
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
