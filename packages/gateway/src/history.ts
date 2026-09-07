import type { ModelMessage } from "@zhivex-ai/core";
import { GatewayError, type GatewayInputMessage } from "./types.js";

function invalid(): never {
  // Never interpolate user content, tool IDs, arguments, or results in diagnostics.
  throw new GatewayError("Invalid or unsupported gateway message history.", false);
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: object, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
};
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/.test(value);

// JSON round trips must not silently remove fields or coerce non-JSON values.
const json = (value: unknown, ancestors = new Set<object>(), depth = 0): void => {
  if (depth > 100) invalid();
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null || ancestors.has(value)) invalid();
  const object = value as object;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
  ancestors.add(object);
  for (const item of Array.isArray(value) ? value : Object.values(object)) json(item, ancestors, depth + 1);
  ancestors.delete(object);
};

export const hasToolHistory = (messages: readonly ModelMessage[]): boolean =>
  messages.some((message) => message.parts.some((part) => part.type === "tool-call" || part.type === "tool-result"));

/** Validate the portable gateway subset before routing or invoking any adapter. */
export const validateGatewayMessages = (messages: GatewayInputMessage[]): void => {
  if (!Array.isArray(messages)) invalid();
  const calls = new Set<string>();
  const pending = new Map<string, string>();
  let seenConversation = false;
  for (const message of messages) {
    if (!record(message)) invalid();
    if (!("parts" in message)) {
      if (pending.size || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") invalid();
      keys(message, ["role", "content", "images"]);
      if (message.images !== undefined) {
        if (!Array.isArray(message.images)) invalid();
        for (const image of message.images) {
          if (!record(image) || typeof image.dataUrl !== "string" || typeof image.mimeType !== "string") invalid();
          keys(image, ["dataUrl", "mimeType"]);
        }
      }
      seenConversation = true;
      continue;
    }
    keys(message, ["role", "parts"]); // Explicitly reject content/images + parts ambiguity.
    if (!Array.isArray(message.parts) || !message.parts.length) invalid();
    if (!["system", "user", "assistant", "tool"].includes(message.role)) invalid();
    if (message.role === "system" && seenConversation) invalid();
    if (message.role !== "system") seenConversation = true;
    if (pending.size && message.role !== "tool") invalid();
    for (const part of message.parts) {
      if (!record(part)) invalid();
      switch (part.type) {
        case "text":
          keys(part, ["type", "text"]);
          if (message.role === "tool" || typeof part.text !== "string") invalid();
          break;
        case "image":
          keys(part, ["type", "image", "mediaType"]);
          if (message.role !== "user" || typeof part.image !== "string" || (part.mediaType !== undefined && typeof part.mediaType !== "string")) invalid();
          break;
        case "tool-call": {
          keys(part, ["type", "toolCall"]);
          const call = part.toolCall;
          if (message.role !== "assistant" || !record(call)) invalid();
          keys(call, ["id", "name", "input"]);
          if (!identifier(call.id) || !identifier(call.name) || calls.has(call.id) || !record(call.input)) invalid();
          json(call.input);
          calls.add(call.id);
          pending.set(call.id, call.name);
          break;
        }
        case "tool-result": {
          keys(part, ["type", "toolResult"]);
          const result = part.toolResult;
          if (message.role !== "tool" || !record(result)) invalid();
          keys(result, ["toolCallId", "toolName", "output", "error", "isError"]);
          if (!identifier(result.toolCallId) || !identifier(result.toolName) || pending.get(result.toolCallId) !== result.toolName || typeof result.isError !== "boolean") invalid();
          if (result.isError) {
            if (result.output !== undefined || !record(result.error) || typeof result.error.message !== "string") invalid();
            keys(result.error, ["message"]);
          } else {
            if (result.error !== undefined) invalid();
            json(result.output);
          }
          pending.delete(result.toolCallId);
          break;
        }
        default:
          invalid();
      }
    }
  }
  if (pending.size) invalid();
};
