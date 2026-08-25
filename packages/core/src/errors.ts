import type { ProviderToolCallErrorReason } from "./types.js";

export class ZhivexAIError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    this.cause = options?.cause;
  }
}

export class ConfigurationError extends ZhivexAIError {}

const DEFAULT_PROVIDER_RESPONSE_BODY_MAX_CHARS = 64 * 1024;

const truncateResponseBody = (body: string, maxChars: number) => {
  if (body.length <= maxChars) {
    return body;
  }

  const omittedChars = body.length - maxChars;
  return `${body.slice(0, maxChars)}\n...[truncated ${omittedChars} characters]`;
};

const sanitizeProviderResponseBody = (responseBody: unknown, maxChars = DEFAULT_PROVIDER_RESPONSE_BODY_MAX_CHARS) => {
  if (typeof responseBody !== "string") {
    return responseBody;
  }

  const normalizedMaxChars = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : DEFAULT_PROVIDER_RESPONSE_BODY_MAX_CHARS;
  return truncateResponseBody(responseBody, normalizedMaxChars);
};

export class ProviderHTTPError extends ZhivexAIError {
  constructor(
    message: string,
    readonly status: number,
    options?: { cause?: unknown; responseBody?: unknown; responseBodyMaxChars?: number; retryAfterMs?: number }
  ) {
    super(message, options);
    this.responseBody = sanitizeProviderResponseBody(options?.responseBody, options?.responseBodyMaxChars);
    this.retryAfterMs = options?.retryAfterMs;
  }

  readonly responseBody?: unknown;
  readonly retryAfterMs?: number;
}

export class ProviderResponseTooLargeError extends ZhivexAIError {
  readonly maxBytes: number;
  readonly receivedBytes: number;
  readonly contentLength?: number;
  readonly provider?: string;
  readonly endpoint?: string;

  constructor(options: {
    maxBytes: number;
    receivedBytes: number;
    contentLength?: number;
    provider?: string;
    endpoint?: string;
    cause?: unknown;
  }) {
    const source = [options.provider, options.endpoint].filter(Boolean).join(" ");
    super(
      `${source ? `${source} response` : "Provider response"} exceeded the ${options.maxBytes}-byte limit after receiving ${options.receivedBytes} bytes.`,
      { cause: options.cause }
    );
    this.maxBytes = options.maxBytes;
    this.receivedBytes = options.receivedBytes;
    this.contentLength = options.contentLength;
    this.provider = options.provider;
    this.endpoint = options.endpoint;
  }
}

/**
 * Sanitized provider failure raised before an unsafe tool call can cross into
 * approval, guardrail, or execution policy.
 *
 * The message is intentionally fixed. Provider payloads, raw arguments, tool
 * names, prompts, and response bodies must not be attached to this error.
 */
export class ProviderToolCallError extends ZhivexAIError {
  readonly category = "provider-tool-call" as const;
  readonly provider: string;
  readonly transport?: string;
  readonly diagnosticCode: string;
  readonly reason: ProviderToolCallErrorReason;
  readonly retryable: boolean;
  readonly effectsPossible: boolean;

  constructor(options: {
    provider: string;
    transport?: string;
    diagnosticCode: string;
    reason: ProviderToolCallErrorReason;
    retryable?: boolean;
    effectsPossible?: boolean;
    cause?: unknown;
  }) {
    super("Provider tool call could not be materialized safely.", { cause: options.cause });
    this.provider = options.provider;
    this.transport = options.transport;
    this.diagnosticCode = options.diagnosticCode;
    this.reason = options.reason;
    this.effectsPossible = options.effectsPossible ?? false;
    this.retryable = this.effectsPossible ? false : (options.retryable ?? false);
  }
}

export class ValidationError extends ZhivexAIError {}
export class ConflictError extends ZhivexAIError {}
export class ParseError extends ZhivexAIError {}
export class UnsupportedFeatureError extends ZhivexAIError {}

export class GuardrailTriggeredError extends ZhivexAIError {
  constructor(
    readonly stage: "input" | "output" | "tool-input" | "tool-output",
    message: string,
    options?: { cause?: unknown; metadata?: unknown }
  ) {
    super(message, options);
    this.metadata = options?.metadata;
  }

  readonly metadata?: unknown;
}
