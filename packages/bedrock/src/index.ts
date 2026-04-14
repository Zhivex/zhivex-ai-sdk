import { toJSONSchema } from "zod";

import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
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
  , type StreamEvent
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
  streaming: true,
  tools: true,
  structuredOutput: true,
  jsonMode: true,
  toolChoice: true,
  parallelToolCalls: false,
  vision: true,
  files: false,
  audioInput: false,
  audioOutput: false,
  embeddings: false,
  reasoning: false,
  webSearch: false,
  agentCapabilities: {
    supportTier: "tier-c",
    toolChoiceNone: false,
    approvalRequests: false,
    hostedWebSearch: false,
    hostedFileSearch: false,
    remoteMcp: false,
    computerUse: false,
    codeExecution: false,
    toolsets: false
  }
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

const mapStructuredOutput = (structuredOutput: ModelGenerateInput["structuredOutput"]) => {
  if (!structuredOutput || structuredOutput.mode !== "native") {
    return undefined;
  }

  return {
    type: "json_schema",
    structure: {
      jsonSchema: {
        schema: JSON.stringify(toJSONSchema(structuredOutput.schema)),
        name: structuredOutput.name ?? "response",
        ...(structuredOutput.description ? { description: structuredOutput.description } : {})
      }
    }
  };
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

  private toCommandInput(input: ModelGenerateInput): ConverseCommandInput {
    const providerOptions = (input.providerOptions ?? {}) as Record<string, unknown>;
    const outputConfigFromProviderOptions =
      typeof providerOptions.outputConfig === "object" && providerOptions.outputConfig
        ? (providerOptions.outputConfig as Record<string, unknown>)
        : undefined;
    const { outputConfig: _outputConfig, ...otherProviderOptions } = providerOptions;
    const textFormat = mapStructuredOutput(input.structuredOutput);

    return {
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
      ...(textFormat || outputConfigFromProviderOptions
        ? {
            outputConfig: {
              ...(outputConfigFromProviderOptions ?? {}),
              ...(textFormat ? { textFormat } : {})
            } as ConverseCommandInput["outputConfig"]
          }
        : {}),
      ...otherProviderOptions
    };
  }

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { cleanup } = withTimeoutSignal(input);

    try {
      if (input.reasoning) {
        throw new UnsupportedFeatureError('Provider "bedrock" does not support "reasoning".');
      }

      const commandInput = this.toCommandInput(input);

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

  async stream(input: ModelGenerateInput): Promise<AsyncIterable<StreamEvent>> {
    const { cleanup } = withTimeoutSignal(input);

    if (input.reasoning) {
      throw new UnsupportedFeatureError('Provider "bedrock" does not support "reasoning".');
    }

    const commandInput = this.toCommandInput(input);
    const response = await withRetry(() => this.client.send(new ConverseStreamCommand(commandInput)), input).catch(
      (error) => {
        throw normalizeBedrockError(error);
      }
    );

    return (async function* () {
      try {
        const toolBuffers = new Map<number, { id: string; name: string; input: string }>();
        const stream = response.stream;
        if (!stream) {
          throw new ValidationError("Bedrock streaming response did not include a stream.");
        }

        for await (const event of stream as AsyncIterable<Record<string, any>>) {
          if (event.contentBlockStart?.start?.toolUse) {
            toolBuffers.set(event.contentBlockStart.contentBlockIndex, {
              id: event.contentBlockStart.start.toolUse.toolUseId,
              name: event.contentBlockStart.start.toolUse.name,
              input: ""
            });
            continue;
          }

          if (event.contentBlockDelta?.delta?.text) {
            yield {
              type: "text-delta",
              textDelta: event.contentBlockDelta.delta.text
            } satisfies StreamEvent;
            continue;
          }

          if (event.contentBlockDelta?.delta?.toolUse) {
            const index = event.contentBlockDelta.contentBlockIndex;
            const current = toolBuffers.get(index) ?? {
              id: `${index}`,
              name: "",
              input: ""
            };
            current.input += event.contentBlockDelta.delta.toolUse.input ?? "";
            toolBuffers.set(index, current);
            continue;
          }

          if (event.contentBlockStop) {
            const current = toolBuffers.get(event.contentBlockStop.contentBlockIndex);
            if (current) {
              yield {
                type: "tool-call",
                toolCall: {
                  id: current.id,
                  name: current.name,
                  input: JSON.parse(current.input || "{}")
                }
              } satisfies StreamEvent;
            }
            continue;
          }

          if (event.messageStop) {
            yield {
              type: "finish",
              finishReason: normalizeFinishReason(event.messageStop.stopReason),
              providerFinishReason: event.messageStop.stopReason
            } satisfies StreamEvent;
            continue;
          }

          if (event.metadata?.usage) {
            yield {
              type: "finish",
              usage: {
                inputTokens: event.metadata.usage.inputTokens,
                outputTokens: event.metadata.usage.outputTokens,
                totalTokens:
                  event.metadata.usage.totalTokens ??
                  ((event.metadata.usage.inputTokens ?? 0) + (event.metadata.usage.outputTokens ?? 0))
              }
            } satisfies StreamEvent;
          }
        }
      } finally {
        cleanup();
      }
    })();
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
