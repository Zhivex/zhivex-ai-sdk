import { z } from "zod";

import { serializeJsonValue, tool } from "./messages.js";
import { createToolRegistry, type ToolRegistry } from "./tool-registry.js";
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

type JsonSchemaObject = {
  type?: JsonValue;
  properties?: JsonValue;
  required?: JsonValue;
  additionalProperties?: JsonValue;
  items?: JsonValue;
  enum?: JsonValue;
  const?: JsonValue;
  anyOf?: JsonValue;
  oneOf?: JsonValue;
  description?: JsonValue;
  minimum?: JsonValue;
  maximum?: JsonValue;
  minLength?: JsonValue;
  maxLength?: JsonValue;
  minItems?: JsonValue;
  maxItems?: JsonValue;
  default?: JsonValue;
};

const isRecord = (value: JsonValue | undefined): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toZodLiteral = (value: JsonValue) => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return z.literal(value);
  }

  return z.unknown();
};

const toZodUnion = (schemas: JsonValue[] | undefined): z.ZodTypeAny => {
  if (!schemas?.length) {
    return z.unknown();
  }

  const parsed = schemas.map((schema) => jsonSchemaToZod(schema));
  if (parsed.length === 1) {
    return parsed[0];
  }

  return z.union(parsed as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
};

const applyCommonConstraints = (schema: z.ZodTypeAny, jsonSchema: JsonSchemaObject): z.ZodTypeAny => {
  if (schema instanceof z.ZodString) {
    let next = schema;
    if (typeof jsonSchema.minLength === "number") {
      next = next.min(jsonSchema.minLength);
    }
    if (typeof jsonSchema.maxLength === "number") {
      next = next.max(jsonSchema.maxLength);
    }
    return next.describe(typeof jsonSchema.description === "string" ? jsonSchema.description : "");
  }

  if (schema instanceof z.ZodNumber) {
    let next = schema;
    if (typeof jsonSchema.minimum === "number") {
      next = next.gte(jsonSchema.minimum);
    }
    if (typeof jsonSchema.maximum === "number") {
      next = next.lte(jsonSchema.maximum);
    }
    return next.describe(typeof jsonSchema.description === "string" ? jsonSchema.description : "");
  }

  if (schema instanceof z.ZodArray) {
    let next = schema;
    if (typeof jsonSchema.minItems === "number") {
      next = next.min(jsonSchema.minItems);
    }
    if (typeof jsonSchema.maxItems === "number") {
      next = next.max(jsonSchema.maxItems);
    }
    return next.describe(typeof jsonSchema.description === "string" ? jsonSchema.description : "");
  }

  return typeof jsonSchema.description === "string" ? schema.describe(jsonSchema.description) : schema;
};

const jsonSchemaToZod = (schema: JsonValue | undefined): z.ZodTypeAny => {
  if (!schema) {
    return z.unknown();
  }

  if (!isRecord(schema)) {
    return z.unknown();
  }

  const jsonSchema = schema as JsonSchemaObject;

  if (jsonSchema.const !== undefined) {
    return toZodLiteral(jsonSchema.const);
  }

  if (Array.isArray(jsonSchema.enum) && jsonSchema.enum.length > 0) {
    return toZodUnion(jsonSchema.enum);
  }

  if (Array.isArray(jsonSchema.oneOf)) {
    return toZodUnion(jsonSchema.oneOf);
  }

  if (Array.isArray(jsonSchema.anyOf)) {
    return toZodUnion(jsonSchema.anyOf);
  }

  if (Array.isArray(jsonSchema.type)) {
    return toZodUnion(
      jsonSchema.type.map((type) => ({
        ...jsonSchema,
        type
      }))
    );
  }

  switch (jsonSchema.type) {
    case "string":
      return applyCommonConstraints(z.string(), jsonSchema);
    case "number":
      return applyCommonConstraints(z.number(), jsonSchema);
    case "integer":
      return applyCommonConstraints(z.number().int(), jsonSchema);
    case "boolean":
      return applyCommonConstraints(z.boolean(), jsonSchema);
    case "null":
      return z.null();
    case "array":
      return applyCommonConstraints(z.array(jsonSchemaToZod(jsonSchema.items)), jsonSchema);
    case "object": {
      const properties = isRecord(jsonSchema.properties) ? jsonSchema.properties : {};
      const required = Array.isArray(jsonSchema.required)
        ? new Set(jsonSchema.required.filter((value): value is string => typeof value === "string"))
        : new Set<string>();

      const shape = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => {
          const propertySchema = jsonSchemaToZod(value);
          return [key, required.has(key) ? propertySchema : propertySchema.optional()];
        })
      );

      let objectSchema = z.object(shape);
      if (jsonSchema.additionalProperties === true) {
        objectSchema = objectSchema.passthrough();
      } else if (jsonSchema.additionalProperties === false) {
        objectSchema = objectSchema.strict();
      } else if (isRecord(jsonSchema.additionalProperties)) {
        objectSchema = objectSchema.catchall(jsonSchemaToZod(jsonSchema.additionalProperties));
      } else {
        objectSchema = objectSchema.passthrough();
      }

      return applyCommonConstraints(objectSchema, jsonSchema);
    }
    default:
      return z.unknown();
  }
};

const normalizeListedTools = async (client: McpClient): Promise<McpListedTool[]> => {
  const listed = await client.listTools();
  return Array.isArray(listed) ? listed : listed.tools;
};

const getToolName = (name: string, prefix?: string) => (prefix ? `${prefix}${name}` : name);

const mcpToolSecurityMetadata = (annotations: McpToolAnnotations | undefined) => {
  const explicitlyReadOnly = annotations?.readOnlyHint === true;
  const destructive = annotations?.destructiveHint === true;
  const openWorld = annotations?.openWorldHint === true;
  const requiresApproval = !explicitlyReadOnly || destructive || openWorld;
  const permissions = [
    explicitlyReadOnly ? "read" : "external-side-effect",
    ...(destructive ? ["write"] : []),
    ...(openWorld ? ["network"] : [])
  ];

  return {
    requiresApproval,
    advancedRegistry: {
      source: "mcp",
      permissions,
      audit: {
        riskLevel: destructive ? "high" : requiresApproval ? "medium" : "low",
        description: explicitlyReadOnly
          ? "MCP server declares this tool read-only."
          : "MCP tool requires approval because it is not explicitly read-only."
      }
    }
  };
};

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
      const security = mcpToolSecurityMetadata(listedTool.annotations);
      if (seenNames.has(toolName)) {
        throw new Error(`Duplicate MCP tool name "${toolName}".`);
      }

      seenNames.add(toolName);

      return [
        toolName,
        tool({
          name: toolName,
          description: listedTool.description,
          schema: jsonSchemaToZod(listedTool.inputSchema),
          metadata: serializeJsonValue({
            source: "mcp",
            originalName: listedTool.name,
            inputSchema: listedTool.inputSchema ?? null,
            annotations: listedTool.annotations ?? null,
            advancedRegistry: security.advancedRegistry
          }) as Record<string, JsonValue>,
          requiresApproval: security.requiresApproval,
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

export const createMcpToolRegistry = async (
  client: McpClient,
  options: McpToolSetOptions = {}
): Promise<ToolRegistry> => createToolRegistry(await createMcpToolSet(client, options));
