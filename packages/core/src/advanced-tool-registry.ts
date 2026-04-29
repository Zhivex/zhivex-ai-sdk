import { z } from "zod";

import { ValidationError } from "./errors.js";
import { isHostedToolDefinition, serializeJsonValue, tool } from "./messages.js";
import { isToolRegistry, toToolSet } from "./tool-registry.js";
import type { AnyToolDefinition, JsonValue, ToolCollection, ToolDefinition, ToolRegistryLike, ToolSet } from "./types.js";

export type AdvancedToolSource = "local" | "mcp" | "hosted" | "http" | "custom";

export type ToolPermission =
  | "read"
  | "write"
  | "network"
  | "filesystem"
  | "code-execution"
  | "shell"
  | "external-side-effect";

export interface ToolAuditMetadata {
  displayName?: string;
  riskLevel?: "low" | "medium" | "high" | "critical";
  owner?: string;
  labels?: string[];
  description?: string;
}

export interface AdvancedToolRegistryEntry<TTool extends AnyToolDefinition = AnyToolDefinition> {
  tool: TTool;
  source?: AdvancedToolSource;
  permissions?: ToolPermission[];
  audit?: ToolAuditMetadata;
  metadata?: Record<string, JsonValue>;
}

export interface HttpToolOptions<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description?: string;
  schema: TSchema;
  url: string | URL;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  timeoutMs?: number;
  mapResponse?: (response: Response, input: z.infer<TSchema>) => Promise<JsonValue> | JsonValue;
  metadata?: Record<string, JsonValue>;
}

export interface ToolTestResult {
  ok: boolean;
  toolName: string;
  output?: JsonValue;
  error?: {
    message: string;
  };
}

export interface ToolRegistryTestCase {
  toolName: string;
  input: unknown;
}

export type ToolPermissionPreset =
  | "read-only"
  | "network-read"
  | "filesystem-write"
  | "code-execution"
  | "external-side-effect"
  | "admin";

export interface ToolFixtureCase {
  name?: string;
  toolName: string;
  input: JsonValue;
  expectedOutput?: JsonValue;
  expectedErrorContains?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ToolTestFixture {
  name?: string;
  cases: ToolFixtureCase[];
  metadata?: Record<string, JsonValue>;
  createdAt?: number;
}

export interface ToolFixtureCaseResult extends ToolTestResult {
  name?: string;
  input: JsonValue;
  expectedOutput?: JsonValue;
  expectedErrorContains?: string;
  failures: string[];
  metadata?: Record<string, JsonValue>;
}

export interface ToolFixtureResult {
  ok: boolean;
  cases: ToolFixtureCaseResult[];
}

export interface ToolRegistryInspectionTool {
  name: string;
  kind: "callable" | "hosted";
  source: AdvancedToolSource;
  permissions: ToolPermission[];
  audit?: ToolAuditMetadata;
  requiresApproval: boolean;
  metadata?: Record<string, JsonValue>;
}

export interface ToolRegistryInspection {
  tools: ToolRegistryInspectionTool[];
}

const sensitivePermissions = new Set<ToolPermission>([
  "write",
  "filesystem",
  "code-execution",
  "shell",
  "external-side-effect"
]);

const riskRequiresApproval = (riskLevel: ToolAuditMetadata["riskLevel"] | undefined) =>
  riskLevel === "high" || riskLevel === "critical";

const permissionsRequireApproval = (permissions: readonly ToolPermission[] | undefined) =>
  permissions?.some((permission) => sensitivePermissions.has(permission)) ?? false;

const cloneTool = <TTool extends AnyToolDefinition>(definition: TTool): TTool => ({
  ...definition,
  metadata: definition.metadata ? { ...definition.metadata } : undefined
});

const isCallableTool = (definition: AnyToolDefinition): definition is ToolDefinition => "execute" in definition;

const jsonEqual = (left: unknown, right: unknown): boolean =>
  JSON.stringify(serializeJsonValue(left)) === JSON.stringify(serializeJsonValue(right));

const normalizeEntry = <TTool extends AnyToolDefinition>(
  value: TTool | AdvancedToolRegistryEntry<TTool>,
  defaults?: Omit<AdvancedToolRegistryEntry<TTool>, "tool">
): AdvancedToolRegistryEntry<TTool> =>
  "tool" in value
    ? {
        ...defaults,
        ...value,
        permissions: value.permissions ?? defaults?.permissions,
        audit: value.audit ?? defaults?.audit,
        metadata: value.metadata ?? defaults?.metadata
      }
    : {
        ...defaults,
        tool: value
      };

const materializeEntry = (entry: AdvancedToolRegistryEntry): AnyToolDefinition => {
  const definition = cloneTool(entry.tool);
  const metadata = serializeJsonValue({
    ...(definition.metadata ?? {}),
    ...(entry.metadata ?? {}),
    advancedRegistry: {
      source: entry.source ?? "custom",
      permissions: entry.permissions ?? [],
      audit: entry.audit ?? null
    }
  }) as Record<string, JsonValue>;

  return {
    ...definition,
    metadata,
    requiresApproval:
      definition.requiresApproval ??
      (permissionsRequireApproval(entry.permissions) || riskRequiresApproval(entry.audit?.riskLevel))
  };
};

const jsonResponse = async (response: Response): Promise<JsonValue> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return serializeJsonValue(await response.json());
  }

  return serializeJsonValue(await response.text());
};

const appendSearchParams = (url: URL, input: JsonValue) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    url.searchParams.set("input", JSON.stringify(input));
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
};

const withTimeoutSignal = (timeoutMs: number | undefined) => {
  if (!timeoutMs) {
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer)
  };
};

export class AdvancedToolRegistry implements ToolRegistryLike {
  private readonly entriesByName = new Map<string, AdvancedToolRegistryEntry>();

  constructor(initial?: ToolCollection | Iterable<AnyToolDefinition | AdvancedToolRegistryEntry>) {
    if (!initial) {
      return;
    }

    if (isToolRegistry(initial)) {
      this.registerMany(initial.toToolSet());
      return;
    }

    if (Symbol.iterator in Object(initial)) {
      for (const entry of initial as Iterable<AnyToolDefinition | AdvancedToolRegistryEntry>) {
        this.register(entry);
      }
      return;
    }

    this.registerMany(initial as ToolSet);
  }

  register<TTool extends AnyToolDefinition>(
    value: TTool | AdvancedToolRegistryEntry<TTool>,
    defaults?: Omit<AdvancedToolRegistryEntry<TTool>, "tool">
  ): AdvancedToolRegistryEntry<TTool> {
    const entry = normalizeEntry(value, defaults);
    const existing = this.entriesByName.get(entry.tool.name);
    if (existing && existing.tool !== entry.tool) {
      throw new ValidationError(`Tool "${entry.tool.name}" is already registered.`);
    }

    this.entriesByName.set(entry.tool.name, entry as AdvancedToolRegistryEntry);
    return entry;
  }

  registerMany(input: ToolCollection | undefined, defaults?: Omit<AdvancedToolRegistryEntry, "tool">): this {
    const toolSet = toToolSet(input);
    if (!toolSet) {
      return this;
    }

    for (const definition of Object.values(toolSet)) {
      this.register(definition, defaults);
    }

    return this;
  }

  merge(...inputs: Array<ToolCollection | AdvancedToolRegistry | undefined>): AdvancedToolRegistry {
    const merged = new AdvancedToolRegistry(this.advancedEntries());
    for (const input of inputs) {
      if (!input) {
        continue;
      }
      if (input instanceof AdvancedToolRegistry) {
        for (const entry of input.advancedEntries()) {
          merged.register(entry);
        }
      } else {
        merged.registerMany(input);
      }
    }
    return merged;
  }

  get(name: string): AnyToolDefinition | undefined {
    const entry = this.entriesByName.get(name);
    return entry ? materializeEntry(entry) : undefined;
  }

  getEntry(name: string): AdvancedToolRegistryEntry | undefined {
    return this.entriesByName.get(name);
  }

  has(name: string): boolean {
    return this.entriesByName.has(name);
  }

  entries(): Iterable<[string, AnyToolDefinition]> {
    return Object.entries(this.toToolSet());
  }

  advancedEntries(): Iterable<AdvancedToolRegistryEntry> {
    return this.entriesByName.values();
  }

  toToolSet(): ToolSet {
    return Object.fromEntries(
      [...this.entriesByName.entries()].map(([name, entry]) => [name, materializeEntry(entry)])
    );
  }
}

export const createAdvancedToolRegistry = (
  initial?: ToolCollection | Iterable<AnyToolDefinition | AdvancedToolRegistryEntry>
): AdvancedToolRegistry => new AdvancedToolRegistry(initial);

export const createHttpTool = <TSchema extends z.ZodTypeAny>(
  options: HttpToolOptions<TSchema>
): AdvancedToolRegistryEntry<ToolDefinition<TSchema, JsonValue>> => {
  const method = options.method ?? "POST";
  const definition = tool({
    name: options.name,
    description: options.description,
    schema: options.schema,
    metadata: serializeJsonValue({
      ...(options.metadata ?? {}),
      source: "http",
      url: String(options.url),
      method
    }) as Record<string, JsonValue>,
    execute: async (input) => {
      const serializedInput = serializeJsonValue(input);
      const url = new URL(String(options.url));
      const timeout = withTimeoutSignal(options.timeoutMs);
      const init: RequestInit = {
        method,
        headers: {
          accept: "application/json, text/plain;q=0.9, */*;q=0.8",
          ...options.headers
        },
        signal: timeout?.signal
      };

      if (method === "GET") {
        appendSearchParams(url, serializedInput);
      } else {
        init.headers = {
          "content-type": "application/json",
          ...init.headers
        };
        init.body = JSON.stringify(serializedInput);
      }

      try {
        const response = await fetch(url, init);
        if (!response.ok) {
          throw new Error(`HTTP tool "${options.name}" failed with status ${response.status}.`);
        }

        return serializeJsonValue(
          options.mapResponse ? await options.mapResponse(response, input as z.infer<TSchema>) : await jsonResponse(response)
        );
      } finally {
        timeout?.clear();
      }
    }
  });

  return {
    tool: definition,
    source: "http",
    permissions: ["network", "external-side-effect"],
    audit: {
      displayName: options.name,
      riskLevel: "medium",
      description: options.description
    }
  };
};

export const testToolDefinition = async (
  definition: AnyToolDefinition,
  input: unknown
): Promise<ToolTestResult> => {
  if (!isCallableTool(definition)) {
    return {
      ok: false,
      toolName: definition.name,
      error: {
        message: `Tool "${definition.name}" is hosted and cannot be executed locally.`
      }
    };
  }

  const parsed = definition.schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      toolName: definition.name,
      error: {
        message: `Invalid input for tool "${definition.name}": ${parsed.error.message}`
      }
    };
  }

  try {
    return {
      ok: true,
      toolName: definition.name,
      output: serializeJsonValue(await definition.execute(parsed.data))
    };
  } catch (error) {
    return {
      ok: false,
      toolName: definition.name,
      error: {
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
};

export const testToolRegistry = async (
  registry: ToolCollection,
  cases: ToolRegistryTestCase[]
): Promise<ToolTestResult[]> => {
  const toolSet = toToolSet(registry) ?? {};
  const results: ToolTestResult[] = [];

  for (const testCase of cases) {
    const definition = toolSet[testCase.toolName];
    if (!definition) {
      results.push({
        ok: false,
        toolName: testCase.toolName,
        error: {
          message: `Tool "${testCase.toolName}" is not registered.`
        }
      });
      continue;
    }

    results.push(await testToolDefinition(definition, testCase.input));
  }

  return results;
};

export const createToolPermissionPreset = (
  preset: ToolPermissionPreset
): Omit<AdvancedToolRegistryEntry, "tool"> => {
  switch (preset) {
    case "read-only":
      return {
        permissions: ["read"],
        audit: { riskLevel: "low", labels: ["read-only"] }
      };
    case "network-read":
      return {
        permissions: ["read", "network"],
        audit: { riskLevel: "medium", labels: ["network"] }
      };
    case "filesystem-write":
      return {
        permissions: ["read", "write", "filesystem"],
        audit: { riskLevel: "high", labels: ["filesystem"] }
      };
    case "code-execution":
      return {
        permissions: ["code-execution"],
        audit: { riskLevel: "critical", labels: ["code-execution"] }
      };
    case "external-side-effect":
      return {
        permissions: ["network", "external-side-effect"],
        audit: { riskLevel: "high", labels: ["external-side-effect"] }
      };
    case "admin":
      return {
        permissions: ["read", "write", "network", "filesystem", "code-execution", "shell", "external-side-effect"],
        audit: { riskLevel: "critical", labels: ["admin"] }
      };
  }
};

export const createToolTestFixture = (options: {
  name?: string;
  cases: ToolFixtureCase[];
  metadata?: Record<string, JsonValue>;
  createdAt?: number;
}): ToolTestFixture => ({
  name: options.name,
  cases: options.cases.map((testCase) => ({
    ...testCase,
    input: serializeJsonValue(testCase.input),
    expectedOutput: testCase.expectedOutput === undefined ? undefined : serializeJsonValue(testCase.expectedOutput)
  })),
  metadata: options.metadata,
  createdAt: options.createdAt ?? Date.now()
});

export const recordToolTestFixture = async (
  registry: ToolCollection,
  cases: Array<ToolRegistryTestCase | ToolFixtureCase>,
  options: { name?: string; metadata?: Record<string, JsonValue>; createdAt?: number } = {}
): Promise<ToolTestFixture> => {
  const results = await testToolRegistry(registry, cases);
  return createToolTestFixture({
    name: options.name,
    metadata: options.metadata,
    createdAt: options.createdAt,
    cases: cases.map((testCase, index) => {
      const result = results[index];
      return {
        name: "name" in testCase ? testCase.name : undefined,
        toolName: testCase.toolName,
        input: serializeJsonValue(testCase.input),
        expectedOutput: result?.ok ? result.output : undefined,
        expectedErrorContains: result?.ok ? undefined : result?.error?.message,
        metadata: "metadata" in testCase ? testCase.metadata : undefined
      };
    })
  });
};

export const runToolTestFixture = async (
  registry: ToolCollection,
  fixture: ToolTestFixture
): Promise<ToolFixtureResult> => {
  const results = await testToolRegistry(registry, fixture.cases);
  const cases = fixture.cases.map((testCase, index): ToolFixtureCaseResult => {
    const result = results[index] ?? {
      ok: false,
      toolName: testCase.toolName,
      error: { message: `Tool "${testCase.toolName}" did not return a result.` }
    };
    const failures: string[] = [];

    if (testCase.expectedOutput !== undefined && !jsonEqual(result.output, testCase.expectedOutput)) {
      failures.push(`Expected output for tool "${testCase.toolName}" did not match fixture.`);
    }
    if (
      testCase.expectedErrorContains !== undefined &&
      !result.error?.message.includes(testCase.expectedErrorContains)
    ) {
      failures.push(`Expected error for tool "${testCase.toolName}" to contain "${testCase.expectedErrorContains}".`);
    }
    if (testCase.expectedOutput !== undefined && !result.ok) {
      failures.push(`Expected tool "${testCase.toolName}" to succeed.`);
    }
    const expectedFailure = testCase.expectedErrorContains !== undefined;

    return {
      ...result,
      name: testCase.name,
      input: testCase.input,
      expectedOutput: testCase.expectedOutput,
      expectedErrorContains: testCase.expectedErrorContains,
      failures,
      ok: failures.length === 0 && (expectedFailure ? !result.ok : result.ok),
      metadata: testCase.metadata
    };
  });

  return {
    ok: cases.every((testCase) => testCase.ok),
    cases
  };
};

const metadataAdvancedRegistry = (definition: AnyToolDefinition) => {
  const metadata = definition.metadata?.advancedRegistry;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, JsonValue>
    : undefined;
};

const inspectDefinition = (
  definition: AnyToolDefinition,
  entry?: AdvancedToolRegistryEntry
): ToolRegistryInspectionTool => {
  const materialized = entry ? materializeEntry(entry) : definition;
  const advanced = metadataAdvancedRegistry(materialized);
  const audit = entry?.audit ?? (advanced?.audit && typeof advanced.audit === "object" && !Array.isArray(advanced.audit)
    ? advanced.audit as unknown as ToolAuditMetadata
    : undefined);
  const permissions = entry?.permissions ?? (Array.isArray(advanced?.permissions)
    ? advanced.permissions.filter((permission): permission is ToolPermission => typeof permission === "string" && [
        "read",
        "write",
        "network",
        "filesystem",
        "code-execution",
        "shell",
        "external-side-effect"
      ].includes(permission))
    : []);

  return {
    name: materialized.name,
    kind: isHostedToolDefinition(materialized) ? "hosted" : "callable",
    source: entry?.source ?? (typeof advanced?.source === "string" ? advanced.source as AdvancedToolSource : "custom"),
    permissions,
    audit,
    requiresApproval: materialized.requiresApproval ?? false,
    metadata: materialized.metadata
  };
};

export const inspectToolRegistry = (registry: ToolCollection): ToolRegistryInspection => {
  if (registry instanceof AdvancedToolRegistry) {
    return {
      tools: [...registry.advancedEntries()].map((entry) => inspectDefinition(entry.tool, entry))
    };
  }

  const toolSet = toToolSet(registry) ?? {};
  return {
    tools: Object.values(toolSet).map((definition) => inspectDefinition(definition))
  };
};
