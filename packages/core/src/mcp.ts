import { z } from "zod";

import { ValidationError } from "./errors.js";
import { serializeJsonValue, tool } from "./messages.js";
import { createToolRegistry, type ToolRegistry } from "./tool-registry.js";
import type { JsonValue, ToolApprovalMode, ToolSet } from "./types.js";

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface McpListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
  annotations?: McpToolAnnotations;
}

export interface McpListToolsRequest {
  cursor?: string;
}

export interface McpListToolsResponse {
  tools: McpListedTool[];
  nextCursor?: string;
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

export interface McpCallToolOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface McpClient {
  listTools(input?: McpListToolsRequest, options?: McpCallToolOptions): Promise<McpListToolsResponse | McpListedTool[]>;
  callTool(input: McpCallToolRequest, options?: McpCallToolOptions): Promise<JsonValue | McpCallToolResponse>;
}

export interface McpToolSetOptions {
  toolNamePrefix?: string;
  includeTools?: string[];
  excludeTools?: string[];
  /** Server annotations are untrusted by default and cannot reduce supervision. */
  trustServerToolAnnotations?: boolean;
  maxListPages?: number;
  maxListedTools?: number;
  listToolsTimeoutMs?: number;
  callToolTimeoutMs?: number;
  abortSignal?: AbortSignal;
  approvalMode?: ToolApprovalMode;
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

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mcpErrorMessage = (toolName: string, response: Record<string, JsonValue>): string => {
  const textPart = Array.isArray(response.content)
    ? response.content.find(
        (entry): entry is Record<string, JsonValue> =>
          isRecord(entry) &&
          entry.type === "text" &&
          typeof entry.text === "string"
      )
    : undefined;
  const detail = typeof textPart?.text === "string" ? textPart.text.slice(0, 1_000) : undefined;
  return detail
    ? `MCP tool "${toolName}" returned an error: ${detail}`
    : `MCP tool "${toolName}" returned an error response.`;
};

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

const positiveSafeInteger = (value: number | undefined, fallback: number, fieldName: string): number => {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new ValidationError(`The "${fieldName}" option must be a positive safe integer.`);
  }
  return normalized;
};

const optionalPositiveSafeInteger = (
  value: number | undefined,
  fieldName: string
): number | undefined =>
  value === undefined
    ? undefined
    : positiveSafeInteger(value, value, fieldName);

const withMcpTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    abortSignal?: AbortSignal;
    timeoutMs?: number;
    operation: string;
  }
): Promise<T> => {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(
    options.abortSignal?.reason ?? new Error(`MCP ${options.operation} was aborted.`)
  );
  if (options.abortSignal?.aborted) {
    abortFromCaller();
  } else {
    options.abortSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timer = options.timeoutMs
    ? setTimeout(
        () => controller.abort(new Error(`MCP ${options.operation} timed out after ${options.timeoutMs}ms.`)),
        options.timeoutMs
      )
    : undefined;
  let abortListener: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => {
        const reason = controller.signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : new Error(`MCP ${options.operation} was aborted.`)
        );
      };
      if (controller.signal.aborted) {
        abortListener();
      } else {
        controller.signal.addEventListener("abort", abortListener, { once: true });
      }
    });
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    if (abortListener) {
      controller.signal.removeEventListener("abort", abortListener);
    }
    options.abortSignal?.removeEventListener("abort", abortFromCaller);
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const normalizeListedTools = async (
  client: McpClient,
  options: McpToolSetOptions
): Promise<McpListedTool[]> => {
  const maxListPages = positiveSafeInteger(options.maxListPages, 100, "maxListPages");
  const maxListedTools = positiveSafeInteger(options.maxListedTools, 10_000, "maxListedTools");
  const tools: McpListedTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxListPages; page += 1) {
    const listed = await withMcpTimeout(
      (abortSignal) =>
        client.listTools(
          cursor === undefined ? undefined : { cursor },
          {
            abortSignal,
            timeoutMs: options.listToolsTimeoutMs
          }
        ),
      {
        abortSignal: options.abortSignal,
        timeoutMs: options.listToolsTimeoutMs,
        operation: "tools/list"
      }
    );
    if (Array.isArray(listed)) {
      tools.push(...listed);
      if (tools.length > maxListedTools) {
        throw new ValidationError(`MCP tools/list exceeded the ${maxListedTools}-tool limit.`);
      }
      return tools;
    }

    tools.push(...listed.tools);
    if (tools.length > maxListedTools) {
      throw new ValidationError(`MCP tools/list exceeded the ${maxListedTools}-tool limit.`);
    }
    if (listed.nextCursor === undefined) {
      return tools;
    }
    if (seenCursors.has(listed.nextCursor)) {
      throw new ValidationError(`MCP tools/list returned repeated cursor "${listed.nextCursor}".`);
    }
    seenCursors.add(listed.nextCursor);
    cursor = listed.nextCursor;
  }

  throw new ValidationError(`MCP tools/list exceeded the ${maxListPages}-page limit.`);
};

const getToolName = (name: string, prefix?: string) => (prefix ? `${prefix}${name}` : name);

const mcpToolSecurityMetadata = (
  annotations: McpToolAnnotations | undefined,
  trustServerToolAnnotations: boolean
) => {
  const declaredReadOnly = annotations?.readOnlyHint === true;
  const explicitlyReadOnly = trustServerToolAnnotations && declaredReadOnly;
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
      annotationsTrusted: trustServerToolAnnotations,
      permissions,
      audit: {
        riskLevel: destructive ? "high" : requiresApproval ? "medium" : "low",
        description: explicitlyReadOnly
          ? "Trusted MCP server annotations declare this tool read-only."
          : declaredReadOnly
            ? "MCP read-only annotation is untrusted; this tool requires approval."
            : "MCP tool requires approval because it is not explicitly trusted as read-only."
      }
    }
  };
};

export const createMcpToolSet = async (client: McpClient, options: McpToolSetOptions = {}): Promise<ToolSet> => {
  const normalizedOptions = {
    ...options,
    listToolsTimeoutMs: optionalPositiveSafeInteger(options.listToolsTimeoutMs, "listToolsTimeoutMs"),
    callToolTimeoutMs: optionalPositiveSafeInteger(options.callToolTimeoutMs, "callToolTimeoutMs")
  };
  const include = normalizedOptions.includeTools ? new Set(normalizedOptions.includeTools) : undefined;
  const exclude = normalizedOptions.excludeTools ? new Set(normalizedOptions.excludeTools) : undefined;
  const listedTools = await normalizeListedTools(client, normalizedOptions);
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
      const toolName = getToolName(listedTool.name, normalizedOptions.toolNamePrefix);
      const security = mcpToolSecurityMetadata(
        listedTool.annotations,
        normalizedOptions.trustServerToolAnnotations === true
      );
      let outputValidator: z.ZodTypeAny | undefined;
      if (listedTool.outputSchema !== undefined) {
        try {
          outputValidator = z.fromJSONSchema(listedTool.outputSchema as never);
        } catch (error) {
          throw new ValidationError(`Invalid MCP output schema for tool "${listedTool.name}".`, { cause: error });
        }
      }
      if (seenNames.has(toolName)) {
        throw new ValidationError(`Duplicate MCP tool name "${toolName}".`);
      }

      seenNames.add(toolName);

      return [
        toolName,
        tool({
          name: toolName,
          description: listedTool.description ?? listedTool.title ?? listedTool.annotations?.title,
          schema: jsonSchemaToZod(listedTool.inputSchema),
          metadata: serializeJsonValue({
            source: "mcp",
            originalName: listedTool.name,
            title: listedTool.title ?? listedTool.annotations?.title ?? null,
            inputSchema: listedTool.inputSchema ?? null,
            outputSchema: listedTool.outputSchema ?? null,
            annotations: listedTool.annotations ?? null,
            advancedRegistry: security.advancedRegistry
          }) as Record<string, JsonValue>,
          requiresApproval: security.requiresApproval,
          approvalMode: security.requiresApproval
            ? normalizedOptions.approvalMode ?? "interrupt"
            : "policy",
          execute: async (input, context) => {
            const response = await withMcpTimeout(
              (abortSignal) =>
                client.callTool(
                  {
                    name: listedTool.name,
                    arguments: input as JsonValue
                  },
                  {
                    abortSignal,
                    timeoutMs: normalizedOptions.callToolTimeoutMs,
                    idempotencyKey: context?.idempotencyKey
                  }
                ),
              {
                abortSignal: context?.abortSignal ?? normalizedOptions.abortSignal,
                timeoutMs: normalizedOptions.callToolTimeoutMs,
                operation: `tools/call "${listedTool.name}"`
              }
            );
            if (isRecord(response) && response.isError === true) {
              throw new Error(mcpErrorMessage(listedTool.name, response));
            }
            if (outputValidator && isRecord(response) && response.isError !== true) {
              if (response.structuredContent === undefined) {
                throw new ValidationError(
                  `MCP tool "${listedTool.name}" declared outputSchema but returned no structuredContent.`
                );
              }
              const parsed = outputValidator.safeParse(response.structuredContent);
              if (!parsed.success) {
                throw new ValidationError(
                  `MCP structured output validation failed for tool "${listedTool.name}": ${parsed.error.issues
                    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.code}`)
                    .join(", ")}`
                );
              }
            } else if (outputValidator && !isRecord(response)) {
              throw new ValidationError(
                `MCP tool "${listedTool.name}" declared outputSchema but returned no structuredContent.`
              );
            }
            return serializeJsonValue(response);
          }
        })
      ];
    })
  );
};

export const createMcpToolRegistry = async (
  client: McpClient,
  options: McpToolSetOptions = {}
): Promise<ToolRegistry> => createToolRegistry(await createMcpToolSet(client, options));
