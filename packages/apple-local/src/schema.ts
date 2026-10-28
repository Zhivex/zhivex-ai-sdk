import { UnsupportedFeatureError } from "@zhivex-ai/core/provider";

/**
 * Subset of JSON Schema that maps onto Apple's `DynamicGenerationSchema` and
 * `GenerationGuide`. Unsupported keywords fail here so constraints are not dropped.
 *
 * @see https://developer.apple.com/documentation/foundationmodels/dynamicgenerationschema
 * @see https://developer.apple.com/documentation/foundationmodels/generationguide
 */
export interface AppleSchemaNode {
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: AppleSchemaNode;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, AppleSchemaNode>;
  required?: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (path: string, detail: string): never => {
  throw new UnsupportedFeatureError(
    `Apple guided generation cannot represent the JSON Schema at ${path}: ${detail} DynamicGenerationSchema and GenerationGuide do not document this keyword.`
  );
};

const assertOnly = (schema: Record<string, unknown>, allowed: readonly string[], path: string) => {
  for (const key of Object.keys(schema)) {
    if (!allowed.includes(key)) fail(path, `unsupported keyword "${key}".`);
  }
};

const numberValue = (value: unknown, path: string, label: string): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fail(path, `${label} must be a finite number.`);
};

const integerValue = (value: unknown, path: string, label: string): number => {
  const parsed = numberValue(value, path, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(path, `${label} must be a non-negative integer.`);
  return parsed;
};

const unwrapNullable = (
  schema: Record<string, unknown>,
  path: string
): { schema: Record<string, unknown>; optional: boolean } => {
  if (!Array.isArray(schema.anyOf)) return { schema, optional: false };
  const branches = schema.anyOf.filter(isRecord);
  if (branches.length !== schema.anyOf.length || branches.length !== 2) {
    fail(path, "anyOf is only accepted as a value-or-null union.");
  }
  const nullBranch = branches.find((branch) => branch.type === "null" && Object.keys(branch).every((key) => key === "type" || key === "description"));
  const valueBranch = branches.find((branch) => branch !== nullBranch);
  if (!nullBranch || !valueBranch) return fail(path, "anyOf is only accepted as a value-or-null union.");
  assertOnly(schema, ["anyOf", "description"], path);
  return {
    schema: {
      ...valueBranch,
      ...(typeof schema.description === "string" && valueBranch.description === undefined
        ? { description: schema.description }
        : {})
    },
    optional: true
  };
};

export const convertJsonSchema = (input: unknown, path = "schema"): AppleSchemaNode => {
  if (!isRecord(input)) return fail(path, "schema must be an object.");
  const unwrapped = unwrapNullable(input, path);
  if (unwrapped.optional) return fail(path, "a nullable schema is only valid as an object property.");
  const schema = unwrapped.schema;
  if (schema.type === "object" || (schema.properties !== undefined && schema.type === undefined)) {
    assertOnly(schema, ["type", "description", "properties", "required", "additionalProperties", "$schema", "title"], path);
    if (schema.title !== undefined) return fail(path, "title is not a GenerationGuide. Move that text into description.");
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
      return fail(path, "additionalProperties other than false is not a documented guided-generation control.");
    }
    const propertyMap = schema.properties;
    if (!isRecord(propertyMap)) return fail(path, "object schemas require a properties object.");
    const required = new Set<string>();
    const requiredInput = schema.required;
    if (requiredInput !== undefined) {
      if (!Array.isArray(requiredInput)) return fail(path, "required must be an array.");
      for (const name of requiredInput) {
        if (typeof name !== "string" || name.length === 0) return fail(path, "required entries must be non-empty strings.");
        required.add(name);
      }
    }
    const properties: Record<string, AppleSchemaNode> = {};
    const requiredNames: string[] = [];
    for (const [name, property] of Object.entries(propertyMap)) {
      if (!isRecord(property)) return fail(`${path}/properties/${name}`, "property schema must be an object.");
      const propertyNullable = unwrapNullable(property, `${path}/properties/${name}`);
      properties[name] = convertJsonSchema(propertyNullable.schema, `${path}/properties/${name}`);
      if (required.has(name) && !propertyNullable.optional) requiredNames.push(name);
    }
    for (const name of required) {
      if (!(name in properties)) return fail(path, `required property "${name}" is not in properties.`);
    }
    return {
      type: "object",
      ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      properties,
      required: requiredNames
    };
  }

  if (schema.type === "array") {
    assertOnly(schema, ["type", "description", "items", "minItems", "maxItems"], path);
    const minItems = schema.minItems === undefined ? undefined : integerValue(schema.minItems, path, "minItems");
    const maxItems = schema.maxItems === undefined ? undefined : integerValue(schema.maxItems, path, "maxItems");
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
      return fail(path, "minItems is greater than maxItems.");
    }
    return {
      type: "array",
      ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      items: convertJsonSchema(schema.items, `${path}/items`),
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined ? { maxItems } : {})
    };
  }

  if (schema.type === "string" || (schema.enum !== undefined && schema.type === undefined)) {
    assertOnly(schema, ["type", "description", "enum", "pattern", "const"], path);
    if (schema.const !== undefined) return fail(path, "const is not sent. Use enum, which maps to GenerationGuide.anyOf.");
    let enumValues: string[] | undefined;
    const enumInput = schema.enum;
    if (enumInput !== undefined) {
      if (!Array.isArray(enumInput) || enumInput.length === 0 || enumInput.some((item) => typeof item !== "string")) {
        return fail(path, "enum is only accepted as a non-empty list of strings, matching GenerationGuide.anyOf.");
      }
      enumValues = enumInput as string[];
    }
    if (schema.pattern !== undefined && (typeof schema.pattern !== "string" || schema.pattern.length === 0)) {
      return fail(path, "pattern must be a non-empty string.");
    }
    return {
      type: "string",
      ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      ...(enumValues ? { enum: enumValues } : {}),
      ...(typeof schema.pattern === "string" ? { pattern: schema.pattern } : {})
    };
  }

  if (schema.type === "integer" || schema.type === "number") {
    assertOnly(schema, ["type", "description", "minimum", "maximum"], path);
    const minimum = schema.minimum === undefined ? undefined : numberValue(schema.minimum, path, "minimum");
    const maximum = schema.maximum === undefined ? undefined : numberValue(schema.maximum, path, "maximum");
    if (schema.type === "integer") {
      if (minimum !== undefined && !Number.isSafeInteger(minimum)) return fail(path, "integer minimum must be an integer.");
      if (maximum !== undefined && !Number.isSafeInteger(maximum)) return fail(path, "integer maximum must be an integer.");
    }
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      return fail(path, "minimum is greater than maximum.");
    }
    return {
      type: schema.type,
      ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {})
    };
  }

  if (schema.type === "boolean") {
    assertOnly(schema, ["type", "description"], path);
    return {
      type: "boolean",
      ...(typeof schema.description === "string" ? { description: schema.description } : {})
    };
  }

  return fail(path, `type "${String(schema.type)}" is not a documented Generable primitive.`);
};

export const assertObjectSchema = (schema: AppleSchemaNode, path: string): void => {
  if (schema.type !== "object") {
    throw new UnsupportedFeatureError(
      `Apple tool parameters must be an object GenerationSchema (${path} is ${schema.type}).`
    );
  }
};
