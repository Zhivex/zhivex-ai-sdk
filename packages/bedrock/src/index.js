import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { ConfigurationError, ValidationError, normalizeFinishReason, withRetry, withTimeoutSignal } from "@zhivex-ai/core";
const capabilities = {
    streaming: false,
    tools: false,
    structuredOutput: false,
    vision: true,
    files: false,
    embeddings: false
};
const supportedImageFormats = new Set(["png", "jpeg", "gif", "webp"]);
const parseDataUrl = (value) => {
    const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
        throw new ValidationError("Bedrock image inputs must be provided as data URLs.");
    }
    return {
        mediaType: match[1].toLowerCase(),
        bytes: Buffer.from(match[2], "base64")
    };
};
const toBedrockImageFormat = (mediaType) => {
    const subtype = mediaType.split("/")[1]?.toLowerCase() ?? "";
    if (!supportedImageFormats.has(subtype)) {
        throw new ValidationError(`Unsupported Bedrock image media type "${mediaType}".`);
    }
    return subtype;
};
const mapMessagePart = (part) => {
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
const systemBlocksFromMessages = (messages) => {
    const text = messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    return text ? [{ text }] : undefined;
};
const mapMessages = (messages) => messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.parts.flatMap(mapMessagePart)
}));
const normalizeBedrockError = (error) => {
    const err = error;
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
class BedrockLanguageModel {
    modelId;
    client;
    provider = "bedrock";
    capabilities = capabilities;
    constructor(modelId, client) {
        this.modelId = modelId;
        this.client = client;
    }
    async generate(input) {
        const { cleanup } = withTimeoutSignal(input);
        try {
            const commandInput = {
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
            const text = response.output?.message?.content
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
                    totalTokens: response.usage?.totalTokens ?? ((response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0))
                },
                rawResponse: response
            };
        }
        finally {
            cleanup();
        }
    }
}
export const createBedrock = (options = {}) => {
    const client = options.client ??
        (() => {
            const region = options.region ?? process.env.AWS_REGION;
            if (!region) {
                throw new ConfigurationError("Missing AWS region for Bedrock.");
            }
            return new BedrockRuntimeClient({ region });
        })();
    return {
        name: "bedrock",
        languageModel: (modelId) => new BedrockLanguageModel(modelId, client)
    };
};
//# sourceMappingURL=index.js.map