import type { ModelMessage } from "@zhivex-ai/core";

import type {
  GatewayInputMessage,
  GatewayModelTarget,
  GatewayResponse
} from "./types.js";
import { validateGatewayMessages } from "./history.js";

export const gatewayMessagesToModelMessages = (
  messages: GatewayInputMessage[],
  systemPrompt?: string
): ModelMessage[] => {
  validateGatewayMessages(messages);
  const mappedMessages: ModelMessage[] = [];

  if (systemPrompt) {
    mappedMessages.push({
      role: "system",
      parts: [{ type: "text", text: systemPrompt }]
    });
  }

  for (const message of messages) {
    if ("parts" in message) {
      mappedMessages.push(structuredClone(message));
      continue;
    }
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
  reasonCode: `routing-${mode}`,
  reason: `Ordered by ${mode} mode with ${intent} intent.`
});
