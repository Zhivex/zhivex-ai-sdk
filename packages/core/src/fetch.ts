import { ValidationError } from "./errors.js";
import type { UIMessage } from "./types.js";
import { deserializeUIMessage, serializeUIMessage } from "./ui.js";

const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 1_000;
const DEFAULT_MAX_LINE_BYTES = 512 * 1024;
const messageRoles = new Set(["system", "user", "assistant", "tool"]);

export interface ParseUIMessageRequestOptions {
  maxBytes?: number;
  maxMessages?: number;
  maxLineBytes?: number;
}

const positiveSafeInteger = (value: number | undefined, fallback: number, name: string) => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new ValidationError(`The "${name}" UI message request limit must be a positive safe integer.`);
  }
  return resolved;
};

const readRequestTextWithLimit = async (request: Request, maxBytes: number): Promise<string> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new ValidationError(`UI message request body exceeds the ${maxBytes}-byte limit.`);
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        chunks.length = 0;
        await reader.cancel().catch(() => {});
        throw new ValidationError(`UI message request body exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const validateUIMessage = (value: unknown, index: number): UIMessage => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`UI message at index ${index} must be an object.`);
  }
  const message = value as Record<string, unknown>;
  if (typeof message.id !== "string" || message.id.length === 0) {
    throw new ValidationError(`UI message at index ${index} must have a non-empty string "id".`);
  }
  if (typeof message.role !== "string" || !messageRoles.has(message.role)) {
    throw new ValidationError(`UI message at index ${index} has an unsupported "role".`);
  }
  if (!Array.isArray(message.parts)) {
    throw new ValidationError(`UI message at index ${index} must have a "parts" array.`);
  }
  message.parts.forEach((part, partIndex) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new ValidationError(`UI message part at index ${index}.${partIndex} must be an object.`);
    }
    const current = part as Record<string, unknown>;
    const requireString = (field: string) => {
      if (typeof current[field] !== "string") {
        throw new ValidationError(`UI message part at index ${index}.${partIndex} must have a string "${field}".`);
      }
    };
    if (current.type === "text") {
      requireString("text");
    } else if (current.type === "image") {
      requireString("image");
    } else if (current.type === "audio") {
      requireString("data");
      requireString("mediaType");
    } else if (current.type === "file") {
      requireString("data");
      requireString("mediaType");
    } else if (current.type === "provider-data") {
      requireString("provider");
      if (!("data" in current)) {
        throw new ValidationError(`UI message part at index ${index}.${partIndex} must have "data".`);
      }
    } else if (current.type === "tool-call") {
      const call = current.toolCall;
      if (!call || typeof call !== "object" || Array.isArray(call)) {
        throw new ValidationError(`UI message part at index ${index}.${partIndex} must have a "toolCall" object.`);
      }
      const toolCall = call as Record<string, unknown>;
      if (typeof toolCall.id !== "string" || typeof toolCall.name !== "string" || !("input" in toolCall)) {
        throw new ValidationError(`UI message tool call at index ${index}.${partIndex} is malformed.`);
      }
    } else if (current.type === "tool-result") {
      const result = current.toolResult;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new ValidationError(`UI message part at index ${index}.${partIndex} must have a "toolResult" object.`);
      }
      const toolResult = result as Record<string, unknown>;
      if (
        typeof toolResult.toolCallId !== "string" ||
        typeof toolResult.toolName !== "string" ||
        typeof toolResult.isError !== "boolean"
      ) {
        throw new ValidationError(`UI message tool result at index ${index}.${partIndex} is malformed.`);
      }
    } else {
      throw new ValidationError(`UI message part at index ${index}.${partIndex} has an unsupported "type".`);
    }
  });
  return value as UIMessage;
};

const validateUIMessageArray = (value: unknown, maxMessages: number): UIMessage[] => {
  if (!Array.isArray(value)) {
    throw new ValidationError("UI message request body must be an array.");
  }
  if (value.length > maxMessages) {
    throw new ValidationError(`UI message request exceeds the ${maxMessages}-message limit.`);
  }
  return value.map(validateUIMessage);
};

export const parseUIMessageRequest = async (
  request: Request,
  options: ParseUIMessageRequestOptions = {}
): Promise<UIMessage[]> => {
  const maxBytes = positiveSafeInteger(options.maxBytes, DEFAULT_MAX_REQUEST_BYTES, "maxBytes");
  const maxMessages = positiveSafeInteger(options.maxMessages, DEFAULT_MAX_MESSAGES, "maxMessages");
  const maxLineBytes = positiveSafeInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
  const contentType = request.headers.get("content-type") ?? "";
  const text = await readRequestTextWithLimit(request, maxBytes);

  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new ValidationError("UI message request body must contain valid JSON.", { cause: error });
    }
    return validateUIMessageArray(body, maxMessages);
  }

  if (!text.trim()) {
    return [];
  }

  const lines = text.trim().split("\n");
  if (lines.length > maxMessages) {
    throw new ValidationError(`UI message request exceeds the ${maxMessages}-message limit.`);
  }
  const encoder = new TextEncoder();
  return lines.map((line, index) => {
    if (encoder.encode(line).byteLength > maxLineBytes) {
      throw new ValidationError(`UI message line ${index + 1} exceeds the ${maxLineBytes}-byte limit.`);
    }
    try {
      return validateUIMessage(deserializeUIMessage(line), index);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError(`UI message line ${index + 1} must contain valid JSON.`, { cause: error });
    }
  });
};

export const createUIMessageJsonResponse = (messages: UIMessage[], init: ResponseInit = {}): Response =>
  Response.json(messages, init);

export const createUIMessageLinesResponse = (messages: UIMessage[], init: ResponseInit = {}): Response =>
  new Response(messages.map((message) => serializeUIMessage(message)).join("\n"), {
    ...init,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      ...Object.fromEntries(new Headers(init.headers).entries())
    }
  });
