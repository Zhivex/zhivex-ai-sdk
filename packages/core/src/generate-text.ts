import { ParseError, ValidationError } from "./errors.js";
import type {
  GenerateResult,
  GenerateTextOptions,
  GenerateTextOutput,
  ModelGenerateInput,
  ModelMessage,
  StreamChunk,
  ToolCall,
  ToolResult
} from "./types.js";

const stringifyJson = (value: unknown): string => JSON.stringify(value);

const buildMessages = (options: Pick<GenerateTextOptions, "prompt" | "messages" | "system">): ModelMessage[] => {
  const messages = [...(options.messages ?? [])];
  if (options.system) {
    messages.unshift({ role: "system", content: options.system });
  }
  if (options.prompt) {
    messages.push({ role: "user", content: options.prompt });
  }
  return messages;
};

const toRequest = (options: GenerateTextOptions, messages: ModelMessage[]): ModelGenerateInput => ({
  messages,
  tools: options.tools,
  temperature: options.temperature,
  maxTokens: options.maxTokens,
  providerOptions: options.providerOptions
});

const assistantMessageFromResult = (result: GenerateResult): ModelMessage | null => {
  if (!result.text) {
    return null;
  }

  return {
    role: "assistant",
    content: result.text
  };
};

const ensureJsonValue = (value: unknown) => JSON.parse(stringifyJson(value)) as ToolResult["output"];

const executeTools = async (toolCalls: ToolCall[], options: GenerateTextOptions): Promise<ToolResult[]> => {
  const results: ToolResult[] = [];

  for (const call of toolCalls) {
    const tool = options.tools?.[call.name];
    if (!tool) {
      throw new ValidationError(`Tool "${call.name}" was requested by the model but is not registered.`);
    }

    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      throw new ValidationError(`Invalid input for tool "${call.name}": ${parsed.error.message}`);
    }

    const output = ensureJsonValue(await tool.execute(parsed.data));
    results.push({
      toolCallId: call.id,
      toolName: call.name,
      output
    });
  }

  return results;
};

export const normalizeMessages = buildMessages;

export const generateText = async (options: GenerateTextOptions): Promise<GenerateTextOutput> => {
  const maxSteps = Math.max(1, options.maxSteps ?? 1);
  const allMessages = buildMessages(options);
  const steps: GenerateTextOutput["steps"] = [];
  const toolResults: ToolResult[] = [];
  let finalText = "";
  let finalResult: GenerateResult | undefined;

  for (let step = 0; step < maxSteps; step += 1) {
    const request = toRequest(options, allMessages);
    const response = await options.model.generate(request);
    steps.push({ request, response });
    finalResult = response;

    const assistantMessage = assistantMessageFromResult(response);
    if (assistantMessage) {
      allMessages.push(assistantMessage);
      finalText = response.text;
    }

    if (!response.toolCalls?.length) {
      break;
    }

    const currentToolResults = await executeTools(response.toolCalls, options);
    toolResults.push(...currentToolResults);

    for (const result of currentToolResults) {
      allMessages.push({
        role: "tool",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        content: stringifyJson(result.output)
      });
    }
  }

  if (!finalResult) {
    throw new ParseError("Model did not return a result.");
  }

  return {
    text: finalText,
    finishReason: finalResult.finishReason,
    usage: finalResult.usage,
    steps,
    messages: allMessages,
    toolResults
  };
};

export const streamText = (options: GenerateTextOptions) => {
  const request = toRequest(options, buildMessages(options));
  let streamPromise: Promise<AsyncIterable<StreamChunk>> | undefined;

  const getStream = async () => {
    if (!options.model.stream) {
      throw new ValidationError(`Model "${options.model.provider}/${options.model.modelId}" does not support streaming.`);
    }
    if (!streamPromise) {
      streamPromise = options.model.stream(request);
    }
    return streamPromise;
  };

  const textStream = (async function* () {
    for await (const chunk of await getStream()) {
      if (chunk.type === "text-delta") {
        yield chunk.textDelta;
      }
    }
  })();

  return {
    stream: (async function* () {
      for await (const chunk of await getStream()) {
        yield chunk;
      }
    })(),
    textStream,
    collect: async () => {
      let text = "";
      for await (const chunk of await getStream()) {
        if (chunk.type === "text-delta") {
          text += chunk.textDelta;
        }
      }
      return text;
    }
  };
};
