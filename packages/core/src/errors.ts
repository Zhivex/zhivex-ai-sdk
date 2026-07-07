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
    options?: { cause?: unknown; responseBody?: unknown; responseBodyMaxChars?: number }
  ) {
    super(message, options);
    this.responseBody = sanitizeProviderResponseBody(options?.responseBody, options?.responseBodyMaxChars);
  }

  readonly responseBody?: unknown;
}

export class ValidationError extends ZhivexAIError {}
export class ConflictError extends ZhivexAIError {}
export class ParseError extends ZhivexAIError {}
export class UnsupportedFeatureError extends ZhivexAIError {}

export class GuardrailTriggeredError extends ZhivexAIError {
  constructor(
    readonly stage: "input" | "output",
    message: string,
    options?: { cause?: unknown; metadata?: unknown }
  ) {
    super(message, options);
    this.metadata = options?.metadata;
  }

  readonly metadata?: unknown;
}
