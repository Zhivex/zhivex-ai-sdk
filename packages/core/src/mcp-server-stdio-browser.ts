/** Browser stand-in. Importing this entrypoint must not load Node stdio. */

export const MCP_SERVER_STDIO_API_STABILITY_MANIFEST = Object.freeze({
  MCP_SERVER_STDIO_API_STABILITY_MANIFEST: "experimental",
  McpServerError: "experimental",
  serveMcpStdio: "experimental"
} as const);

export class McpServerError extends Error {
  readonly name = "McpServerError";

  constructor(readonly code: "APPROVAL_REQUIRED" | "AUTH_REJECTED" | "AUTH_REQUIRED" | "LIMIT_EXCEEDED" | "PROTOCOL_ERROR" | "TIMEOUT" | "UNSUPPORTED_RUNTIME", message: string) {
    super(message);
  }
}

export const serveMcpStdio = (): never => {
  throw new McpServerError("UNSUPPORTED_RUNTIME", "MCP stdio server is available only on Node.js and Bun.");
};
