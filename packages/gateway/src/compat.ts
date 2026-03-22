import type { ModelMessage } from "@zhivex-ai/core";

import type {
  GatewayMessage,
  GatewayModelTarget,
  GatewayProviderId,
  GatewayResponse
} from "./types.js";

export const supportsVisionInput = (provider: GatewayProviderId, modelId: string): boolean => {
  const model = modelId.toLowerCase();

  if (provider === "gemini") {
    return !model.includes("embedding");
  }

  if (provider === "bedrock") {
    return model.includes("nova") || model.includes("claude-3") || model.includes("claude-4");
  }

  return true;
};

export const stripImagesForUnsupportedModel = (
  messages: GatewayMessage[],
  provider: GatewayProviderId,
  modelId: string
): GatewayMessage[] => {
  if (supportsVisionInput(provider, modelId)) {
    return messages;
  }

  return messages.map((message) => (message.images?.length ? { ...message, images: [] } : message));
};

export const gatewayMessagesToModelMessages = (
  messages: GatewayMessage[],
  systemPrompt?: string
): ModelMessage[] => {
  const mappedMessages: ModelMessage[] = [];

  if (systemPrompt) {
    mappedMessages.push({
      role: "system",
      parts: [{ type: "text", text: systemPrompt }]
    });
  }

  for (const message of messages) {
    mappedMessages.push({
      role: message.role,
      parts: [
        { type: "text", text: message.content },
        ...((message.images ?? []).map((image) => ({
          type: "image" as const,
          image: image.dataUrl,
          mediaType: image.mimeType
        })) ?? [])
      ]
    });
  }

  return mappedMessages;
};

export const createRouteDecision = (
  mode: GatewayResponse["routeDecision"]["mode"],
  intent: GatewayResponse["routeDecision"]["intent"],
  orderedTargets: GatewayModelTarget[]
): GatewayResponse["routeDecision"] => ({
  mode,
  intent,
  orderedTargets,
  reason: `Ordered by ${mode} mode with ${intent} intent.`
});
