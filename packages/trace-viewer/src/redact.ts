/** Replacement used for secret values and for text that matches a redaction rule. */
export const REDACTED = "[REDACTED]";

/** Display cap for tool arguments, tool results, and other free-form payloads. */
export const DISPLAY_LIMIT = 500;

const MAX_DEPTH = 20;
const MAX_ARRAY_LENGTH = 200;
const MAX_OBJECT_KEYS = 200;
const MAX_STRING_LENGTH = 100_000;

/**
 * Same sensitive-field rule the SDK uses when it refuses to hash cache keys,
 * plus a camelCase boundary so `apiKey` and `approvalToken` match too.
 */
const SENSITIVE_KEY = /(?:^|[-_])(?:api[-_]?key|authorization|cookie|credential|password|secret|token)(?:$|[-_])/iu;

const TEXT_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: REDACTED },
  { pattern: /\bBasic\s+[A-Za-z0-9+/=-]+/gi, replacement: REDACTED },
  {
    pattern: /\b(?:api[_-]?key|apikey|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi,
    replacement: REDACTED
  },
  {
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: REDACTED
  }
];

const normalizeKey = (key: string): string => key
  .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
  .toLowerCase();

/** True when a JSON key is an API key, authorization header, or other SDK-sensitive name. */
export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(normalizeKey(key));

/** Apply the SDK text rules (bearer, basic, api-key assignments, and emails). */
export const redactText = (text: string): string => {
  const bounded = text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}...` : text;
  return TEXT_RULES.reduce((current, rule) => {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    return current.replace(pattern, rule.replacement);
  }, bounded);
};

/** Deep-copy JSON and replace secrets. Non-JSON values become null. */
export const redactTraceValue = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => redactTraceValue(item, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) items.push("[truncated]");
    return items;
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const keys = Object.keys(source).filter((key) => key !== "__proto__" && key !== "constructor" && key !== "prototype");
    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
      output[key] = isSensitiveKey(key) ? REDACTED : redactTraceValue(source[key], depth + 1);
    }
    if (keys.length > MAX_OBJECT_KEYS) output["[truncated]"] = true;
    return output;
  }
  return null;
};

/** Serialize a value and cap it for the local page. Redact before calling this. */
export const truncateForDisplay = (value: unknown, limit = DISPLAY_LIMIT): string => {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "";
    }
  }
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
};
