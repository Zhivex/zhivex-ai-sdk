export class SandboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxError";
    this.code = code;
  }
}
