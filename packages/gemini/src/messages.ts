import { toJSONSchema } from "zod";
import { UnsupportedFeatureError, isCallableToolDefinition, isHostedToolDefinition } from "@zhivex-ai/core/provider";
import type { JsonValue, ModelGenerateInput, ModelMessage } from "@zhivex-ai/core/contracts";
import { toBase64 } from "./encoding.js";

export const systemInstruction = (messages: ModelMessage[]) => {
  const text = messages
    .filter((message) => message.role === "system")
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<ModelMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return text ? { parts: [{ text }] } : undefined;
};

const mapPart = (part: ModelMessage["parts"][number]) => {
  switch (part.type) {
    case "text":
      return { text: part.text };
    case "image":
      return {
        inlineData: {
          mimeType: part.mediaType ?? "image/jpeg",
          data: part.image
        }
      };
    case "audio":
      return {
        inlineData: {
          mimeType: part.mediaType,
          data: toBase64(part.data)
        }
      };
    case "file":
      return {
        fileData: {
          mimeType: part.mediaType,
          fileUri: part.data
        }
      };
    case "tool-call":
      return {
        functionCall: {
          id: part.toolCall.id,
          name: part.toolCall.name,
          args: part.toolCall.input
        },
        ...(typeof part.toolCall.providerMetadata?.geminiThoughtSignature === "string"
          ? { thoughtSignature: part.toolCall.providerMetadata.geminiThoughtSignature }
          : {})
      };
    case "tool-result":
      return {
        functionResponse: {
          id: part.toolResult.toolCallId,
          name: part.toolResult.toolName,
          response: {
            name: part.toolResult.toolName,
            content: part.toolResult.isError ? part.toolResult.error : part.toolResult.output
          }
        }
      };
    default:
      return {
        text: JSON.stringify(part)
      };
  }
};

export const mapMessages = (messages: ModelMessage[]) =>
  messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: message.parts.map(mapPart)
    }));

export const toGeminiSchema = (schema: unknown): JsonValue => {
  if (Array.isArray(schema)) {
    return schema.map(toGeminiSchema) as JsonValue;
  }

  if (!schema || typeof schema !== "object") {
    return schema as JsonValue;
  }

  const mapped: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key.startsWith("$") || key === "additionalProperties" || value === undefined) {
      continue;
    }
    mapped[key] = toGeminiSchema(value);
  }
  return mapped;
};

export const mapTools = (tools: ModelGenerateInput["tools"]) =>
  tools
    ? (() => {
        const mappedTools: Array<Record<string, unknown>> = [];
        const functionDeclarations = Object.values(tools)
          .filter(isCallableToolDefinition)
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toGeminiSchema(toJSONSchema(tool.schema))
          }));

        if (functionDeclarations.length) {
          mappedTools.push({ functionDeclarations });
        }

        for (const tool of Object.values(tools).filter(isHostedToolDefinition)) {
          if (tool.provider && tool.provider !== "gemini") {
            throw new UnsupportedFeatureError(
              `Provider "gemini" does not support hosted tools declared for provider "${tool.provider}".`
            );
          }

          mappedTools.push({
            [tool.type]: tool.config && typeof tool.config === "object" ? tool.config : {}
          });
        }

        return mappedTools.length ? mappedTools : undefined;
      })()
    : undefined;

