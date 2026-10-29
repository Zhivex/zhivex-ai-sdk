import { ParseError, ValidationError } from "@zhivex-ai/core/provider";

import type { AppleSchemaNode } from "./schema.js";

/** Newline-delimited JSON spoken by the reference Swift helper. */
export const APPLE_LOCAL_PROTOCOL_VERSION = 1;

export const APPLE_LOCAL_USE_CASES = ["general", "contentTagging"] as const;
export type AppleLocalUseCase = (typeof APPLE_LOCAL_USE_CASES)[number];

export const APPLE_LOCAL_UNAVAILABLE_REASONS = [
  "appleIntelligenceNotEnabled",
  "deviceNotEligible",
  "modelNotReady",
  "unknown"
] as const;
export type AppleLocalUnavailableReason = (typeof APPLE_LOCAL_UNAVAILABLE_REASONS)[number];

export interface AppleLocalImage {
  mediaType: string;
  /** Raw base64, without a data-URL prefix. */
  data: string;
}

export interface AppleLocalPrompt {
  text: string;
  images?: AppleLocalImage[];
}

export interface AppleLocalToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AppleLocalTranscriptEntry =
  | { type: "prompt"; id: string; text: string }
  | { type: "response"; id: string; text: string }
  | { type: "toolCalls"; id: string; calls: AppleLocalToolCall[] }
  | { type: "toolOutput"; id: string; name: string; output: string };

export interface AppleLocalToolSpec {
  name: string;
  description: string;
  parameters: AppleSchemaNode;
}

export type AppleLocalSampling =
  | { mode: "greedy" }
  | { mode: "random"; probabilityThreshold: number; seed?: number }
  | { mode: "top"; top: number; seed?: number };

export type AppleLocalToolCallingMode = "allowed" | "required" | "disallowed";

export interface AppleLocalGenerateParams {
  modelId: string;
  useCase: AppleLocalUseCase;
  guardrails?: "permissiveContentTransformations";
  locale?: string;
  instructions?: string;
  transcript: AppleLocalTranscriptEntry[];
  prompt: AppleLocalPrompt;
  /** True when the SDK turn has no new user text and the transcript already ends in tool output. */
  continuation?: boolean;
  tools?: AppleLocalToolSpec[];
  toolCallingMode?: AppleLocalToolCallingMode;
  temperature?: number;
  maximumResponseTokens?: number;
  sampling?: AppleLocalSampling;
  responseSchema?: AppleSchemaNode;
  includeSchemaInPrompt?: boolean;
}

export interface AppleLocalStatusParams {
  useCase: AppleLocalUseCase;
  locale?: string;
}

export interface AppleLocalRequest {
  protocol: typeof APPLE_LOCAL_PROTOCOL_VERSION;
  id: string;
  method: "status" | "generate" | "stream";
  params: AppleLocalStatusParams | AppleLocalGenerateParams;
}

export interface AppleLocalAvailability {
  available: boolean;
  reason?: AppleLocalUnavailableReason;
  /** Live `SystemLanguageModel.contextSize`, in tokens, when the model can report it. */
  contextSize?: number;
  supportedLanguages?: string[];
  /** True only when the bridge can attach images. The OS 27 on-device model documents this. */
  imageInput: boolean;
  localeSupported?: boolean;
  useCase: AppleLocalUseCase;
}

export interface AppleLocalUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface AppleLocalResult {
  text?: string;
  finishReason: "stop" | "length" | "tool-calls";
  toolCalls?: AppleLocalToolCall[];
  usage?: AppleLocalUsage;
}

export type AppleLocalEvent =
  | { type: "text-delta"; textDelta: string }
  | { type: "tool-call"; toolCall: AppleLocalToolCall };

export const APPLE_LOCAL_ERROR_CODES = [
  "appleIntelligenceNotEnabled",
  "deviceNotEligible",
  "modelNotReady",
  "unknown",
  "contextSizeExceeded",
  "rateLimited",
  "refusal",
  "guardrailViolation",
  "unsupportedCapability",
  "unsupportedLanguageOrLocale",
  "unsupportedTranscriptContent",
  "unsupportedGenerationGuide",
  "timeout",
  "assetsUnavailable",
  "concurrentRequests",
  "decodingFailure",
  "bridge",
  "protocol"
] as const;
export type AppleLocalErrorCode = (typeof APPLE_LOCAL_ERROR_CODES)[number];

export interface AppleLocalBridgeError {
  code: AppleLocalErrorCode;
  message: string;
  retryAt?: string;
}

export type AppleLocalServerMessage =
  | { id: string; event: AppleLocalEvent }
  | { id: string; result: AppleLocalAvailability | AppleLocalResult }
  | { id: string; error: AppleLocalBridgeError };

export interface AppleLocalTransport {
  send(
    request: AppleLocalRequest,
    options?: { signal?: AbortSignal }
  ): AsyncIterable<AppleLocalServerMessage>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const encodeBridgeMessage = (message: unknown): string => {
  const encoded = JSON.stringify(message);
  if (encoded.includes("\n") || encoded.includes("\r")) {
    throw new ValidationError("Apple Local bridge messages must encode as a single line.");
  }
  return encoded;
};

export const parseBridgeMessage = (line: string): AppleLocalServerMessage => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new ParseError("Apple Local bridge sent a line that is not JSON.", { cause: error });
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new ParseError("Apple Local bridge messages require a string id.");
  }
  const kinds = ["event", "result", "error"].filter((key) => key in parsed);
  if (kinds.length !== 1) {
    throw new ParseError("Apple Local bridge messages require exactly one of event, result, or error.");
  }
  if ("error" in parsed) {
    if (!isRecord(parsed.error) || typeof parsed.error.code !== "string" || typeof parsed.error.message !== "string") {
      throw new ParseError("Apple Local bridge error is missing a code or message.");
    }
    if (!APPLE_LOCAL_ERROR_CODES.includes(parsed.error.code as AppleLocalErrorCode)) {
      throw new ParseError(`Apple Local bridge returned an unknown error code "${String(parsed.error.code)}".`);
    }
    if (parsed.error.retryAt !== undefined && typeof parsed.error.retryAt !== "string") {
      throw new ParseError("Apple Local bridge error retryAt must be a string when present.");
    }
    return {
      id: parsed.id,
      error: {
        code: parsed.error.code as AppleLocalErrorCode,
        message: parsed.error.message,
        ...(typeof parsed.error.retryAt === "string" ? { retryAt: parsed.error.retryAt } : {})
      }
    };
  }
  if ("event" in parsed) {
    if (!isRecord(parsed.event) || (parsed.event.type !== "text-delta" && parsed.event.type !== "tool-call")) {
      throw new ParseError("Apple Local bridge event type is not text-delta or tool-call.");
    }
    return { id: parsed.id, event: parsed.event as unknown as AppleLocalEvent };
  }
  if (!isRecord(parsed.result)) {
    throw new ParseError("Apple Local bridge result must be an object.");
  }
  return { id: parsed.id, result: parsed.result as unknown as AppleLocalAvailability | AppleLocalResult };
};
