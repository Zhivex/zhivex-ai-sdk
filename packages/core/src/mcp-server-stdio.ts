import { Readable, Writable } from "node:stream";

import { createMcpStdioServer, McpServerError, type McpServer } from "./mcp-server.js";

/** Experimental exports of the Node/Bun stdio server entrypoint. */
export const MCP_SERVER_STDIO_API_STABILITY_MANIFEST = Object.freeze({
  MCP_SERVER_STDIO_API_STABILITY_MANIFEST: "experimental",
  McpServerError: "experimental",
  serveMcpStdio: "experimental"
} as const);

export { McpServerError };

export interface ServeMcpStdioOptions {
  /** Defaults to `process.stdin`. */
  input?: Readable;
  /** Defaults to `process.stdout`. Logging belongs on stderr. */
  output?: Writable;
  maxMessageBytes?: number;
}

/**
 * Serves one MCP session on newline-delimited JSON-RPC.
 * Browser bundles resolve a stub that throws instead of touching stdio.
 */
export function serveMcpStdio(server: McpServer, options: ServeMcpStdioOptions = {}) {
  const input = Readable.toWeb(options.input ?? process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(options.output ?? process.stdout) as WritableStream<Uint8Array>;
  return createMcpStdioServer({
    server,
    input,
    output,
    maxMessageBytes: options.maxMessageBytes
  });
}
