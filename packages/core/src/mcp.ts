import { z } from "zod";

import { serializeJsonValue, tool } from "./messages.js";
import type { JsonValue, ToolSet } from "./types.js";

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface McpListedTool {
  name: string;
  description?: string;
  inputSchema?: JsonValue;
  annotations?: McpToolAnnotations;
}

export interface McpListToolsResponse {
  tools: McpListedTool[];
}

export interface McpCallToolRequest {
  name: string;
  arguments?: JsonValue;
}

export interface McpCallToolResponse {
  content?: JsonValue;
  structuredContent?: JsonValue;
  isError?: boolean;
  [key: string]: JsonValue | undefined;
}

export interface McpClient {
  listTools(): Promise<McpListToolsResponse | McpListedTool[]>;
  callTool(input: McpCallToolRequest): Promise<JsonValue | McpCallToolResponse>;
}

export interface McpToolSetOptions {
  toolNamePrefix?: string;
  includeTools?: string[];
  excludeTools?: string[];
}

const normalizeListedTools = async (client: McpClient): Promise<McpListedTool[]> => {
  const listed = await client.listTools();
  return Array.isArray(listed) ? listed : listed.tools;
};

const getToolName = (name: string, prefix?: string) => (prefix ? `${prefix}${name}` : name);

export const createMcpToolSet = async (client: McpClient, options: McpToolSetOptions = {}): Promise<ToolSet> => {
  const include = options.includeTools ? new Set(options.includeTools) : undefined;
  const exclude = options.excludeTools ? new Set(options.excludeTools) : undefined;
  const listedTools = await normalizeListedTools(client);
  const toolEntries = listedTools.filter((listedTool) => {
    if (include && !include.has(listedTool.name)) {
      return false;
    }

    if (exclude?.has(listedTool.name)) {
      return false;
    }

    return true;
  });

  const seenNames = new Set<string>();

  return Object.fromEntries(
    toolEntries.map((listedTool) => {
      const toolName = getToolName(listedTool.name, options.toolNamePrefix);
      if (seenNames.has(toolName)) {
        throw new Error(`Duplicate MCP tool name "${toolName}".`);
      }

      seenNames.add(toolName);

      return [
        toolName,
        tool({
          name: toolName,
          description: listedTool.description,
          schema: z.any(),
          execute: async (input) =>
            serializeJsonValue(
              await client.callTool({
                name: listedTool.name,
                arguments: input as JsonValue
              })
            )
        })
      ];
    })
  );
};
