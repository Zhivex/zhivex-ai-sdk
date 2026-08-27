import {
  serializeJsonValue,
  toUIMessageStream,
  type AgentStreamEvent,
  type ContentPart,
  type FinishReason,
  type JsonValue,
  type ModelMessage,
  type RunnerStreamResult,
  type StreamTextResult,
  type UIMessage as ZhivexUIMessage,
  type UIMessageChunk as ZhivexUIMessageChunk
} from "@zhivex-ai/core";
import type {
  ChatTransport as AISDKChatTransport,
  UIMessage as AISDKUIMessage,
  UIMessageChunk as AISDKUIMessageChunk,
  UIMessagePart as AISDKUIMessagePart
} from "ai";
import { createFetchChatTransport } from "./transport.js";
import type {
  ChatMessage,
  ChatStreamChunk,
  ChatTransportRequest,
  ChatTransportErrorFormatter,
  FetchChatTransportOptions
} from "./types.js";

const AI_SDK_PROVIDER = "ai-sdk";
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_PARTS = 1_000;
const DEFAULT_MAX_ID_CHARS = 200;
const DEFAULT_PUBLIC_STREAM_ERROR = "Chat request failed.";
const AI_SDK_UI_STREAM_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "x-vercel-ai-ui-message-stream": "v1"
} as const;

type AISDKUIMessagePartValue = AISDKUIMessagePart<Record<string, unknown>, Record<string, {
  input: unknown;
  output: unknown;
}>>;

type ZhivexUIStreamSource =
  | StreamTextResult
  | { eventStream: AsyncIterable<AgentStreamEvent> }
  | AsyncIterable<ChatStreamChunk>;

export type AISDKUIUnsupportedPartPolicy = "preserve" | "error";
export type AISDKUIProviderDataPolicy = "degrade" | "preserve";
export type AISDKUIUnknownEventPolicy = "degrade" | "error";

export interface AISDKUIMessageAdapterOptions {
  /** Unsupported AI SDK parts are tagged as provider data by default. */
  unsupportedParts?: AISDKUIUnsupportedPartPolicy;
  /** Arbitrary provider payloads are reduced to provider + kind by default. */
  providerData?: AISDKUIProviderDataPolicy;
}

export interface AISDKUIStreamOptions {
  messageId?: string;
  /** Unknown Zhivex events become a payload-free data part by default. */
  unknownEvents?: AISDKUIUnknownEventPolicy;
  /** Explicit opt-in for a public, application-safe stream error formatter. */
  formatStreamError?: (error: unknown) => string | undefined;
}

export interface ParseAISDKUIMessageRequestOptions extends AISDKUIMessageAdapterOptions {
  maxBytes?: number;
  maxMessages?: number;
  maxParts?: number;
  maxIdChars?: number;
}

export interface ParsedAISDKUIMessageRequest {
  chatId?: string;
  messageId?: string;
  trigger?: "submit-message" | "regenerate-message";
  messages: AISDKUIMessage[];
  /** UI-only metadata retained outside provider-facing model content. */
  messageMetadata: Array<{ messageId: string; metadata: JsonValue }>;
  modelMessages: ModelMessage[];
}

export interface AISDKUIChatTransportRequestContext {
  chatId: string;
  trigger: "submit-message" | "regenerate-message";
  messageId?: string;
  messages: AISDKUIMessage[];
  message?: ZhivexUIMessage;
  approvals: Array<{
    provider: string;
    approvalRequestId: string;
    approve: boolean;
    reason?: string;
  }>;
  /** Metadata from the latest AI SDK UI message; never added to message.parts. */
  messageMetadata?: JsonValue;
  metadata?: unknown;
  body?: object;
}

export interface AISDKUIChatTransportOptions
  extends Omit<FetchChatTransportOptions, "buildRequestBody" | "headers">,
    AISDKUIMessageAdapterOptions,
    AISDKUIStreamOptions {
  headers?: HeadersInit | ((context: AISDKUIChatTransportRequestContext) => HeadersInit | Promise<HeadersInit>);
  buildRequestBody?: (
    context: AISDKUIChatTransportRequestContext
  ) => unknown | Promise<unknown>;
  /** Bounds the serialized POST body before fetch. Defaults to 1 MiB. */
  maxRequestBytes?: number;
  /** Opt in only when buildRequestBody targets an idempotent regeneration endpoint. */
  supportsRegenerate?: boolean;
}

export class AISDKUICompatibilityError extends Error {
  readonly code:
    | "invalid_message"
    | "invalid_part"
    | "unsupported_part"
    | "invalid_request"
    | "request_too_large"
    | "unknown_stream_event";
  readonly partType?: string;

  constructor(
    message: string,
    options: {
      code: AISDKUICompatibilityError["code"];
      partType?: string;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = "AISDKUICompatibilityError";
    this.code = options.code;
    this.partType = options.partType;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isAIMessageRole = (value: unknown): value is AISDKUIMessage["role"] =>
  value === "system" || value === "user" || value === "assistant";

const positiveSafeInteger = (name: string, value: number | undefined, fallback: number): number => {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return normalized;
};

const jsonValue = (value: unknown, field: string): JsonValue => {
  try {
    const serialized = serializeJsonValue(value);
    if (serialized === undefined) {
      throw new TypeError(`${field} is not JSON serializable.`);
    }
    return serialized;
  } catch (error) {
    throw new AISDKUICompatibilityError(`${field} must be JSON serializable.`, {
      code: "invalid_part",
      cause: error
    });
  }
};

const jsonObject = (value: unknown, field: string): Record<string, JsonValue> => {
  const serialized = jsonValue(value, field);
  if (!isRecord(serialized)) {
    throw new AISDKUICompatibilityError(`${field} must be a JSON object.`, {
      code: "invalid_part"
    });
  }
  return serialized as Record<string, JsonValue>;
};

const preservedPart = (part: Record<string, unknown>): ContentPart => ({
  type: "provider-data",
  provider: AI_SDK_PROVIDER,
  data: {
    type: "ui-part",
    part: jsonObject(part, "AI SDK UI part")
  }
});

const unsupportedPart = (
  part: Record<string, unknown>,
  policy: AISDKUIUnsupportedPartPolicy
): ContentPart[] => {
  const partType = typeof part.type === "string" ? part.type : "unknown";
  if (policy === "error") {
    throw new AISDKUICompatibilityError(
      `AI SDK UI part "${partType}" is not supported by the Zhivex message contract.`,
      { code: "unsupported_part", partType }
    );
  }
  return [preservedPart(part)];
};

const toolNameFromPart = (part: Record<string, unknown>): string | undefined => {
  if (part.type === "dynamic-tool") {
    return isNonEmptyString(part.toolName) ? part.toolName : undefined;
  }
  return typeof part.type === "string" && part.type.startsWith("tool-")
    ? part.type.slice("tool-".length)
    : undefined;
};

const toolPartsFromAI = (
  part: Record<string, unknown>,
  policy: AISDKUIUnsupportedPartPolicy
): ContentPart[] => {
  const name = toolNameFromPart(part);
  if (!name || !isNonEmptyString(part.toolCallId) || !isNonEmptyString(part.state)) {
    throw new AISDKUICompatibilityError("AI SDK UI tool parts require a name, toolCallId, and state.", {
      code: "invalid_part",
      partType: typeof part.type === "string" ? part.type : undefined
    });
  }

  if (part.state === "input-streaming") {
    return unsupportedPart(part, policy);
  }

  const input = jsonValue(part.input ?? null, `Input for tool "${name}"`);
  const parts: ContentPart[] = [
    {
      type: "tool-call",
      toolCall: {
        id: part.toolCallId,
        name,
        input
      }
    }
  ];

  if (part.state === "output-available") {
    parts.push({
      type: "tool-result",
      toolResult: {
        toolCallId: part.toolCallId,
        toolName: name,
        output: jsonValue(part.output ?? null, `Output for tool "${name}"`),
        isError: false
      }
    });
  } else if (part.state === "output-error") {
    parts.push({
      type: "tool-result",
      toolResult: {
        toolCallId: part.toolCallId,
        toolName: name,
        error: {
          message: typeof part.errorText === "string" ? part.errorText : "Tool execution failed."
        },
        isError: true
      }
    });
  } else if (part.state === "output-denied") {
    parts.push({
      type: "tool-result",
      toolResult: {
        toolCallId: part.toolCallId,
        toolName: name,
        error: { message: "Tool execution was denied." },
        isError: true
      }
    });
  }

  if (part.state === "approval-requested" || part.state === "approval-responded") {
    parts.push(preservedPart(part));
  }

  return parts;
};

const contentPartsFromAI = (
  message: AISDKUIMessage,
  options: AISDKUIMessageAdapterOptions
): ContentPart[] => {
  const policy = options.unsupportedParts ?? "preserve";
  const content: ContentPart[] = [];

  for (const rawPart of message.parts) {
    if (!isRecord(rawPart) || !isNonEmptyString(rawPart.type)) {
      throw new AISDKUICompatibilityError("AI SDK UI message parts must be typed objects.", {
        code: "invalid_part"
      });
    }
    const part = rawPart as Record<string, unknown>;

    if (part.type === "text") {
      if (typeof part.text !== "string") {
        throw new AISDKUICompatibilityError("AI SDK UI text parts require a string text field.", {
          code: "invalid_part",
          partType: part.type
        });
      }
      content.push({ type: "text", text: part.text });
      continue;
    }

    if (part.type === "reasoning") {
      if (typeof part.text !== "string") {
        throw new AISDKUICompatibilityError("AI SDK UI reasoning parts require a string text field.", {
          code: "invalid_part",
          partType: part.type
        });
      }
      content.push({
        type: "provider-data",
        provider: AI_SDK_PROVIDER,
        data: { type: "reasoning_content", reasoningContent: part.text }
      });
      continue;
    }

    if (part.type === "file") {
      if (!isNonEmptyString(part.url) || !isNonEmptyString(part.mediaType)) {
        throw new AISDKUICompatibilityError("AI SDK UI file parts require url and mediaType.", {
          code: "invalid_part",
          partType: part.type
        });
      }
      if (part.mediaType.startsWith("image/")) {
        content.push({ type: "image", image: part.url, mediaType: part.mediaType });
      } else if (part.mediaType.startsWith("audio/")) {
        content.push({
          type: "audio",
          data: part.url,
          mediaType: part.mediaType,
          filename: typeof part.filename === "string" ? part.filename : undefined
        });
      } else {
        content.push({
          type: "file",
          data: part.url,
          mediaType: part.mediaType,
          filename: typeof part.filename === "string" ? part.filename : undefined
        });
      }
      continue;
    }

    if (part.type === "dynamic-tool" || (part.type as string).startsWith("tool-")) {
      content.push(...toolPartsFromAI(part, policy));
      continue;
    }

    content.push(...unsupportedPart(part, policy));
  }

  return content;
};

const messageMetadataFromAI = (message: AISDKUIMessage): JsonValue | undefined =>
  message.metadata === undefined
    ? undefined
    : jsonValue(message.metadata, "AI SDK UI message metadata");

const validateAIMessage = (value: unknown): AISDKUIMessage => {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isAIMessageRole(value.role) || !Array.isArray(value.parts)) {
    throw new AISDKUICompatibilityError(
      "AI SDK UI messages require a non-empty id, a system/user/assistant role, and a parts array.",
      { code: "invalid_message" }
    );
  }
  return value as unknown as AISDKUIMessage;
};

export const fromAISDKUIMessage = (
  value: AISDKUIMessage,
  options: AISDKUIMessageAdapterOptions = {}
): ModelMessage => {
  const message = validateAIMessage(value);
  return {
    role: message.role,
    parts: contentPartsFromAI(message, options)
  };
};

export const fromAISDKUIMessages = (
  messages: readonly AISDKUIMessage[],
  options: AISDKUIMessageAdapterOptions = {}
): ModelMessage[] => messages.map((message) => fromAISDKUIMessage(message, options));

const bytesToBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const toDataURL = (
  value: string | Uint8Array | ArrayBuffer,
  mediaType: string
): string => {
  if (typeof value !== "string") {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
  }
  if (/^(?:https?:|data:|blob:|\/)/u.test(value)) {
    return value;
  }
  return `data:${mediaType};base64,${value}`;
};

const reasoningText = (part: Extract<ContentPart, { type: "provider-data" }>): string | undefined => {
  if (!isRecord(part.data) || part.data.type !== "reasoning_content") {
    return undefined;
  }
  return typeof part.data.reasoningContent === "string"
    ? part.data.reasoningContent
    : undefined;
};

const recoveredAIPart = (
  part: Extract<ContentPart, { type: "provider-data" }>
): Record<string, unknown> | undefined => {
  if (part.provider !== AI_SDK_PROVIDER || !isRecord(part.data) || part.data.type !== "ui-part") {
    return undefined;
  }
  return isRecord(part.data.part) ? part.data.part : undefined;
};

const toolPart = (
  toolCallId: string,
  toolName: string,
  state: "input-available" | "output-available" | "output-error",
  values: { input?: JsonValue; output?: JsonValue; errorText?: string }
): Record<string, unknown> => ({
  type: "dynamic-tool",
  toolName,
  toolCallId,
  state,
  input: values.input ?? null,
  ...(state === "output-available" ? { output: values.output ?? null } : {}),
  ...(state === "output-error" ? { errorText: values.errorText ?? "Tool execution failed." } : {})
});

const dataPartFromProvider = (
  part: Extract<ContentPart, { type: "provider-data" }>,
  policy: AISDKUIProviderDataPolicy
): Record<string, unknown> => {
  const kind = isRecord(part.data) && typeof part.data.type === "string"
    ? part.data.type
    : "provider-data";
  return {
    type: "data-zhivex-provider",
    data: policy === "preserve"
      ? { provider: part.provider, data: part.data }
      : { provider: part.provider, kind, degraded: true }
  };
};

const toAISDKParts = (
  message: ModelMessage | ZhivexUIMessage,
  options: AISDKUIMessageAdapterOptions
): { parts: AISDKUIMessagePartValue[]; metadata?: unknown } => {
  const parts: Record<string, unknown>[] = [];
  const toolIndexes = new Map<string, number>();
  let metadata: unknown;

  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      parts.push({
        type: "file",
        url: toDataURL(part.image, part.mediaType ?? "image/*"),
        mediaType: part.mediaType ?? "image/*"
      });
      continue;
    }
    if (part.type === "audio") {
      parts.push({
        type: "file",
        url: toDataURL(part.data, part.mediaType),
        mediaType: part.mediaType,
        ...(part.filename ? { filename: part.filename } : {})
      });
      continue;
    }
    if (part.type === "file") {
      parts.push({
        type: "file",
        url: toDataURL(part.data, part.mediaType),
        mediaType: part.mediaType,
        ...(part.filename ? { filename: part.filename } : {})
      });
      continue;
    }
    if (part.type === "tool-call") {
      toolIndexes.set(part.toolCall.id, parts.length);
      parts.push(toolPart(part.toolCall.id, part.toolCall.name, "input-available", {
        input: part.toolCall.input
      }));
      continue;
    }
    if (part.type === "tool-result") {
      const index = toolIndexes.get(part.toolResult.toolCallId);
      const previous = index === undefined ? undefined : parts[index];
      const input = previous && "input" in previous
        ? jsonValue(previous.input, "Tool input")
        : null;
      const next = part.toolResult.isError
        ? toolPart(part.toolResult.toolCallId, part.toolResult.toolName, "output-error", {
            input,
            errorText: part.toolResult.error?.message
          })
        : toolPart(part.toolResult.toolCallId, part.toolResult.toolName, "output-available", {
            input,
            output: part.toolResult.output ?? null
          });
      if (index === undefined) {
        toolIndexes.set(part.toolResult.toolCallId, parts.length);
        parts.push(next);
      } else {
        parts[index] = next;
      }
      continue;
    }

    const reasoning = reasoningText(part);
    if (reasoning !== undefined) {
      parts.push({ type: "reasoning", text: reasoning, state: "done" });
      continue;
    }
    if (
      part.provider === AI_SDK_PROVIDER &&
      isRecord(part.data) &&
      part.data.type === "ui-message-metadata"
    ) {
      metadata = part.data.metadata;
      continue;
    }
    const recovered = recoveredAIPart(part);
    if (recovered) {
      parts.push(recovered);
      continue;
    }
    parts.push(dataPartFromProvider(part, options.providerData ?? "degrade"));
  }

  return {
    parts: parts as AISDKUIMessagePartValue[],
    metadata
  };
};

export const toAISDKUIMessage = (
  message: ModelMessage | ZhivexUIMessage,
  id = "zhivex-message",
  options: AISDKUIMessageAdapterOptions = {}
): AISDKUIMessage => {
  const converted = toAISDKParts(message, options);
  return {
    id: "id" in message && typeof message.id === "string" ? message.id : id,
    role: message.role === "tool" ? "assistant" : message.role,
    parts: converted.parts,
    ...(converted.metadata !== undefined ? { metadata: converted.metadata } : {})
  };
};

export const toAISDKUIMessages = (
  messages: readonly (ModelMessage | ZhivexUIMessage)[],
  options: AISDKUIMessageAdapterOptions = {}
): AISDKUIMessage[] => {
  const result: AISDKUIMessage[] = [];
  messages.forEach((message, index) => {
    const converted = toAISDKUIMessage(message, `zhivex-message-${index + 1}`, options);
    if (message.role === "tool" && result.at(-1)?.role === "assistant") {
      result[result.length - 1] = {
        ...result[result.length - 1]!,
        parts: [...result[result.length - 1]!.parts, ...converted.parts]
      };
    } else {
      result.push(converted);
    }
  });
  return result;
};

export const encodeZhivexApprovalId = (provider: string, approvalRequestId: string): string =>
  `zhivex:${encodeURIComponent(JSON.stringify([provider, approvalRequestId]))}`;

export const decodeZhivexApprovalId = (
  value: string
): { provider: string; approvalRequestId: string } | undefined => {
  if (!value.startsWith("zhivex:")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(value.slice("zhivex:".length)));
    return Array.isArray(parsed) && parsed.length === 2 && parsed.every(isNonEmptyString)
      ? { provider: parsed[0], approvalRequestId: parsed[1] }
      : undefined;
  } catch {
    return undefined;
  }
};

const finishReason = (value: unknown): Exclude<FinishReason, "refusal" | "unknown"> | "other" | undefined => {
  if (
    value === "stop" ||
    value === "length" ||
    value === "tool-calls" ||
    value === "content-filter" ||
    value === "error"
  ) {
    return value;
  }
  if (value === "refusal") {
    return "content-filter";
  }
  return value === undefined ? undefined : "other";
};

const reasoningDeltaFromChunk = (chunk: Record<string, unknown>): string | undefined => {
  if (chunk.type !== "provider-data" || !isRecord(chunk.data) || chunk.data.type !== "reasoning_content") {
    return undefined;
  }
  return typeof chunk.data.reasoningContent === "string"
    ? chunk.data.reasoningContent
    : undefined;
};

const publicStreamError = (chunk: Record<string, unknown>, options: AISDKUIStreamOptions): string => {
  const error = isRecord(chunk.error) && typeof chunk.error.message === "string"
    ? new Error(chunk.error.message)
    : new Error(DEFAULT_PUBLIC_STREAM_ERROR);
  try {
    const formatted = options.formatStreamError?.(error);
    return typeof formatted === "string" && formatted.trim().length > 0
      ? formatted
      : DEFAULT_PUBLIC_STREAM_ERROR;
  } catch {
    return DEFAULT_PUBLIC_STREAM_ERROR;
  }
};

const sourceChunks = (source: ZhivexUIStreamSource): AsyncIterable<ChatStreamChunk> => {
  if (isRecord(source) && "eventStream" in source) {
    return toUIMessageStream(source as { eventStream: AsyncIterable<AgentStreamEvent> }) as AsyncIterable<ChatStreamChunk>;
  }
  return source as AsyncIterable<ChatStreamChunk>;
};

const safeSourceChunks = (source: ZhivexUIStreamSource): AsyncIterable<ChatStreamChunk> =>
  (async function* () {
    try {
      yield* sourceChunks(source);
    } catch (error) {
      yield {
        type: "error",
        messageId: "zhivex-error",
        error: {
          message: error instanceof Error ? error.message : DEFAULT_PUBLIC_STREAM_ERROR
        }
      };
    }
  })();

export const toAISDKUIMessageStream = (
  source: ZhivexUIStreamSource,
  options: AISDKUIStreamOptions = {}
): AsyncIterable<AISDKUIMessageChunk> => (async function* () {
  let started = false;
  let finished = false;
  let messageId = options.messageId;
  let textId: string | undefined;
  let reasoningId: string | undefined;
  let textGeneration = 0;
  let reasoningGeneration = 0;
  const tools = new Map<string, { name: string; input: JsonValue }>();

  const ensureStarted = function* (chunkMessageId?: unknown): Generator<AISDKUIMessageChunk> {
    if (started) return;
    if (!messageId && isNonEmptyString(chunkMessageId)) {
      messageId = chunkMessageId;
    }
    started = true;
    yield { type: "start", ...(messageId ? { messageId } : {}) };
  };

  const closeText = function* (): Generator<AISDKUIMessageChunk> {
    if (textId) {
      yield { type: "text-end", id: textId };
      textId = undefined;
    }
  };

  const closeReasoning = function* (): Generator<AISDKUIMessageChunk> {
    if (reasoningId) {
      yield { type: "reasoning-end", id: reasoningId };
      reasoningId = undefined;
    }
  };

  for await (const rawChunk of safeSourceChunks(source)) {
    if (!isRecord(rawChunk) || !isNonEmptyString(rawChunk.type)) {
      continue;
    }
    const chunk = rawChunk as Record<string, unknown>;
    yield* ensureStarted(chunk.messageId);

    if (chunk.type === "text-delta" && typeof chunk.textDelta === "string") {
      yield* closeReasoning();
      if (!textId) {
        textGeneration += 1;
        textId = `${messageId ?? "zhivex"}:text:${textGeneration}`;
        yield { type: "text-start", id: textId };
      }
      yield { type: "text-delta", id: textId, delta: chunk.textDelta };
      continue;
    }

    const reasoningDelta = reasoningDeltaFromChunk(chunk);
    if (reasoningDelta !== undefined) {
      yield* closeText();
      if (!reasoningId) {
        reasoningGeneration += 1;
        reasoningId = `${messageId ?? "zhivex"}:reasoning:${reasoningGeneration}`;
        yield { type: "reasoning-start", id: reasoningId };
      }
      yield { type: "reasoning-delta", id: reasoningId, delta: reasoningDelta };
      continue;
    }

    yield* closeText();
    yield* closeReasoning();

    if (chunk.type === "tool-call" && isRecord(chunk.toolCall)) {
      const call = chunk.toolCall;
      if (isNonEmptyString(call.id) && isNonEmptyString(call.name)) {
        const input = jsonValue(call.input ?? null, `Input for tool "${call.name}"`);
        tools.set(call.id, { name: call.name, input });
        yield {
          type: "tool-input-available",
          toolCallId: call.id,
          toolName: call.name,
          input,
          dynamic: true
        };
      }
      continue;
    }

    if (chunk.type === "tool-result" && isRecord(chunk.toolResult)) {
      const result = chunk.toolResult;
      if (isNonEmptyString(result.toolCallId) && isNonEmptyString(result.toolName)) {
        if (!tools.has(result.toolCallId)) {
          tools.set(result.toolCallId, { name: result.toolName, input: null });
          yield {
            type: "tool-input-available",
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            input: null,
            dynamic: true
          };
        }
        if (result.isError === true) {
          yield {
            type: "tool-output-error",
            toolCallId: result.toolCallId,
            errorText: isRecord(result.error) && typeof result.error.message === "string"
              ? result.error.message
              : "Tool execution failed.",
            dynamic: true
          };
        } else {
          yield {
            type: "tool-output-available",
            toolCallId: result.toolCallId,
            output: jsonValue(result.output ?? null, `Output for tool "${result.toolName}"`),
            dynamic: true
          };
        }
      }
      continue;
    }

    if ((chunk.type === "tool-approval-request" || chunk.type === "agent-approval-request") && isRecord(chunk.approval)) {
      const approval = chunk.approval;
      if (isNonEmptyString(approval.provider) && isNonEmptyString(approval.id)) {
        const toolCallId = isNonEmptyString(approval.toolCallId)
          ? approval.toolCallId
          : `approval:${approval.provider}:${approval.id}`;
        if (!tools.has(toolCallId)) {
          let input: JsonValue = null;
          if (typeof approval.arguments === "string") {
            try {
              input = jsonValue(JSON.parse(approval.arguments), "Approval arguments");
            } catch {
              input = approval.arguments;
            }
          }
          const name = isNonEmptyString(approval.name) ? approval.name : "approval";
          tools.set(toolCallId, { name, input });
          yield {
            type: "tool-input-available",
            toolCallId,
            toolName: name,
            input,
            dynamic: true
          };
        }
        yield {
          type: "tool-approval-request",
          approvalId: encodeZhivexApprovalId(approval.provider, approval.id),
          toolCallId,
          ...(typeof approval.signature === "string" ? { signature: approval.signature } : {})
        };
      }
      continue;
    }

    if (chunk.type === "agent-approval-resolved" && isRecord(chunk.approval)) {
      const approval = chunk.approval;
      if (isNonEmptyString(approval.provider) && isNonEmptyString(approval.approvalRequestId)) {
        yield {
          type: "tool-approval-response",
          approvalId: encodeZhivexApprovalId(approval.provider, approval.approvalRequestId),
          approved: approval.approve === true,
          ...(typeof approval.reason === "string" ? { reason: approval.reason } : {})
        };
      }
      continue;
    }

    if (chunk.type === "image-generation" && isRecord(chunk.image) && typeof chunk.image.mediaType === "string") {
      const image = chunk.image;
      const mediaType = image.mediaType as string;
      const url = typeof image.uri === "string"
        ? image.uri
        : typeof image.data === "string"
          ? `data:${mediaType};base64,${image.data}`
          : undefined;
      if (url) {
        yield { type: "file", url, mediaType };
      }
      continue;
    }

    if (chunk.type === "agent-step-start") {
      yield { type: "start-step" };
      continue;
    }
    if (chunk.type === "agent-step-finish") {
      yield { type: "finish-step" };
      continue;
    }

    if (chunk.type === "error") {
      yield { type: "error", errorText: publicStreamError(chunk, options) };
      finished = true;
      continue;
    }

    if (chunk.type === "finish") {
      yield { type: "finish", finishReason: finishReason(chunk.finishReason) };
      finished = true;
      continue;
    }

    if (chunk.type === "session-finish" || chunk.type === "agent-run-finish") {
      if (!finished) {
        yield { type: "finish", finishReason: "other" };
        finished = true;
      }
      continue;
    }

    if (chunk.type === "agent-run-start" || chunk.type === "agent-compaction" || chunk.type === "provider-data") {
      yield {
        type: "data-zhivex-event",
        data: { sourceType: chunk.type, degraded: true }
      };
      continue;
    }

    if ((options.unknownEvents ?? "degrade") === "error") {
      throw new AISDKUICompatibilityError(`Unknown Zhivex stream event "${chunk.type}".`, {
        code: "unknown_stream_event"
      });
    }
    yield {
      type: "data-zhivex-event",
      data: { sourceType: chunk.type, degraded: true }
    };
  }

  yield* closeText();
  yield* closeReasoning();
  if (!started) {
    yield* ensureStarted();
  }
  if (!finished) {
    yield { type: "finish", finishReason: "other" };
  }
})();

const readableFromAsyncIterable = <T>(
  iterable: AsyncIterable<T>,
  callbacks: {
    onCancel?: (reason: unknown) => void;
    onFinally?: () => void;
  } = {}
): ReadableStream<T> => {
  const iterator = iterable[Symbol.asyncIterator]();
  let finalized = false;
  const finalize = () => {
    if (!finalized) {
      finalized = true;
      callbacks.onFinally?.();
    }
  };
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) {
          finalize();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      callbacks.onCancel?.(reason);
      try {
        await iterator.return?.();
      } finally {
        finalize();
      }
    }
  });
};

const toAISDKSSEStream = (source: AsyncIterable<AISDKUIMessageChunk>): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const iterator = source[Symbol.asyncIterator]();
  let doneSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (!result.done) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(result.value)}\n\n`));
          return;
        }
        if (!doneSent) {
          doneSent = true;
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          return;
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    }
  });
};

export const toAISDKUIMessageStreamResponse = (
  source: ZhivexUIStreamSource,
  init: ResponseInit & AISDKUIStreamOptions = {}
): Response => {
  const { headers, messageId, unknownEvents, formatStreamError, ...responseInit } = init;
  return new Response(
    toAISDKSSEStream(toAISDKUIMessageStream(source, { messageId, unknownEvents, formatStreamError })),
    {
      ...responseInit,
      headers: {
        ...AI_SDK_UI_STREAM_HEADERS,
        ...Object.fromEntries(new Headers(headers).entries())
      }
    }
  );
};

export const toAISDKUIRunnerStreamResponse = (
  source: RunnerStreamResult,
  init: ResponseInit & AISDKUIStreamOptions = {}
): Response => {
  const nativeStream = (async function* (): AsyncIterable<ZhivexUIMessageChunk> {
    let streamError: unknown;
    try {
      yield* toUIMessageStream(source.eventStream, {
        messageId: init.messageId,
        includeAgentRunFinish: false
      });
    } catch (error) {
      streamError = error;
    }
    const result = await source.collect();
    if (streamError !== undefined) {
      throw streamError;
    }
    yield {
      type: "session-finish",
      sessionId: result.session.sessionId,
      status: result.output.status
    };
  })();
  return toAISDKUIMessageStreamResponse(nativeStream, init);
};

const extractApprovals = (message: AISDKUIMessage | undefined) => {
  if (!message || message.role !== "assistant") {
    return [];
  }
  const approvals: AISDKUIChatTransportRequestContext["approvals"] = [];
  for (const rawPart of message.parts) {
    if (!isRecord(rawPart)) {
      continue;
    }
    const part = rawPart as unknown as Record<string, unknown>;
    if (part.state !== "approval-responded" || !isRecord(part.approval)) {
      continue;
    }
    const approval = part.approval;
    const approvalId = approval.id;
    if (!isNonEmptyString(approvalId) || typeof approval.approved !== "boolean") {
      continue;
    }
    const decoded = decodeZhivexApprovalId(approvalId);
    if (!decoded) {
      continue;
    }
    approvals.push({
      ...decoded,
      approve: approval.approved,
      ...(typeof approval.reason === "string" ? { reason: approval.reason } : {})
    });
  }
  return approvals;
};

const toChatMessage = (
  message: AISDKUIMessage,
  options: AISDKUIMessageAdapterOptions
): ChatMessage => {
  const converted = fromAISDKUIMessage(message, options);
  return {
    id: message.id,
    role: converted.role,
    parts: converted.parts,
    createdAt: Date.now(),
    status: "pending"
  };
};

const assertRequestSize = (body: unknown, maxBytes: number): void => {
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch (error) {
    throw new AISDKUICompatibilityError("AI SDK UI request body must be JSON serializable.", {
      code: "invalid_request",
      cause: error
    });
  }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new AISDKUICompatibilityError(`AI SDK UI request exceeded the ${maxBytes} byte limit.`, {
      code: "request_too_large"
    });
  }
};

const mergeHeaders = (base: HeadersInit | undefined, additional: HeadersInit | undefined): Headers => {
  const headers = new Headers(base);
  new Headers(additional).forEach((value, key) => headers.set(key, value));
  return headers;
};

export class ZhivexAISDKChatTransport implements AISDKChatTransport<AISDKUIMessage> {
  private readonly options: AISDKUIChatTransportOptions;

  constructor(options: AISDKUIChatTransportOptions = {}) {
    this.options = options;
  }

  async sendMessages(
    request: Parameters<AISDKChatTransport<AISDKUIMessage>["sendMessages"]>[0]
  ): Promise<ReadableStream<AISDKUIMessageChunk>> {
    if (request.trigger === "regenerate-message" && !this.options.supportsRegenerate) {
      throw new AISDKUICompatibilityError(
        "AI SDK UI regeneration is disabled because a durable Runner could duplicate history.",
        { code: "invalid_request" }
      );
    }
    const maxRequestBytes = positiveSafeInteger(
      "maxRequestBytes",
      this.options.maxRequestBytes,
      DEFAULT_MAX_REQUEST_BYTES
    );
    const latest = request.messages.at(-1);
    const approvals = extractApprovals(latest);
    const message = latest && approvals.length === 0
      ? toChatMessage(latest, this.options)
      : undefined;
    const messageMetadata = latest ? messageMetadataFromAI(latest) : undefined;
    const context: AISDKUIChatTransportRequestContext = {
      chatId: request.chatId,
      trigger: request.trigger,
      messageId: request.messageId,
      messages: request.messages,
      message,
      approvals,
      messageMetadata,
      metadata: request.metadata,
      body: request.body
    };
    const body = this.options.buildRequestBody
      ? await this.options.buildRequestBody(context)
      : {
          message: message
            ? { id: message.id, role: message.role, parts: message.parts }
            : undefined,
          sessionId: request.chatId,
          approvals: approvals.length > 0 ? approvals : undefined,
          metadata: request.metadata !== undefined
            ? jsonValue(request.metadata, "AI SDK UI request metadata")
            : undefined
        };
    assertRequestSize(body, maxRequestBytes);

    const parentController = new AbortController();
    const onAbort = () => parentController.abort(request.abortSignal?.reason);
    if (request.abortSignal?.aborted) {
      onAbort();
    } else {
      request.abortSignal?.addEventListener("abort", onAbort, { once: true });
    }

    const configuredHeaders = typeof this.options.headers === "function"
      ? await this.options.headers(context)
      : this.options.headers;
    const transport = createFetchChatTransport({
      endpoint: this.options.endpoint,
      fetch: this.options.fetch,
      credentials: this.options.credentials,
      redirect: this.options.redirect,
      maxEventChars: this.options.maxEventChars,
      maxBufferChars: this.options.maxBufferChars,
      maxStreamChars: this.options.maxStreamChars,
      maxStreamEvents: this.options.maxStreamEvents,
      maxErrorBodyBytes: this.options.maxErrorBodyBytes,
      requestTimeoutMs: this.options.requestTimeoutMs,
      streamIdleTimeoutMs: this.options.streamIdleTimeoutMs,
      supportsReload: false,
      formatError: this.options.formatError,
      headers: mergeHeaders(configuredHeaders, request.headers),
      buildRequestBody: () => body
    });

    const nativeRequest: ChatTransportRequest = {
      message,
      messages: message ? [message] : [],
      sessionId: request.chatId,
      approvals,
      metadata: request.metadata === undefined
        ? undefined
        : jsonObject(request.metadata, "AI SDK UI request metadata"),
      signal: parentController.signal
    };
    const source = toAISDKUIMessageStream(transport.send(nativeRequest), {
      messageId: this.options.messageId,
      unknownEvents: this.options.unknownEvents,
      formatStreamError: this.options.formatStreamError
    });
    return readableFromAsyncIterable(source, {
      onCancel: (reason) => parentController.abort(reason),
      onFinally: () => request.abortSignal?.removeEventListener("abort", onAbort)
    });
  }

  async reconnectToStream(): Promise<ReadableStream<AISDKUIMessageChunk> | null> {
    return null;
  }
}

export const createAISDKUIChatTransport = (
  options: AISDKUIChatTransportOptions = {}
): AISDKChatTransport<AISDKUIMessage> => new ZhivexAISDKChatTransport(options);

const readRequestText = async (request: Request, maxBytes: number): Promise<string> => {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new AISDKUICompatibilityError(`AI SDK UI request exceeded the ${maxBytes} byte limit.`, {
      code: "request_too_large"
    });
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        chunks.length = 0;
        await reader.cancel().catch(() => undefined);
        throw new AISDKUICompatibilityError(`AI SDK UI request exceeded the ${maxBytes} byte limit.`, {
          code: "request_too_large"
        });
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

export const parseAISDKUIMessageRequest = async (
  request: Request,
  options: ParseAISDKUIMessageRequestOptions = {}
): Promise<ParsedAISDKUIMessageRequest> => {
  const maxBytes = positiveSafeInteger("maxBytes", options.maxBytes, DEFAULT_MAX_REQUEST_BYTES);
  const maxMessages = positiveSafeInteger("maxMessages", options.maxMessages, DEFAULT_MAX_MESSAGES);
  const maxParts = positiveSafeInteger("maxParts", options.maxParts, DEFAULT_MAX_PARTS);
  const maxIdChars = positiveSafeInteger("maxIdChars", options.maxIdChars, DEFAULT_MAX_ID_CHARS);
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new AISDKUICompatibilityError("AI SDK UI requests require Content-Type application/json.", {
      code: "invalid_request"
    });
  }
  const text = await readRequestText(request, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AISDKUICompatibilityError("AI SDK UI request body must contain valid JSON.", {
      code: "invalid_request",
      cause: error
    });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
    throw new AISDKUICompatibilityError("AI SDK UI request body requires a messages array.", {
      code: "invalid_request"
    });
  }
  if (parsed.messages.length > maxMessages) {
    throw new AISDKUICompatibilityError(`AI SDK UI request exceeded the ${maxMessages} message limit.`, {
      code: "request_too_large"
    });
  }
  const messages = parsed.messages.map(validateAIMessage);
  const messageMetadata = messages.flatMap((message) => {
    const metadata = messageMetadataFromAI(message);
    return metadata === undefined ? [] : [{ messageId: message.id, metadata }];
  });
  let partCount = 0;
  for (const message of messages) {
    if (message.id.length > maxIdChars) {
      throw new AISDKUICompatibilityError(`AI SDK UI message ids must not exceed ${maxIdChars} characters.`, {
        code: "invalid_message"
      });
    }
    partCount += message.parts.length;
    if (partCount > maxParts) {
      throw new AISDKUICompatibilityError(`AI SDK UI request exceeded the ${maxParts} part limit.`, {
        code: "request_too_large"
      });
    }
  }
  const chatId = parsed.id;
  const messageId = parsed.messageId;
  const trigger = parsed.trigger;
  if (chatId !== undefined && (!isNonEmptyString(chatId) || chatId.length > maxIdChars)) {
    throw new AISDKUICompatibilityError(`AI SDK UI chat id must contain at most ${maxIdChars} characters.`, {
      code: "invalid_request"
    });
  }
  if (messageId !== undefined && (!isNonEmptyString(messageId) || messageId.length > maxIdChars)) {
    throw new AISDKUICompatibilityError(`AI SDK UI messageId must contain at most ${maxIdChars} characters.`, {
      code: "invalid_request"
    });
  }
  if (trigger !== undefined && trigger !== "submit-message" && trigger !== "regenerate-message") {
    throw new AISDKUICompatibilityError("AI SDK UI trigger is invalid.", {
      code: "invalid_request"
    });
  }
  return {
    chatId,
    messageId,
    trigger,
    messages,
    messageMetadata,
    modelMessages: fromAISDKUIMessages(messages, options)
  };
};

export type {
  AISDKChatTransport,
  AISDKUIMessage,
  AISDKUIMessageChunk,
  ChatTransportErrorFormatter,
  ZhivexUIMessage,
  ZhivexUIMessageChunk
};

export { ChatTransportError } from "./transport.js";
