import { toJSONSchema } from "zod";

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type Message
} from "@aws-sdk/client-bedrock-runtime";

import {
  ConfigurationError,
  isCallableToolDefinition,
  UnsupportedFeatureError,
  ValidationError,
  createProviderAdapter,
  normalizeFinishReason,
  withRetry,
  withTimeoutSignal,
  type CallableProviderAdapter,
  type GenerateResult,
  type LanguageModel,
  type ModelCapabilities,
  type ModelGenerateInput,
  type ModelMessage,
  type ProviderAdapter
} from "@zhivex-ai/core";

export interface BedrockProviderOptions {
  client?: BedrockRuntimeClient;
  region?: string;
}

export interface BedrockLanguageModelOptions {
  additionalModelRequestFields?: Record<string, unknown>;
  additionalModelResponseFieldPaths?: string[];
  [key: string]: unknown;
}

const capabilities: ModelCapabilities = {
  streaming: false,
  tools: true,
  structuredOutput: false,
  jsonMode: false,
  toolChoice: true,
  parallelToolCalls: false,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false
};

const supportedImageFormats = new Set(["png", "jpeg", "gif", "webp"]);

const parseDataUrl = (value: string) => {
  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new ValidationError("Bedrock image inputs must be provided as data URLs.");
  }

  return {
    mediaType: match[1].toLowerCase(),
    bytes: Buffer.from(match[2], "base64")
  };
};

const toBedrockImageFormat = (mediaType: string) => {
  const subtype = mediaType.split("/")[1]?.toLowerCase() ?? "";
  if (!supportedImageFormats.has(subtype)) {
    throw new ValidationError(`Unsupported Bedrock image media type "${mediaType}".`);
  }
  return subtype as "png" | "jpeg" | "gif" | "webp";
};

const mapMessagePart = (part: ModelMessage["parts"][number]): ContentBlock[] => {
  switch (part.type) {
    case "text":
      return part.text ? [{ text: part.text }] : [];
    case "image": {
      const parsed = parseDataUrl(part.image);
      return [
        {
          image: {
            format: toBedrockImageFormat(part.mediaType ?? parsed.mediaType),
            source: {
              bytes: parsed.bytes
            }
          }
        }
      ];
    }
    case "tool-call":
      return [
        {
          toolUse: {
            toolUseId: part.toolCall.id,
            name: part.toolCall.name,
            input: part.toolCall.input
          }
        }
      ];
    default:
      return [];
  }
};

const mapToolResultContent = (toolResult: Extract<ModelMessage["parts"][number], { type: "tool-result" }>["toolResult"]) => {
  const value = toolResult.isError ? toolResult.error : toolResult.output;

  if (typeof value === "string") {
    return [{ text: value }];
  }

  return [{ json: value ?? null }];
};

const systemBlocksFromMessages = (messages: ModelMessage[]) => {
  const text = messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return text ? [{ text }] : undefined;
};

const mapMessages = (messages: ModelMessage[]): Message[] =>
  messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "tool") {
        return {
          role: "user",
          content: message.parts.flatMap((part) =>
            part.type === "tool-result"
              ? [
                  {
                    toolResult: {
                      toolUseId: part.toolResult.toolCallId,
                      content: mapToolResultContent(part.toolResult),
                      ...(part.toolResult.isError ? { status: "error" as const } : {})
                    }
                  }
                ]
              : []
          )
        };
      }

      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.parts.flatMap(mapMessagePart)
      };
    });

const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? (() => {
        const toolDefinitions = Object.values(tools);
        const callableTools = toolDefinitions.filter(isCallableToolDefinition);
        if (callableTools.length !== toolDefinitions.length) {
          throw new UnsupportedFeatureError('Provider "bedrock" does not support hosted tools.');
        }

        return callableTools.map((tool) => ({
          toolSpec: {
            name: tool.name,
            description: tool.description,
            inputSchema: {
              json: toJSONSchema(tool.schema)
            }
          }
        })) as unknown as NonNullable<ConverseCommandInput["toolConfig"]>["tools"];
      })()
    : undefined;

const mapToolChoice = (
  toolChoice: ModelGenerateInput["toolChoice"]
): NonNullable<ConverseCommandInput["toolConfig"]>["toolChoice"] | undefined => {
  if (!toolChoice || toolChoice === "auto") {
    return undefined;
  }

  if (toolChoice === "none") {
    throw new UnsupportedFeatureError('Provider "bedrock" does not support "toolChoice=none".');
  }

  if (toolChoice === "required") {
    return {
      any: {}
    };
  }

  return {
    tool: {
      name: toolChoice.toolName
    }
  } as unknown as NonNullable<ConverseCommandInput["toolConfig"]>["toolChoice"];
};

const parseAssistantMessage = (message: { content?: ContentBlock[] } | undefined): ModelMessage => {
  const parts: ModelMessage["parts"] = [];

  for (const block of message?.content ?? []) {
    const chunk = block as any;

    if (chunk.text) {
      parts.push({ type: "text", text: chunk.text });
      continue;
    }

    if (chunk.toolUse) {
      parts.push({
        type: "tool-call",
        toolCall: {
          id: chunk.toolUse.toolUseId,
          name: chunk.toolUse.name,
          input: chunk.toolUse.input ?? {}
        }
      });
    }
  }

  return {
    role: "assistant",
    parts
  };
};

const normalizeBedrockError = (error: unknown) => {
  const err = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const message = err.message || "Bedrock request failed.";
  const lower = message.toLowerCase();
  const status = err.$metadata?.httpStatusCode;

  if (status === 401 || status === 403 || lower.includes("accessdenied") || lower.includes("credential")) {
    return new ConfigurationError(message, { cause: error });
  }

  if (status === 400 || lower.includes("validation") || lower.includes("model")) {
    return new ValidationError(message, { cause: error });
  }

  return error instanceof Error ? error : new Error(message);
};

class BedrockLanguageModel implements LanguageModel<BedrockLanguageModelOptions> {
  readonly provider = "bedrock";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly client: BedrockRuntimeClient
  ) {}

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { cleanup } = withTimeoutSignal(input);

    try {
      if (input.reasoning) {
        throw new UnsupportedFeatureError('Provider "bedrock" does not support "reasoning".');
      }

      const commandInput: ConverseCommandInput = {
        modelId: this.modelId,
        messages: mapMessages(input.messages),
        system: systemBlocksFromMessages(input.messages),
        inferenceConfig: {
          temperature: input.temperature,
          maxTokens: input.maxTokens
        },
        ...(input.tools || input.toolChoice
          ? {
              toolConfig: {
                ...(input.tools ? { tools: mapTools(input.tools) } : {}),
                ...(input.toolChoice ? { toolChoice: mapToolChoice(input.toolChoice) } : {})
              } as ConverseCommandInput["toolConfig"]
            }
          : {}),
        ...input.providerOptions
      };

      const response = await withRetry(() => this.client.send(new ConverseCommand(commandInput)), input).catch((error) => {
        throw normalizeBedrockError(error);
      });

      const assistantMessage = parseAssistantMessage(response.output?.message);
      const text = assistantMessage.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");

      return {
        messages: [assistantMessage],
        text,
        finishReason: normalizeFinishReason(response.stopReason),
        providerFinishReason: response.stopReason,
        usage: {
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          totalTokens:
            response.usage?.totalTokens ?? ((response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0))
        },
        rawResponse: response
      };
    } finally {
      cleanup();
    }
  }
}

export const createBedrock = (options: BedrockProviderOptions = {}): CallableProviderAdapter & ProviderAdapter => {
  const client =
    options.client ??
    (() => {
      const region = options.region ?? process.env.AWS_REGION;
      if (!region) {
        throw new ConfigurationError("Missing AWS region for Bedrock.");
      }
      return new BedrockRuntimeClient({ region });
    })();

  return createProviderAdapter({
    name: "bedrock",
    languageModel: (modelId) => new BedrockLanguageModel(modelId, client)
  });
};
