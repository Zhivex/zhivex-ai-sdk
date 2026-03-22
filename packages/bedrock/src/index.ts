import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type Message
} from "@aws-sdk/client-bedrock-runtime";

import {
  ConfigurationError,
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

const capabilities: ModelCapabilities = {
  streaming: false,
  tools: false,
  structuredOutput: false,
  vision: true,
  files: false,
  embeddings: false
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
    default:
      return [];
  }
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
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.parts.flatMap(mapMessagePart)
    }));

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

class BedrockLanguageModel implements LanguageModel {
  readonly provider = "bedrock";
  readonly capabilities = capabilities;

  constructor(
    readonly modelId: string,
    private readonly client: BedrockRuntimeClient
  ) {}

  async generate(input: ModelGenerateInput): Promise<GenerateResult> {
    const { cleanup } = withTimeoutSignal(input);

    try {
      const commandInput: ConverseCommandInput = {
        modelId: this.modelId,
        messages: mapMessages(input.messages),
        system: systemBlocksFromMessages(input.messages),
        inferenceConfig: {
          temperature: input.temperature,
          maxTokens: input.maxTokens
        },
        ...input.providerOptions
      };

      const response = await withRetry(() => this.client.send(new ConverseCommand(commandInput)), input).catch((error) => {
        throw normalizeBedrockError(error);
      });

      const text =
        response.output?.message?.content
          ?.map((chunk) => ("text" in chunk && chunk.text ? chunk.text : ""))
          .join("") ?? "";

      return {
        messages: text
          ? [
              {
                role: "assistant",
                parts: [{ type: "text", text }]
              }
            ]
          : [],
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
