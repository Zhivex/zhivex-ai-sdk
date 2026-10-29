import { ZhivexAIError } from "@zhivex-ai/core";

import type { AppleLocalErrorCode } from "./protocol.js";

export class AppleLocalError extends ZhivexAIError {
  readonly code: AppleLocalErrorCode;
  readonly retryAt?: string;

  constructor(message: string, code: AppleLocalErrorCode, options?: { cause?: unknown; retryAt?: string }) {
    super(message, options);
    this.code = code;
    this.retryAt = options?.retryAt;
  }
}
