import { StarterConfigurationError } from "./server";
import type { UIMessage } from "@zhivex-ai/sdk";

export const MAX_CHAT_REQUEST_BYTES = 64 * 1024;
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_SESSION_ID_CHARS = 200;
export const MAX_APPROVALS = 20;

export class ChatRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ChatRequestError";
    this.status = status;
  }
}

const readTextWithLimit = async (request: Request, maxBytes: number): Promise<string> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new ChatRequestError("Request body is too large.", 413);
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
        await reader.cancel().catch(() => undefined);
        throw new ChatRequestError("Request body is too large.", 413);
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

export const readChatJson = async (request: Request): Promise<Record<string, unknown>> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ChatRequestError("Content-Type must be application/json.", 415);
  }

  const text = await readTextWithLimit(request, MAX_CHAT_REQUEST_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ChatRequestError("Request body must contain valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatRequestError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
};

export const optionalBoundedString = (
  value: unknown,
  field: string,
  maxChars: number
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw new ChatRequestError(`${field} must be a non-empty string of at most ${maxChars} characters.`);
  }
  return value;
};

export const optionalUserMessage = (value: unknown): UIMessage | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatRequestError("message must be a user UIMessage object.");
  }

  const message = value as Record<string, unknown>;
  if (
    typeof message.id !== "string" ||
    message.id.length === 0 ||
    message.id.length > MAX_SESSION_ID_CHARS ||
    message.role !== "user" ||
    !Array.isArray(message.parts) ||
    message.parts.length === 0 ||
    message.parts.length > 20
  ) {
    throw new ChatRequestError("message must be a bounded user UIMessage.");
  }

  for (const part of message.parts) {
    if (
      !part ||
      typeof part !== "object" ||
      Array.isArray(part) ||
      (part as Record<string, unknown>).type !== "text"
    ) {
      throw new ChatRequestError("The starter accepts text message parts only.");
    }
    const text = (part as Record<string, unknown>).text;
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_MESSAGE_CHARS) {
      throw new ChatRequestError(
        `Each text message part must contain at most ${MAX_MESSAGE_CHARS} characters.`
      );
    }
  }

  return value as UIMessage;
};

export const safeChatErrorResponse = (error: unknown, request: Request): Response => {
  if (request.signal.aborted) {
    return Response.json({ error: "Request cancelled." }, { status: 408, headers: noStoreHeaders });
  }
  if (error instanceof ChatRequestError) {
    return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders });
  }
  if (error instanceof StarterConfigurationError) {
    return Response.json({ error: error.message }, { status: 503, headers: noStoreHeaders });
  }
  if (error instanceof Error && error.name === "ValidationError") {
    return Response.json({ error: "Invalid chat request." }, { status: 400, headers: noStoreHeaders });
  }
  return Response.json({ error: "Chat request failed." }, { status: 500, headers: noStoreHeaders });
};

export const noStoreHeaders = {
  "cache-control": "no-store"
} as const;
