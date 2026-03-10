export class ZhivexAIError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    this.cause = options?.cause;
  }
}

export class ConfigurationError extends ZhivexAIError {}
export class ProviderHTTPError extends ZhivexAIError {
  constructor(
    message: string,
    readonly status: number,
    options?: { cause?: unknown; responseBody?: unknown }
  ) {
    super(message, options);
    this.responseBody = options?.responseBody;
  }

  readonly responseBody?: unknown;
}

export class ValidationError extends ZhivexAIError {}
export class ParseError extends ZhivexAIError {}
export class UnsupportedFeatureError extends ZhivexAIError {}
