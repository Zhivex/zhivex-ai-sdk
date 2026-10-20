import { toJSONSchema } from "zod";
import type { ZodTypeAny } from "zod";

const JSON_SCHEMA = Symbol.for("@zhivex-ai/core/json-schema");

export interface JsonSchemaIssue {
  code: string;
  path: Array<string | number>;
}

export interface JsonSchemaSuccess<T> {
  success: true;
  data: T;
}

export interface JsonSchemaFailure {
  success: false;
  error: { message: string; issues: JsonSchemaIssue[] };
}

/** Runtime JSON Schema document accepted by `jsonSchema()` and dynamic tools. */
export interface JsonSchemaType<T = unknown> {
  readonly [JSON_SCHEMA]: true;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  safeParse(data: unknown): JsonSchemaSuccess<T> | JsonSchemaFailure;
}

export const isJsonSchema = (value: unknown): value is JsonSchemaType =>
  typeof value === "object" && value !== null && (value as { [JSON_SCHEMA]?: unknown })[JSON_SCHEMA] === true;

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const matchesType = (value: unknown, type: string): boolean => {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === type;
};

const validateNode = (
  value: unknown,
  schema: Record<string, unknown>,
  path: Array<string | number>,
  issues: JsonSchemaIssue[]
): void => {
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push({ code: "invalid_enum", path: [...path] });
  }
  const declared = schema.type;
  const types = Array.isArray(declared) ? declared.filter((item): item is string => typeof item === "string") : typeof declared === "string" ? [declared] : [];
  if (types.length && !types.some((type) => matchesType(value, type))) {
    issues.push({ code: "invalid_type", path: [...path] });
    return;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) issues.push({ code: "too_small", path: [...path] });
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) issues.push({ code: "too_big", path: [...path] });
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) issues.push({ code: "too_small", path: [...path] });
    if (typeof schema.maximum === "number" && value > schema.maximum) issues.push({ code: "too_big", path: [...path] });
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    value.forEach((item, index) => validateNode(item, schema.items as Record<string, unknown>, [...path, index], issues));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, unknown> : undefined;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) issues.push({ code: "invalid_type", path: [...path, key] });
    }
    if (properties) {
      for (const [key, property] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(record, key) && property && typeof property === "object") {
          validateNode(record[key], property as Record<string, unknown>, [...path, key], issues);
        }
      }
    }
    if (schema.additionalProperties === false && properties) {
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) issues.push({ code: "unrecognized_keys", path: [...path, key] });
      }
    }
  }
};

/**
 * Wrap a raw JSON Schema so tools can validate arguments without a Zod schema.
 * The validator covers the object subset used by tool inputs: type, enum,
 * properties, required, additionalProperties, items, and numeric/string bounds.
 */
export const jsonSchema = <T = unknown>(schema: Record<string, unknown>): JsonSchemaType<T> => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("jsonSchema requires a JSON Schema object.");
  }
  const frozen = Object.freeze({ ...schema });
  return {
    [JSON_SCHEMA]: true,
    jsonSchema: frozen,
    safeParse(data: unknown) {
      const issues: JsonSchemaIssue[] = [];
      validateNode(data, frozen, [], issues);
      if (issues.length) {
        return { success: false, error: { message: "JSON Schema validation failed.", issues } };
      }
      return { success: true, data: data as T };
    }
  };
};

/** JSON Schema for a tool input, whether the caller used Zod or `jsonSchema()`. */
export const toolInputJsonSchema = (schema: ZodTypeAny | JsonSchemaType): Record<string, unknown> =>
  isJsonSchema(schema) ? { ...schema.jsonSchema } : toJSONSchema(schema) as Record<string, unknown>;
