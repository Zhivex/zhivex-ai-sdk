import {
  ProviderHTTPError,
  ProviderToolCallError,
  streamSSE,
  type FinishReason,
  type JsonValue,
  type ModelMessage,
  type ProviderToolCallErrorReason,
  type StreamEvent,
  type TokenUsage,
  type ToolCall
} from "@zhivex-ai/core/provider";

const MAX_PENDING_CALLS = 128;
const MAX_PENDING_CHARS = 1024 * 1024;
// GenerateContent Part.data is a union; thought signatures remain independent metadata.
const otherPartDataFields = ["text", "inlineData", "fileData", "functionResponse", "executableCode", "codeExecutionResult"];
const blockedReasons = new Set([
  "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT", "MODEL_ARMOR"
]);

const toolError = (diagnosticCode: string, reason: ProviderToolCallErrorReason, usage?: TokenUsage) =>
  new ProviderToolCallError({ provider: "vertex", transport: "generate-content", diagnosticCode, reason, usage });

const validIdentifier = (value: unknown, maxChars: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxChars &&
  value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

const validArguments = (value: unknown): value is Record<string, JsonValue> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number" && Number.isFinite(item)) continue;
    if (typeof item !== "object" || !item) return false;
    for (const child of Object.values(item)) pending.push(child);
  }
  return true;
};

const finishReason = (reason: string): FinishReason => {
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  if (blockedReasons.has(reason)) return "content-filter";
  if (reason === "MALFORMED_FUNCTION_CALL" || reason === "UNEXPECTED_TOOL_CALL") return "error";
  return "unknown";
};

class VertexToolBuffer {
  private readonly pending: Array<{ call: Record<string, unknown>; thoughtSignature?: string }> = [];
  private pendingChars = 0;

  add(part: Record<string, any>, usage?: TokenUsage) {
    if (Object.hasOwn(part, "functionCall")) {
      const call = part.functionCall;
      if (otherPartDataFields.some((field) => Object.hasOwn(part, field)) ||
          !call || typeof call !== "object" || Array.isArray(call) ||
          !validIdentifier(call.name, 256) || (call.id !== undefined && !validIdentifier(call.id, 1024)) ||
          (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== "string") ||
          !validArguments(call.args === undefined ? {} : call.args)) {
        throw toolError("VERTEX_STREAM_TOOL_CALL_INVALID", "inconsistent_metadata", usage);
      }
      try {
        this.pendingChars += JSON.stringify({ call, thoughtSignature: part.thoughtSignature }).length;
      } catch {
        throw toolError("VERTEX_STREAM_TOOL_ARGUMENTS_TOO_LARGE", "arguments_too_large", usage);
      }
      if (this.pending.length >= MAX_PENDING_CALLS || this.pendingChars > MAX_PENDING_CHARS) {
        throw toolError("VERTEX_STREAM_TOOL_ARGUMENTS_TOO_LARGE", "arguments_too_large", usage);
      }
      this.pending.push({ call, thoughtSignature: part.thoughtSignature });
    }
  }

  complete(terminalReason: string | undefined, messages: ModelMessage[], usage?: TokenUsage) {
    const historyIds = new Set<string>();
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === "tool-call") historyIds.add(part.toolCall.id);
        if (part.type === "tool-result") historyIds.add(part.toolResult.toolCallId);
      }
    }
    if (terminalReason === "MALFORMED_FUNCTION_CALL" || terminalReason === "UNEXPECTED_TOOL_CALL") {
      throw toolError("VERTEX_STREAM_TOOL_RESPONSE_FAILED", "response_failed", usage);
    }
    if (typeof terminalReason !== "string" || !terminalReason) {
      throw toolError("VERTEX_STREAM_TOOL_TRUNCATED", "stream_truncated", usage);
    }
    if (this.pending.length && terminalReason !== "STOP") {
      throw toolError("VERTEX_STREAM_TOOL_RESPONSE_INCOMPLETE", "response_incomplete", usage);
    }

    // Reserve all provider IDs before assigning fallbacks, including IDs in later chunks.
    const usedIds = new Set(historyIds);
    for (const { call } of this.pending) {
      if (typeof call.id !== "string") continue;
      if (usedIds.has(call.id)) throw toolError("VERTEX_STREAM_TOOL_CALL_INVALID", "inconsistent_metadata", usage);
      usedIds.add(call.id);
    }
    let nextId = 0;
    const calls: ToolCall[] = this.pending.map(({ call, thoughtSignature }) => {
      let id = call.id as string | undefined;
      if (id === undefined) {
        do { id = `vertex-call-${nextId++}`; } while (usedIds.has(id));
        usedIds.add(id);
      }
      return {
        id,
        name: call.name as string,
        input: (call.args ?? {}) as JsonValue,
        ...(thoughtSignature !== undefined ? { providerMetadata: { geminiThoughtSignature: thoughtSignature } } : {})
      };
    });
    return { calls, finishReason: calls.length ? "tool-calls" as const : finishReason(terminalReason), providerFinishReason: terminalReason };
  }
}

/** Validate the same terminal tool contract for a non-streaming GenerateContent response. */
export const validateVertexGenerateContent = (candidate: any, messages: ModelMessage[], usage?: TokenUsage, promptBlock?: string) => {
  const buffer = new VertexToolBuffer();
  const parts = candidate?.content?.parts ?? [];
  if (!Array.isArray(parts)) throw toolError("VERTEX_STREAM_TOOL_CALL_INVALID", "inconsistent_metadata", usage);
  for (const part of parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw toolError("VERTEX_STREAM_TOOL_CALL_INVALID", "inconsistent_metadata", usage);
    buffer.add(part, usage);
  }
  const reason = promptBlock && promptBlock !== "BLOCK_REASON_UNSPECIFIED"
    ? blockedReasons.has(promptBlock) ? promptBlock : "SAFETY"
    : candidate?.finishReason;
  return buffer.complete(reason, messages, usage);
};

/** Keep function calls non-executable until the complete response establishes a safe STOP. */
export async function* streamVertexGenerateContent(
  response: Response,
  messages: ModelMessage[],
  normalizeUsage: (value: unknown) => TokenUsage | undefined,
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  const buffer = new VertexToolBuffer();
  let terminalReason: string | undefined;
  let usage: TokenUsage | undefined;
  let protocolFailure = false;

  try {
    for await (const event of streamSSE(response)) {
      if (event.data === "[DONE]") break;
      let json: any;
      try { json = JSON.parse(event.data); }
      catch { throw toolError("VERTEX_STREAM_TOOL_RESPONSE_FAILED", "response_failed", usage); }
      if (!json || typeof json !== "object" || Array.isArray(json) || json.error) {
        throw toolError("VERTEX_STREAM_TOOL_RESPONSE_FAILED", "response_failed", usage);
      }
      const wireUsage = json.usageMetadata ?? json.usage_metadata;
      if (wireUsage !== undefined) usage = normalizeUsage(wireUsage) ?? usage;
      const candidates = json.candidates;
      if (candidates !== undefined && !Array.isArray(candidates)) {
        throw toolError("VERTEX_STREAM_TOOL_RESPONSE_FAILED", "response_failed", usage);
      }
      const candidate = candidates?.find((item: any) => item?.index === 0) ?? candidates?.find((item: any) => item?.index === undefined);
      const parts = candidate?.content?.parts ?? [];
      if (!Array.isArray(parts)) throw toolError("VERTEX_STREAM_TOOL_CALL_INVALID", "inconsistent_metadata", usage);
      // A subsequent terminal message may repeat metadata, but may not add content.
      if (terminalReason && parts.length) protocolFailure = true;
      for (const part of terminalReason ? [] : parts) {
        if (!part || typeof part !== "object" || Array.isArray(part)) {
          throw toolError("VERTEX_STREAM_TOOL_CALL_INVALID", "inconsistent_metadata", usage);
        }
        buffer.add(part, usage);
        if (typeof part.text === "string" && part.text) yield { type: "text-delta", textDelta: part.text };
      }
      const nextReason = candidate?.finishReason;
      if (nextReason !== undefined) {
        if (typeof nextReason !== "string" || !nextReason) protocolFailure = true;
        else {
          if (terminalReason && terminalReason !== nextReason) protocolFailure = true;
          terminalReason = nextReason;
        }
      }
      const promptBlock = json.promptFeedback?.blockReason;
      if (promptBlock && promptBlock !== "BLOCK_REASON_UNSPECIFIED") {
        terminalReason = blockedReasons.has(promptBlock) ? promptBlock : "SAFETY";
      }
    }

    if (protocolFailure || terminalReason === "MALFORMED_FUNCTION_CALL" || terminalReason === "UNEXPECTED_TOOL_CALL") {
      throw toolError("VERTEX_STREAM_TOOL_RESPONSE_FAILED", "response_failed", usage);
    }
    const { calls, finishReason: normalizedReason } = buffer.complete(terminalReason, messages, usage);
    for (const toolCall of calls) yield { type: "tool-call", toolCall };
    yield { type: "finish", finishReason: normalizedReason, providerFinishReason: terminalReason, usage };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ProviderToolCallError || error instanceof ProviderHTTPError) throw error;
    throw toolError("VERTEX_STREAM_TOOL_TRUNCATED", "stream_truncated", usage);
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}
