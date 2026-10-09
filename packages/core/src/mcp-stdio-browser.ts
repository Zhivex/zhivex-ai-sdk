/** Browser stand-in. The stdio transport spawns a process and is not part of browser bundles. */

export const MCP_STDIO_PROTOCOL_VERSION = "2025-11-25" as const;

export const MCP_STDIO_API_STABILITY_MANIFEST = Object.freeze({
  MCP_STDIO_API_STABILITY_MANIFEST: "experimental",
  MCP_STDIO_PROTOCOL_VERSION: "experimental",
  McpStdioError: "experimental",
  createMcpStdioClient: "experimental"
} as const);

export type McpStdioErrorCode =
  | "INDETERMINATE"
  | "LIMIT_EXCEEDED"
  | "PROCESS_EXITED"
  | "PROTOCOL_ERROR"
  | "UNSUPPORTED_CAPABILITY";

export class McpStdioError extends Error {
  readonly name = "McpStdioError";

  constructor(readonly code: McpStdioErrorCode, message: string) {
    super(message);
  }
}

export const createMcpStdioClient = (): never => {
  throw new McpStdioError("PROTOCOL_ERROR", "MCP stdio transport is available only on Node.js and Bun.");
};
