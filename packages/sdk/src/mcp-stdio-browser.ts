/** Browser stand-in. Importing this entrypoint must not load `node:child_process`. */

export const MCP_STDIO_PROTOCOL_VERSION = "2025-11-25" as const;

export const MCP_STDIO_API_STABILITY_MANIFEST = Object.freeze({
  MCP_STDIO_API_STABILITY_MANIFEST: "experimental",
  MCP_STDIO_PROTOCOL_VERSION: "experimental",
  McpStdioError: "experimental",
  createMcpStdioClient: "experimental"
} as const);

export class McpStdioError extends Error {
  readonly name = "McpStdioError";

  constructor(readonly code: "INDETERMINATE" | "LIMIT_EXCEEDED" | "PROCESS_EXITED" | "PROTOCOL_ERROR" | "UNSUPPORTED_CAPABILITY", message: string) {
    super(message);
  }
}

export const createMcpStdioClient = (): never => {
  throw new McpStdioError("PROTOCOL_ERROR", "MCP stdio transport is available only on Node.js and Bun.");
};
